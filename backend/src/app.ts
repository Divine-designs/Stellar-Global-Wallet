import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import { rateLimit } from "express-rate-limit";
import { createWalletRouter } from "./routes/wallet";
import { createAccountRouter } from "./routes/account";
import { createContractRouter } from "./routes/contract";
import { createTransactionsRouter } from "./routes/transactions";
import { priceRouter } from "./routes/price";
import { createAssetsRouter } from "./routes/assets";
import { authRouter } from "./routes/auth";
import { cspReportRouter } from "./routes/cspReport";
import { flagsRouter } from "./routes/flags";
import { devicesRouter } from "./routes/devices";
import { emailRouter } from "./routes/email";
import { createConfigRouter } from "./routes/config";
import { createPendingTxRouter } from "./routes/pendingTx";
import { createResolveRouter } from "./routes/resolve";
import { localeMiddleware } from "./middleware/locale";
import { errorHandler } from "./middleware/errorHandler";
import { requireAccountMatch } from "./middleware/requireAccountMatch";
import { config } from "./config";
import { StellarService } from "./services/stellar";
import { SorobanService } from "./services/soroban";
import { GlobeWalletContract } from "./services/contracts/globeWallet";
import { NotFoundError } from "./errors/appError";
import { PriceHistoryService, PriceService, createDefaultPriceServices } from "./services/price";

type HealthCheckStatus = "ok" | "degraded" | "down";

interface DependencyCheck {
  ok: boolean;
  latencyMs: number;
  skipped?: boolean;
  error?: string;
}

interface HealthDetails {
  status: HealthCheckStatus;
  checks: {
    horizon: DependencyCheck;
    rpc: DependencyCheck;
    postgres: DependencyCheck;
    redis: DependencyCheck;
  };
}

const HEALTH_CHECK_TIMEOUT_MS = 1500;
const HEALTH_CACHE_TTL_MS = 10_000;

async function timedCheck(
  fn: (signal: AbortSignal) => Promise<unknown>
): Promise<DependencyCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  const start = Date.now();
  try {
    await fn(controller.signal);
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.name : "Error",
    };
  } finally {
    clearTimeout(timer);
  }
}

function skippedCheck(): DependencyCheck {
  return { ok: true, latencyMs: 0, skipped: true };
}

async function checkHorizon(signal: AbortSignal): Promise<DependencyCheck> {
  return timedCheck(async (s) => {
    const res = await fetch(config.HORIZON_URL, { signal: s });
    if (!res.ok) throw new Error(`Horizon responded ${res.status}`);
  });
}

async function checkRpc(signal: AbortSignal): Promise<DependencyCheck> {
  return timedCheck(async (s) => {
    const res = await fetch(config.SOROBAN_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      signal: s,
    });
    if (!res.ok) throw new Error(`RPC responded ${res.status}`);
    const body = (await res.json()) as { result?: { status?: string } };
    if (body.result?.status && body.result.status !== "healthy") {
      throw new Error(`RPC status ${body.result.status}`);
    }
  });
}

async function checkPostgres(): Promise<DependencyCheck> {
  // Postgres is only required when the lock backend is postgres.
  if (config.LOCK_BACKEND !== "postgres") return skippedCheck();
  return timedCheck(async () => {
    const { pool } = await import("./db/pool");
    await pool.query("SELECT 1");
  });
}

async function checkRedis(): Promise<DependencyCheck> {
  // Redis is only required when the lock backend is redis.
  if (config.LOCK_BACKEND !== "redis") return skippedCheck();
  return timedCheck(async () => {
    const { redis } = await import("./db/redis");
    await redis.ping();
  });
}

async function runHealthChecks(): Promise<HealthDetails> {
  const [horizon, rpc, postgres, redis] = await Promise.all([
    checkHorizon(new AbortController().signal),
    checkRpc(new AbortController().signal),
    checkPostgres(),
    checkRedis(),
  ]);

  const checks = { horizon, rpc, postgres, redis };
  const required = [horizon, rpc, postgres, redis].filter((c) => !c.skipped);
  const failed = required.filter((c) => !c.ok);

  let status: HealthCheckStatus = "ok";
  if (failed.length > 0) {
    // Horizon/RPC are core dependencies; if either is down the app is down.
    const coreDown = !horizon.ok || !rpc.ok;
    status = coreDown ? "down" : "degraded";
  }

  return { status, checks };
}

/**
 * Resolves the account a request targets for the account-match guard.
 * Checks common locations (body/query/params) for a source/account field.
 * Returns undefined when the request does not target a specific account.
 */
