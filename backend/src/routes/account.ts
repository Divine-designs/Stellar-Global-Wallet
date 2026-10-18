import { Router } from "express";
import { param, query } from "express-validator";
import { z } from "zod";
import { assertValidRequest } from "../middleware/requestValidation";
import { StellarService } from "../services/stellar";
import { getUnifiedActivityFeed } from "../services/activityFeed";
import { isGAddress, publicKeyMessage } from "../utils/stellarAddress";
import { AppError } from "../errors/appError";
import { getDb } from "../db";
import { jwtAuth } from "../middleware/jwtAuth";
import { MAX_EXPORT_RANGE_MS, streamTransactionCsv } from "../services/transactionExport";

// #24 — shared cursor pagination contract. `cursor` is an opaque paging token
// (e.g. a Horizon cursor) that is passed through untouched; `limit` is capped
// at MAX_PAGE_LIMIT. Lists respond with `items` + `nextCursor`.
export const MAX_PAGE_LIMIT = 100;
export const DEFAULT_PAGE_LIMIT = 20;

export interface PageQuery {
  cursor?: string;
  limit?: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Build a `Page<T>` from a list of items and the opaque next-page token.
 * The cursor is never parsed — it is forwarded verbatim to the caller.
 */
export function paginate<T>(items: T[], nextCursor: string | null | undefined): Page<T> {
  return {
    items,
    nextCursor: nextCursor ?? null,
  };
}

/**
 * Validate and normalise a `PageQuery` from raw request query params.
 * Throws a 400 `VALIDATION_ERROR` when `limit` exceeds MAX_PAGE_LIMIT.
 */
export function parsePageQuery(raw: { cursor?: unknown; limit?: unknown }): PageQuery {
  const limit = raw.limit === undefined ? undefined : Number(raw.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT)) {
    throw new AppError("limit must be an integer between 1 and 100", {
      code: "VALIDATION_ERROR",
      status: 400,
    });
  }
  const cursor = typeof raw.cursor === "string" && raw.cursor.length > 0 ? raw.cursor : undefined;
  return { cursor, limit };
}

// #68 — user preferences schema. Only these keys are allowed; unknown keys
// are rejected so the stored JSONB stays predictable across web and mobile.
const preferencesSchema = z
  .object({
    currency: z.string().min(1).max(16).optional(),
    language: z.string().min(2).max(16).optional(),
    hiddenAssets: z.array(z.string().min(1).max(128)).max(500).optional(),
    notifications: z
      .object({
        email: z.boolean().optional(),
        push: z.boolean().optional(),
        payments: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type Preferences = z.infer<typeof preferencesSchema>;

function parsePreferences(input: unknown): Preferences {
  const result = preferencesSchema.safeParse(input);
  if (!result.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      400,
      "Invalid preferences payload",
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }))
    );
  }
  return result.data;
}

