import { z } from "zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #41 — CORS origins are validated at startup so a typo (trailing space,
// missing scheme) fails fast with a clear message instead of silently
// blocking the web app at request time. Each comma-separated entry is
// trimmed and must parse as a URL. `exp://` origins (Expo dev) are kept
// supported — `new URL()` accepts them.
const corsOriginSchema = z
  .string()
  .min(1)
  .transform((raw, ctx) => {
    const origins = raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    if (origins.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "CORS_ORIGIN must contain at least one origin",
      });
      return z.NEVER;
    }

    for (const origin of origins) {
      try {
        // eslint-disable-next-line no-new
        new URL(origin);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `CORS_ORIGIN entry "${origin}" is not a valid URL (expected e.g. https://app.globewallet.app or exp://192.168.1.10:8081)`,
        });
        return z.NEVER;
      }
    }

    return origins;
  });

// #41 — opt-in regex for preview deploys (Vercel/Netlify). Validated as a
// compilable RegExp so a bad pattern fails startup rather than throwing on
// the first request.
const corsOriginRegexSchema = z
  .string()
  .min(1)
  .optional()
  .transform((raw, ctx) => {
    if (raw === undefined) return undefined;
    try {
      return new RegExp(raw);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `CORS_ORIGIN_REGEX is not a valid regular expression: ${raw}`,
      });
      return z.NEVER;
    }
  });

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  HORIZON_URL: z.string().url().default("https://horizon-testnet.stellar.org"),
  NETWORK_PASSPHRASE: z.string().min(1),
  CORS_ORIGIN: corsOriginSchema,
  CORS_ORIGIN_REGEX: corsOriginRegexSchema,
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z.string().min(1),
  API_KEY: z.string().min(1),
  // "in-process" serializes concurrent submissions for the same source
  // account within a single Node process only. Running more than one
  // instance of this API requires "redis" (using REDIS_URL below) to get
  // the same guarantee across instances — see docs/concurrency.md.
  LOCK_BACKEND: z.enum(["in-process", "redis"]).default("in-process"),

  // Soroban RPC is a distinct protocol/endpoint from Horizon (simulate/send/
  // getTransaction vs. classic submitTransaction) and testnet/mainnet often
  // run it on a different host, so it gets its own client config rather than
  // reusing HORIZON_URL/NETWORK_PASSPHRASE.
  SOROBAN_RPC_URL: z.string().url().default("https://soroban-testnet.stellar.org"),
  SOROBAN_NETWORK_PASSPHRASE: z.string().min(1).default("Test SDF Network ; September 2015"),
  // Deployed globe-wallet contract ID (C...). Optional so the API can still
  // boot without it; /api/v1/contract/wallet/* routes respond 503 until set.
  // When present, must be a valid Soroban contract StrKey: the letter C
  // followed by exactly 55 uppercase alphanumeric characters (56 chars total),
  // mirroring the isGAddress shape-checks used for G.../S... keys elsewhere.
  GLOBE_WALLET_CONTRACT_ID: z
    .string()
    .regex(
      /^C[A-Z0-9]{55}$/,
      "must be a valid Soroban contract StrKey (C followed by 55 uppercase alphanumeric characters)"
    )
    .optional(),
  TOKEN_WRAPPER_CONTRACT_ID: z
    .string()
    .regex(
      /^C[A-Z0-9]{55}$/,
      "must be a valid Soroban contract StrKey (C followed by 55 uppercase alphanumeric characters)"
    )
    .optional(),
  MIN_CLIENT_VERSION: z.string().min(1).default("0.1.0"),

  // Number of trusted reverse-proxy hops in front of this service, passed
  // straight to Express's `trust proxy` setting (see src/app.ts). This
  // determines which X-Forwarded-For entry Express treats as the real
  // client IP, which is what express-rate-limit keys its per-IP buckets on.
  //
  // Must match the ACTUAL deployment topology — docs/concurrency.md already
  // documents this service running as "multiple processes, containers, or
  // pods behind a load balancer" (the reason RedisAccountLock exists), so a
  // value of 0 (no trust proxy set) is almost certainly wrong in production
  // and silently pools every real client's rate limit into one shared
  // bucket keyed on the proxy's own address.
  //
  // Do NOT set this to a boolean-equivalent "trust everything" value — a
  // hop count higher than the real topology lets a client spoof
  // X-Forwarded-For and bypass rate limiting for their real IP.
  // Changing this number is a deliberate, reviewed infra change, not a
  // quick fix — see issue #90.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(1),

  // Comma-separated `name:true|false` pairs overriding the defaults in
  // src/services/featureFlags.ts, e.g. `FEATURE_FLAGS=recovery:true`.
  // Lets ops flip a flag per-environment without a deploy; see
  // GET /api/v1/flags (issue: "Add a feature-flag endpoint so clients can
  // toggle unfinished features").
  FEATURE_FLAGS: z.string().optional(),

  // #90 — email notification fallback channel.
  // Provider: "console" (default, dev-safe), "resend", or "ses".
  EMAIL_PROVIDER: z.enum(["console", "resend", "ses"]).default("console"),
  // Sender address used by all transactional emails.
  EMAIL_FROM: z.string().email().default("noreply@globewallet.app"),
  // Resend API key (required when EMAIL_PROVIDER=resend).
  RESEND_API_KEY: z.string().optional(),
  // AWS SES variables (required when EMAIL_PROVIDER=ses).
  AWS_SES_REGION: z.string().optional(),
  AWS_SES_ACCESS_KEY_ID: z.string().optional(),
  AWS_SES_SECRET_ACCESS_KEY: z.string().optional(),
  // Public base URL used to build email verification links.
  BASE_URL: z.string().url().default("https://app.globewallet.app"),

  // Suspicious-payment heuristics for the activity feed (#105). See
  // src/services/paymentFlags.ts for how these are applied.
  SPAM_DUST_THRESHOLD: z.coerce.number().positive().default(0.5),
  // Comma-separated "CODE:ISSUER" pairs. Empty by default — deny-by-default
  // until a curated list exists (#54): every issued (non-native) asset is
  // flagged "unknown_asset" until explicitly added here.
  VERIFIED_ASSETS: z.string().default(""),

  // Which network this deployment talks to. Selects the curated verified-
  // asset list (backend/data/verified-assets.<network>.json, #54), the
  // default USDC issuer used as the USD quote asset for prices (#55), and
  // whether testnet-only routes (Friendbot, #69) are mounted.
  STELLAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),

  // #55 — price oracle. Comma-separated provider order; the first provider
  // that returns a price for an asset wins, later ones are fallbacks.
  PRICE_PROVIDERS: z.string().default("stellar_dex,coingecko"),
  // TTL for spot prices (single and batch lookups share one cache).
  PRICE_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(30),
  // Issuer of the USDC asset used as the USD quote on the Stellar DEX.
  // Defaults to Circle's issuer for STELLAR_NETWORK (see services/price/usdQuote.ts).
  PRICE_USDC_ISSUER: z.string().optional(),
  COINGECKO_BASE_URL: z.string().url().default("https://api.coingecko.com/api/v3"),
  // Optional CoinGecko demo/pro API key, sent as x-cg-demo-api-key.
  COINGECKO_API_KEY: z.string().optional(),

  // #77 — contract event indexer. The worker polls Soroban RPC getEvents
  // filtered by GLOBE_WALLET_CONTRACT_ID and persists a cursor in the
  // indexer_state table so restarts resume where they left off. These knobs
  // let ops tune polling without a deploy.
  //
  // Ledger to start indexing from when no cursor exists yet (e.g. the
  // contract's deploy ledger). `npm run indexer:backfill -- --from-ledger N`
  // overrides this for a one-off backfill run.
  INDEXER_START_LEDGER: z.coerce.number().int().min(0).default(0),
  // How often the worker polls getEvents, in milliseconds.
  INDEXER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  // Max events requested per getEvents page (RPC caps this at 10000).
  INDEXER_PAGE_SIZE: z.coerce.number().int().positive().max(10000).default(200),
  // RPC only retains recent events (~7 days on testnet). If the stored
  // cursor falls further behind the latest ledger than this many ledgers,
  // the worker logs an alert because the retention gap means events were
  // permanently lost and a backfill from an archive source is required.
  INDEXER_RETENTION_GAP_LEDGERS: z.coerce.number().int().positive().default(120960),

  // #16 — interactive API docs (Swagger UI at /api/docs, raw spec at
  // /api/openapi.json). Defaults to enabled outside production and disabled
  // in production so a prod build never exposes docs unless explicitly
  // opted in via ENABLE_API_DOCS=true.
  ENABLE_API_DOCS: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? process.env.NODE_ENV !== "production" : v === "true")),
});

export const config = envSchema.parse(process.env);

// Read the package version once at boot. Resolved relative to this file so it
// works both under ts-node (src/) and compiled output (dist/).
function readPackageVersion(): string {
  try {
    const pkgPath = join(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "1.0.0";
  } catch {
    return "1.0.0";
  }
}

const packageVersion = readPackageVersion();
const [, packageMinor = "0"] = packageVersion.split(".");

// API major version is fixed by the URL prefix; minor tracks package.json.
export const API_MAJOR_VERSION = 1;
export const API_VERSION = `${API_MAJOR_VERSION}.${packageMinor}`;
