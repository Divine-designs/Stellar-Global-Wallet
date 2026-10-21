import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import crypto from "crypto";
import { rateLimit } from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
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
import { createNetworkRouter } from "./routes/network";
import { localeMiddleware } from "./middleware/locale";
import { errorHandler } from "./middleware/errorHandler";
import { requireAccountMatch } from "./middleware/requireAccountMatch";
import { config } from "./config";
import { StellarService } from "./services/stellar";
import { SorobanService } from "./services/soroban";
import { GlobeWalletContract } from "./services/contracts/globeWallet";
import { AppError, NotFoundError } from "./errors/appError";
import { PriceHistoryService, PriceService, createDefaultPriceServices } from "./services/price";
import { loadOpenApiSpec } from "./openapi";

// #23 — inbound request IDs are only trusted if they match this format.
// Anything else (newlines, control chars, oversized values) is discarded
// and replaced with a generated UUID to avoid log injection.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

function resolveRequestId(inbound: unknown): string {
  if (typeof inbound === "string" && REQUEST_ID_PATTERN.test(inbound)) {
    return inbound;
  }
  return crypto.randomUUID();
}

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

  // #29 — weak ETags let polling clients (dashboard balances/assets) cheaply
  // revalidate with If-None-Match and get a 304 instead of a full payload.
  // Express computes a weak ETag from the JSON body by default; make it
  // explicit so the behaviour is documented and stable.
  app.set("etag", "weak");

  // Must be set before any middleware that reads req.ip (rate limiter
  // below, and anything else added later) — see issue #90. The hop count
  // is configured via TRUST_PROXY_HOPS (config.ts) rather than hardcoded
  // `true`, since trusting the entire X-Forwarded-For chain unconditionally
  // lets a client spoof their apparent IP if there's more than one real
  // proxy hop between them and this process.
  app.set("trust proxy", config.TRUST_PROXY_HOPS);

  // #16 — interactive API docs are opt-in outside production. Default to
  // enabled when NODE_ENV !== 'production' unless ENABLE_API_DOCS is set
  // explicitly; in production they stay off unless the flag is set to true.
  const docsEnabled =
    config.ENABLE_API_DOCS ?? config.NODE_ENV !== "production";

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
  //
  // #16 — Swagger UI is the one HTML surface this process serves, and it
  // relies on inline scripts/styles. Rather than loosening the global CSP
  // for every route, apply a route-specific CSP only to /api/docs below.
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
  // #34 — cookie session mode needs credentialed CORS. `credentials: true`
  // is incompatible with a wildcard origin, so the explicit allow-list from
  // CORS_ORIGIN is required (never `*`). Bearer-token clients are unaffected.
  const corsOrigins = config.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean);
  app.use(cors({ origin: corsOrigins, credentials: true }));
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
  // A client-signed envelope (plain or fee-bump, classic or Soroban) posted to /submit.
  app.use("/api/v1/wallet/submit", express.json({ limit: "64kb" }));
  app.use("/api/v1/contract/wallet/submit", express.json({ limit: "64kb" }));
  // #74 — pending multisig store: create/add-signature/submit all carry an
  // XDR envelope (plus a signature), so they need the larger limit too.
  app.use("/api/v1/wallet/pending-multisig", express.json({ limit: "64kb" }));
  app.use(express.json({ limit: "10kb" }));

  // #22 — every non-2xx response must use the shared error envelope
  // `{ error: { code, message, details?, retryable?, requestId } }`.
  // express-rate-limit's default handler writes a plain-text body, so
  // route the limit through errorHandler via next(AppError) instead.
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000, // 15 min
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (_req, _res, next) => {
        next(
          new AppError("Too many requests, please try again later", {
            code: "RATE_LIMITED",
            status: 429,
            retryable: true,
          })
        );
      },
    })
  );

  // #93 — resolve Accept-Language into req.locale for all routes.
  app.use(localeMiddleware);

  // #35 — CSRF protection for cookie-based sessions (double-submit token).
  // Cookie auth is attached automatically by the browser, so a malicious
  // site could otherwise trigger state-changing requests. Bearer-token
  // requests are exempt (the browser never attaches them automatically).
  // For cookie-authenticated state-changing requests we require the
  // `X-CSRF-Token` header to match the non-httpOnly `gw_csrf` cookie, and
  // we verify the `Origin` header against the CORS allow-list.
  const CSRF_COOKIE = "gw_csrf";
  const CSRF_HEADER = "x-csrf-token";
  const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

  function parseCookies(header: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!header) return out;
    for (const part of header.split(";")) {
      const idx = part.indexOf("=");
      if (idx === -1) continue;
      const key = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (key) out[key] = decodeURIComponent(value);
    }
    return out;
  }

  // GET /auth/csrf — issues a fresh double-submit token. The cookie is
  // intentionally non-httpOnly so browser clients can read it and echo it
  // back in the X-CSRF-Token header. SameSite=Strict is a defence-in-depth
  // layer on top of the token comparison.
  app.get("/auth/csrf", (_req, res) => {
    const token = crypto.randomBytes(32).toString("hex");
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: false,
      sameSite: "strict",
      secure: config.NODE_ENV === "production",
      path: "/",
    });
    res.json({ csrfToken: token });
  });

  app.use((req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();

    const cookies = parseCookies(req.headers.cookie);
    const hasSessionCookie = Boolean(cookies.gw_session);
    const hasBearer = Boolean(
      req.headers.authorization && /^Bearer\s+/i.test(req.headers.authorization)
    );

    // Bearer-authenticated requests are exempt from CSRF: the browser does
    // not attach Authorization headers automatically, so a cross-site
    // attacker cannot forge them.
    if (hasBearer && !hasSessionCookie) return next();

    // Only enforce CSRF for cookie-authenticated requests. Requests with
    // neither a session cookie nor a Bearer token are left to the normal
    // auth layer (they'll be rejected as unauthenticated there).
    if (!hasSessionCookie) return next();

    // Origin check against the CORS allow-list (defence in depth).
    const origin = req.headers.origin;
    if (origin && !corsOrigins.includes(origin)) {
      return res.status(403).json({
        error: "CSRF_ORIGIN_REJECTED",
        message: "Origin is not allowed for cookie-authenticated requests",
      });
    }

    const headerToken = req.headers[CSRF_HEADER];
    const cookieToken = cookies[CSRF_COOKIE];
    if (
      typeof headerToken !== "string" ||
      !cookieToken ||
      headerToken.length !== cookieToken.length ||
      !crypto.timingSafeEqual(Buffer.from(headerToken), Buffer.from(cookieToken))
    ) {
      return res.status(403).json({
        error: "CSRF_TOKEN_INVALID",
        message: "Missing or invalid CSRF token",
      });
    }

    return next();
  });

  // Health
  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  // Unversioned and unauthenticated: this is where a browser enforcing
  // the Content-Security-Policy documented in docs/security/csp.md sends
  // violation reports, not something our own API clients call, so it
  // doesn't live under /api/v1 alongside the versioned wallet/account/etc.
  // routes (see issue: "Add Content-Security-Policy guidance for the
  // future web app").
  app.use("/csp-report", cspReportRouter);

  // #16 — interactive API docs. The OpenAPI spec is read once at startup
  // and served both as Swagger UI at /api/docs and as raw JSON at
  // /api/openapi.json. When disabled, these paths fall through to the 404
  // handler below so production does not expose them by default.
  if (docsEnabled) {
    const openApiSpec = loadOpenApiSpec();

    // Route-specific CSP: Swagger UI ships inline scripts/styles, so the
    // global `default-src 'none'` would block it. Scope the relaxed policy
    // to /api/docs only.
    app.use(
      "/api/docs",
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:"],
            frameAncestors: ["'none'"],
          },
        },
        crossOriginResourcePolicy: { policy: "same-site" },
      })
    );

    app.get("/api/openapi.json", (_req, res) => res.json(openApiSpec));
    app.use(
      "/api/docs",
      swaggerUi.serve,
      swaggerUi.setup(openApiSpec, { customSiteTitle: "Stellar Global Wallet API" })
    );
  }

  // Routes
  app.use("/api/v1/wallet", createWalletRouter(stellar));
  app.use("/api/v1/account", createAccountRouter(stellar));
  // #63 — resolve G.../M.../federation (name*domain) addresses
  app.use("/api/v1/resolve", createResolveRouter());
  app.use("/api/v1/contract", createContractRouter(globeWallet));
  app.use("/api/v1/price", priceRouter);
  // #52, #53 — asset search and stellar.toml metadata for the add-asset flow
  app.use("/api/v1/assets", createAssetsRouter());
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/csp-report", cspReportRouter);
  app.use("/api/v1/flags", flagsRouter);
  // #87 — push notification device registration
  app.use("/api/v1/me/devices", devicesRouter);
  // #90 — email notification fallback (verified email management)
  app.use("/api/v1/me/email", emailRouter);
  // #74 — pending multisig transaction store for co-signers
  app.use("/api/v1/pending-txs", createPendingTxRouter(stellar));
  // #81 — Expose network, Horizon/RPC URLs, and pending upgrade timelock state
  const configRouter = createConfigRouter(globeWallet);
  app.use("/api/v1/config", configRouter);
  app.use("/config", configRouter);
  // #13 — fee estimate (low/normal/high) from Horizon fee_stats, cached
  app.use("/api/v1/network", createNetworkRouter());

  // #69 — testnet-only Friendbot funding for one-click onboarding. The
  // router is only mounted when the configured network is testnet, so on
  // mainnet the path falls through to the 404 handler below.
  if (config.STELLAR_NETWORK === "testnet") {
    app.use("/api/v1/dev", createDevRouter());
  }

  app.use((_req, _res, next) => {
    next(new NotFoundError("Route not found"));
  });

  app.use(errorHandler);

  return app;
}