function resolveTargetAccount(req: express.Request): string | undefined {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const query = req.query as Record<string, unknown>;
  const params = req.params as Record<string, unknown>;
  const candidates = [
    body.sourceAccount,
    body.source,
    body.account,
    body.publicKey,
    body.guardian,
    query.sourceAccount,
    query.account,
    params.account,
    params.publicKey,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function createApp(
  stellar: StellarService = new StellarService(),
  globeWallet: GlobeWalletContract = new GlobeWalletContract(new SorobanService()),
  priceServices: { prices: PriceService; history: PriceHistoryService } = createDefaultPriceServices()
) {
  const app = express();

  // Must be set before any middleware that reads req.ip (rate limiter
  // below, and anything else added later) — see issue #90. The hop count
  // is configured via TRUST_PROXY_HOPS (config.ts) rather than hardcoded
  // `true`, since trusting the entire X-Forwarded-For chain unconditionally
  // lets a client spoof their apparent IP if there's more than one real
  // proxy hop between them and this process.
  app.set("trust proxy", config.TRUST_PROXY_HOPS);

  // helmet()'s defaults are tuned for a server rendering HTML (CSP that
  // still allows inline styles/scripts via nonces, X-Frame-Options, a
  // same-origin resource policy meant to protect pages with embeddable
  // assets). This API never serves HTML or embeddable assets — every
  // response is JSON — so the HTML-oriented defaults are either useless or
  // actively wrong here. Configure it explicitly for an API-only surface
  // instead of relying on defaults that were never written with this case
  // in mind (issue #119):
  //   - `default-src 'none'` / `frame-ancestors 'none'`: nothing on this
  //     origin should ever execute script or be framed — there's no HTML
  //     to inject into, and no page here should be embeddable.
  //   - `cross-origin-resource-policy: same-site`: this API is read by
  //     browser-based clients (web/mobile apps on other origins, once
  //     built — see root README), so the default `same-origin` would block
  //     them from even reading responses; `same-site` keeps third-party
  //     sites that aren't part of this project from loading API responses
  //     via <script>/<img> while still allowing the project's own apps.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: "same-site" },
    })
  );
  app.use(cors({ origin: config.CORS_ORIGIN.split(",") }));
  app.use(morgan("combined"));

  // A multi-signed transaction envelope (several signatures on one XDR
  // blob) or a fee-bump wrapping one can comfortably exceed a few KB, and
  // the default 10kb limit below would reject a legitimate request with a
  // generic 413 before it ever reaches validation. These two routes are
  // the ones that actually accept an XDR envelope as input (`fee-bump`'s
  // `transactionXdr`, `submit-multisig`'s `xdr` + its signer key array),
  // so they get a larger, still-bounded limit; everything else keeps the
  // tighter default. Registering a path-specific `express.json()` before
  // the general one works because body-parser marks the body parsed once
  // one middleware has consumed the stream — the later, broader
  // `express.json` for every other route is then a no-op for these paths.
  app.use("/api/v1/wallet/fee-bump", express.json({ limit: "64kb" }));
  app.use("/api/v1/wallet/submit-multisig", express.json({ limit: "64kb" }));
  // #74 — pending multisig store: create/add-signature/submit all carry an
  // XDR envelope (plus a signature), so they need the larger limit too.
  app.use("/api/v1/wallet/pending-multisig", express.json({ limit: "64kb" }));
  app.use(express.json({ limit: "10kb" }));

  app.use(localeMiddleware);

  // #33 — deny-by-default account scoping. A valid JWT for account A must
  // not be usable to act for account B. Applied to the protected route
  // groups below; the resolver reads the target account from the request
  // (source account for build routes, guardian address for guardian
  // actions). Read-only public data (balances) stays public.
  const accountMatch = requireAccountMatch(resolveTargetAccount);

  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });
  app.use("/api/", limiter);

  app.get("/health", async (_req, res, next) => {
    try {
      const details = await runHealthChecks();
      const httpStatus = details.status === "down" ? 503 : 200;
      res.status(httpStatus).json(details);
    } catch (err) {
      next(err);
    }
  });

  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/csp-report", cspReportRouter);
  app.use("/api/v1/flags", flagsRouter);
  app.use("/api/v1/price", priceRouter);
  app.use("/api/v1/email", emailRouter);

  // Protected route groups: scoped to the authenticated account (#33).
  app.use("/api/v1/wallet", accountMatch, createWalletRouter(stellar, globeWallet));
  app.use("/api/v1/account", accountMatch, createAccountRouter(stellar));
  app.use("/api/v1/contract", accountMatch, createContractRouter(globeWallet));
  app.use("/api/v1/transactions", accountMatch, createTransactionsRouter(stellar));
  app.use("/api/v1/assets", accountMatch, createAssetsRouter(stellar));
  app.use("/api/v1/devices", accountMatch, devicesRouter);
  app.use("/api/v1/config", accountMatch, createConfigRouter());
  app.use("/api/v1/pending-tx", accountMatch, createPendingTxRouter());
  app.use("/api/v1/resolve", accountMatch, createResolveRouter());

  app.use((_req, _res, next) => {
    next(new NotFoundError("Route not found"));
  });

  app.use(errorHandler);

  return app;
}
