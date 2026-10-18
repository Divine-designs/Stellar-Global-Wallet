import { Router } from "express";
import { param, query } from "express-validator";
import { z } from "zod";
import { assertValidRequest } from "../middleware/requestValidation";
import { StellarService } from "../services/stellar";
import { getUnifiedActivityFeed } from "../services/activityFeed";
import { isGAddress, publicKeyMessage } from "../utils/stellarAddress";
import { AppError } from "../errors/appError";
import { getDb } from "../db";
import {
  parseHistoryFilters,
  validateAssetFilter,
  validateDateRange,
  validateDirectionFilter,
  validateTypeFilter,
} from "../validation/historyQuery";

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

  accountRouter.get(
    "/:publicKey/transactions",
    param("publicKey").custom(isGAddress).withMessage(publicKeyMessage),
    query("limit")
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage("limit must be an integer between 1 and 100")
      .toInt(),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const limit = (req.query.limit as number | undefined) ?? 20;
        const cursor = req.query.cursor as string | undefined;
        const result = await stellar.getTransactions(req.params.publicKey, { limit, cursor });
        res.json({ 
          transactions: result.transactions,
          next: result.next,
          hasMore: result.hasMore,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // #59 / #61 — display-ready, operation-level history ("Received 25 USDC
  // from G…ABC") with optional asset/type/direction/date filters. See
  // docs/transaction-history.md for the item shape and why filtered
  // requests can return fewer than `limit` items with `scanCapped: true`.
  accountRouter.get(
    "/:publicKey/history",
    param("publicKey").custom(isGAddress).withMessage(publicKeyMessage),
    query("limit")
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage("limit must be an integer between 1 and 100")
      .toInt(),
    query("cursor")
      .optional()
      .matches(/^[0-9]{1,20}$/)
      .withMessage("cursor must be a paging token returned as `next` by a previous page"),
    query("asset").optional().custom(validateAssetFilter),
    query("type").optional().custom(validateTypeFilter),
    query("direction").optional().custom(validateDirectionFilter),
    query("since")
      .optional()
      .isISO8601({ strict: true })
      .withMessage("since must be an ISO 8601 date or date-time"),
    query("until")
      .optional()
      .isISO8601({ strict: true })
      .withMessage("until must be an ISO 8601 date or date-time")
      .bail()
      .custom((until, { req }) => validateDateRange(until, req.query?.since)),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const limit = (req.query.limit as number | undefined) ?? 20;
        const cursor = req.query.cursor as string | undefined;
        const filters = parseHistoryFilters(req.query as Record<string, unknown>);
        const page = await stellar.getHistory(req.params.publicKey, { limit, cursor, filters });
        res.json(page);
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
      .isInt({ min: 1, max: 100 })
      .withMessage("limit must be an integer between 1 and 100")
      .toInt(),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const limit = (req.query.limit as number | undefined) ?? 20;
        const cursor = req.query.cursor as string | undefined;
        const result = await stellar.getPaymentHistory(req.params.publicKey, { limit, cursor });
        res.json({
          payments: result.payments,
          next: result.next,
          hasMore: result.hasMore,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // #79 — activity feed combining classic payments and Soroban contract events
  accountRouter.get(
    "/:publicKey/activity",
    param("publicKey").custom(isGAddress).withMessage(publicKeyMessage),
    query("limit")
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage("limit must be an integer between 1 and 100")
      .toInt(),
    async (req, res, next) => {
      try {
        assertValidRequest(req);
        const limit = (req.query.limit as number | undefined) ?? 20;
        const cursor = req.query.cursor as string | undefined;
        const result = await getUnifiedActivityFeed({
          publicKey: req.params.publicKey,
          limit,
          cursor,
          stellar,
        });
        res.json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  // #68 — user preferences (currency, language, hidden assets, notifications).
  // Stored per-account in the preferences table so they sync across devices.
  accountRouter.get("/:publicKey/preferences", async (req, res, next) => {
    try {
      const account = req.params.publicKey;
      if (!isGAddress(account)) {
        throw new AppError("VALIDATION_ERROR", 400, publicKeyMessage);
      }
      const db = getDb();
      const row = await db("preferences").where({ account }).first();
      const data = (row?.data as Preferences | undefined) ?? {};
      res.json({
        account,
        preferences: data,
        updatedAt: row?.updated_at ?? null,
      });
    } catch (err) {
      next(err);
    }
  });

  accountRouter.put("/:publicKey/preferences", async (req, res, next) => {
    try {
      const account = req.params.publicKey;
      if (!isGAddress(account)) {
        throw new AppError("VALIDATION_ERROR", 400, publicKeyMessage);
      }
      const preferences = parsePreferences(req.body);
      const db = getDb();
      const now = new Date();
      await db("preferences")
        .insert({ account, data: preferences, updated_at: now })
        .onConflict("account")
        .merge({ data: preferences, updated_at: now });
      res.json({
        account,
        preferences,
        updatedAt: now.toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  return accountRouter;
}