export function createAccountRouter(stellar: StellarService): Router {
  const accountRouter = Router();

  accountRouter.get(
    "/:publicKey",
    param("publicKey").custom(isGAddress).withMessage(publicKeyMessage),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const account = await stellar.getAccount(req.params.publicKey);
        res.json(account);
      } catch (err) {
        next(err);
      }
    }
  );

  accountRouter.get(
    "/:publicKey/balances",
    param("publicKey").custom(isGAddress).withMessage(publicKeyMessage),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const balances = await stellar.getBalances(req.params.publicKey);
        res.json({ balances });
      } catch (err) {
        next(err);
      }
    }
  );

  // #72 — multisig signers, weights, thresholds and per-level reachability
  // in a UI-ready shape for the multisig screen.
  accountRouter.get(
    "/:publicKey/signers",
    param("publicKey").custom(isGAddress).withMessage(publicKeyMessage),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const account = await stellar.getAccount(req.params.publicKey);
        res.json(computeMultisigInfo(account));
      } catch (err) {
        next(err);
      }
    }
  );

  // #70 — reserve breakdown so clients can show spendable vs reserved.
  accountRouter.get(
    "/:publicKey/reserves",
    param("publicKey").custom(isGAddress).withMessage(publicKeyMessage),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const account = await stellar.getAccount(req.params.publicKey);
        const reserves = computeReserveBreakdown(account);
        const balances = Array.isArray(account?.balances)
          ? account.balances.map((b: any) => {
              const available = toNumber(b?.balance);
              const sellingLiabilities = toNumber(b?.selling_liabilities);
              return {
                ...b,
                spendable: Math.max(available - sellingLiabilities, 0).toString(),
              };
            })
          : [];
        res.json({ reserves, balances });
      } catch (err) {
        next(err);
      }
    }
  );

  // #71 — generate a muxed (M...) address for a base account and id so
  // exchanges/custodial services can tag deposits.
  accountRouter.post(
    "/:publicKey/muxed",
    param("publicKey").custom(isGAddress).withMessage(publicKeyMessage),
    body("id")
      .exists({ checkFalsy: false })
      .withMessage("id is required")
      .custom((value) => {
        const str = typeof value === "number" ? String(value) : value;
        if (typeof str !== "string" || !/^\d+$/.test(str)) {
          throw new Error("id must be a non-negative integer string");
        }
        if (BigInt(str) > BigInt("18446744073709551615")) {
          throw new Error("id must fit in an unsigned 64-bit integer");
        }
        return true;
      }),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const id = String(req.body.id);
        const muxed = new MuxedAccount(
          MuxedAccount.fromAddress(req.params.publicKey, id).baseAccount(),
          id
        );
        res.json({
          address: muxed.accountId(),
          baseAccount: req.params.publicKey,
          id,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  accountRouter.get(
    "/:publicKey/transactions",
    param("publicKey").custom(isGAddress).withMessage(publicKeyMessage),
    query("limit")
      .optional()
      .isInt({ min: 1, max: MAX_PAGE_LIMIT })
      .withMessage("limit must be an integer between 1 and 100")
      .toInt(),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const { limit, cursor } = parsePageQuery({
          cursor: req.query.cursor,
          limit: req.query.limit,
        });
        const result = await stellar.getTransactions(req.params.publicKey, {
          limit: limit ?? DEFAULT_PAGE_LIMIT,
          cursor,
        });
        const page = paginate(result.transactions.map(withDecodedMuxed), result.next);
        res.json({
          ...page,
          // @deprecated — use `items` + `nextCursor`. Kept for one version.
          transactions: page.items,
          next: result.next,
          hasMore: result.hasMore,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // #62 — CSV statement export (tax/accounting). Streams rows page by page;
  // `from`/`to` are ISO-8601 timestamps, default to the last 365 days, and
  // may span at most MAX_EXPORT_RANGE_MS. Authenticated because statements
  // are a user-facing download, unlike the public read endpoints above.
  accountRouter.get(
    "/:publicKey/transactions/export.csv",
    jwtAuth,
    param("publicKey").custom(isGAddress).withMessage(publicKeyMessage),
    query("from").optional().isISO8601({ strict: true }).withMessage("from must be an ISO-8601 date"),
    query("to").optional().isISO8601({ strict: true }).withMessage("to must be an ISO-8601 date"),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const to = req.query.to ? new Date(req.query.to as string) : new Date();
        const from = req.query.from
          ? new Date(req.query.from as string)
          : new Date(to.getTime() - 365 * 24 * 60 * 60 * 1000);

        if (from.getTime() > to.getTime()) {
          throw new AppError("from must be before to", {
            code: "INVALID_EXPORT_RANGE",
            status: 400,
          });
        }
        if (to.getTime() - from.getTime() > MAX_EXPORT_RANGE_MS) {
          throw new AppError("Export range must not exceed 1 year", {
            code: "EXPORT_RANGE_TOO_LARGE",
            status: 400,
            details: { maxRangeDays: 366 },
          });
        }

        await streamTransactionCsv(res, stellar, { publicKey: req.params.publicKey, from, to });
      } catch (err) {
        next(err);
      }
    }
  );

  // #105 — activity feed with suspicious-payment flags (dust, memo_url,
  // unknown_asset). Separate from GET /:publicKey/transactions (which stays
  // on Horizon's transaction-level records) because flagging needs the
  // per-payment amount/asset Horizon only returns from /payments.
  accountRouter.get(
    "/:publicKey/payments",
    param("publicKey").custom(isGAddress).withMessage(publicKeyMessage),
    query("limit")
      .optional()
      .isInt({ min: 1, max: MAX_PAGE_LIMIT })
      .withMessage("limit must be an integer between 1 and 100")
      .toInt(),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const { limit, cursor } = parsePageQuery({
          cursor: req.query.cursor,
          limit: req.query.limit,
        });
        const feed = await getUnifiedActivityFeed(stellar, req.params.publicKey, {
          limit: limit ?? DEFAULT_PAGE_LIMIT,
          cursor,
        });
        const page = paginate(feed.items, feed.nextCursor);
        res.json({
          ...page,
          // @deprecated — use `items` + `nextCursor`. Kept for one version.
          payments: page.items,
          next: feed.nextCursor,
          hasMore: feed.nextCursor !== null,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return accountRouter;
}
