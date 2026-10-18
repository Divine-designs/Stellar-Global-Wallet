/**
 * Asset metadata from the issuer's stellar.toml (SEP-1), issue #52.
 *
 * Flow: load the issuer account from Horizon → read `home_domain` → fetch
 * `https://<home_domain>/.well-known/stellar.toml` (5s timeout, 100KB cap,
 * SSRF-guarded — see safeHttpsFetch.ts) → parse → pick the [[CURRENCIES]]
 * entry whose code+issuer match.
 *
 * Every outcome other than "issuer account doesn't exist" or "Horizon is
 * down" is a 200 with a `status` field explaining what was (not) found and
 * the metadata fields set to null. A missing or broken stellar.toml is a
 * normal, common state for an asset — clients should fall back to showing
 * the code and a truncated issuer — not an API error.
 *
 * Caching: successful lookups for 24h, unsuccessful ones (no home domain,
 * fetch failed, invalid toml, currency not listed) for 1h.
 */
import * as StellarSdk from "@stellar/stellar-sdk";
import { parse as parseToml } from "@iarna/toml";
import type { AssetMetadata, AssetMetadataStatus } from "@stellar-global-wallet/types";
import { config } from "../config";
import { HorizonError, NotFoundError } from "../errors/appError";
import { JsonCache, redisJsonCache } from "./jsonCache";
import { SafeFetchError, isValidPublicHostname, safeHttpsGetText } from "./safeHttpsFetch";

// Canonical definitions live in packages/types so web/mobile share them.
export type { AssetMetadata, AssetMetadataStatus };

export const TOML_TIMEOUT_MS = 5_000;
export const TOML_MAX_BYTES = 100 * 1024;
export const POSITIVE_TTL_SECONDS = 24 * 60 * 60;
export const NEGATIVE_TTL_SECONDS = 60 * 60;
const DEFAULT_DECIMALS = 7;
const MAX_TEXT_LENGTH = 1_000;
const MAX_URL_LENGTH = 2_048;

/** Drop anything that isn't an absolute https URL (no javascript:, data:, http:). */
export function sanitizeImageUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Strings from a third-party toml go straight to UI. Clients must still
 * render them as text, never HTML (OWASP XSS cheat sheet); here we only
 * strip control characters and bound the length so a hostile toml can't
 * bloat every response that embeds it.
 */
function cleanText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > MAX_TEXT_LENGTH ? cleaned.slice(0, MAX_TEXT_LENGTH) : cleaned;
}

function cleanDecimals(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 7 ? raw : DEFAULT_DECIMALS;
}

function emptyMetadata(
  code: string,
  issuer: string,
  homeDomain: string | null,
  status: AssetMetadataStatus,
  orgName: string | null = null
): AssetMetadata {
  return { code, issuer, name: null, desc: null, image: null, decimals: DEFAULT_DECIMALS, homeDomain, orgName, status };
}

function parseTomlSafely(tomlText: string): Record<string, unknown> | null {
  try {
    return parseToml(tomlText) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function orgNameOf(parsed: Record<string, unknown>): string | null {
  const documentation = parsed.DOCUMENTATION;
  return documentation && typeof documentation === "object" && !Array.isArray(documentation)
    ? cleanText((documentation as Record<string, unknown>).ORG_NAME)
    : null;
}

function currenciesOf(parsed: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(parsed.CURRENCIES)) return [];
  return (parsed.CURRENCIES as unknown[]).filter(
    (entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry)
  );
}

/**
 * Pure: turn raw stellar.toml text into metadata for CODE:ISSUER. Exported
 * for fixture tests. Never throws — malformed input yields `toml_invalid`.
 */
export function parseStellarToml(
  tomlText: string,
  code: string,
  issuer: string,
  homeDomain: string
): AssetMetadata {
  const parsed = parseTomlSafely(tomlText);
  if (!parsed) return emptyMetadata(code, issuer, homeDomain, "toml_invalid");

  const orgName = orgNameOf(parsed);
  const match = currenciesOf(parsed).find((c) => c.code === code && c.issuer === issuer);

  if (!match) return emptyMetadata(code, issuer, homeDomain, "currency_not_listed", orgName);

  return {
    code,
    issuer,
    name: cleanText(match.name),
    desc: cleanText(match.desc),
    image: sanitizeImageUrl(match.image),
    decimals: cleanDecimals(match.display_decimals),
    homeDomain,
    orgName,
    status: "ok",
  };
}

/** One CODE:ISSUER pair a domain's stellar.toml lists under [[CURRENCIES]]. */
export interface DomainCurrency {
  code: string;
  issuer: string;
}

/** Max [[CURRENCIES]] entries considered per domain — bounds the per-entry Horizon checks. */
export const MAX_DOMAIN_CURRENCIES = 20;

/**
 * Pure: the well-formed CODE:ISSUER pairs listed in a stellar.toml, first
 * MAX_DOMAIN_CURRENCIES only. Returns null if the toml doesn't parse.
 */
export function parseTomlCurrencies(tomlText: string): DomainCurrency[] | null {
  const parsed = parseTomlSafely(tomlText);
  if (!parsed) return null;
  const out: DomainCurrency[] = [];
  for (const c of currenciesOf(parsed)) {
    if (
      typeof c.code === "string" &&
      /^[A-Za-z0-9]{1,12}$/.test(c.code) &&
      typeof c.issuer === "string" &&
      StellarSdk.StrKey.isValidEd25519PublicKey(c.issuer)
    ) {
      out.push({ code: c.code, issuer: c.issuer });
    }
    if (out.length >= MAX_DOMAIN_CURRENCIES) break;
  }
  return out;
}

export interface AssetMetadataDeps {
  /** Returns the issuer's `home_domain` (undefined if unset). Throws NotFoundError if the account doesn't exist. */
  loadHomeDomain: (issuer: string) => Promise<string | undefined>;
  fetchText: (url: string) => Promise<string>;
  cache: JsonCache;
}

function hasStatus(err: unknown, status: number): boolean {
  return (err as { response?: { status?: number } })?.response?.status === status;
}

function defaultDeps(): AssetMetadataDeps {
  const horizon = new StellarSdk.Horizon.Server(config.HORIZON_URL);
  return {
    loadHomeDomain: async (issuer) => {
      try {
        const account = await horizon.loadAccount(issuer);
        return (account as unknown as { home_domain?: string }).home_domain;
      } catch (err) {
        if (hasStatus(err, 404)) {
          throw new NotFoundError(`Issuer account ${issuer} was not found`, "ISSUER_NOT_FOUND");
        }
        throw new HorizonError("Could not load issuer account from Horizon", {
          code: "HORIZON_UNAVAILABLE",
          retryable: true,
        });
      }
    },
    fetchText: (url) => safeHttpsGetText(url, { timeoutMs: TOML_TIMEOUT_MS, maxBytes: TOML_MAX_BYTES }),
    cache: redisJsonCache,
  };
}

export class AssetMetadataService {
  private readonly deps: AssetMetadataDeps;

  constructor(deps: Partial<AssetMetadataDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  async getMetadata(code: string, issuer: string): Promise<AssetMetadata> {
    const cacheKey = `asset-metadata:${code}:${issuer}`;
    const cached = await this.deps.cache.get<AssetMetadata>(cacheKey);
    if (cached) return cached;

    const metadata = await this.lookup(code, issuer);
    await this.deps.cache.set(
      cacheKey,
      metadata,
      metadata.status === "ok" ? POSITIVE_TTL_SECONDS : NEGATIVE_TTL_SECONDS
    );
    return metadata;
  }

  /**
   * Assets a domain publishes in its stellar.toml, kept only where the
   * issuer account's `home_domain` points back at the same domain. SEP-1
   * trust is bidirectional: anyone can list a famous issuer in their own
   * toml, so a one-way claim is not shown. Returns [] when the domain has
   * no usable toml. Cached like metadata (24h hit / 1h empty).
   */
  async listDomainCurrencies(domain: string): Promise<DomainCurrency[]> {
    const homeDomain = domain.trim().toLowerCase();
    if (!isValidPublicHostname(homeDomain)) return [];

    const cacheKey = `domain-currencies:${homeDomain}`;
    const cached = await this.deps.cache.get<DomainCurrency[]>(cacheKey);
    if (cached) return cached;

    let currencies: DomainCurrency[] = [];
    try {
      const tomlText = await this.deps.fetchText(`https://${homeDomain}/.well-known/stellar.toml`);
      currencies = parseTomlCurrencies(tomlText) ?? [];
    } catch {
      currencies = [];
    }

    const checks = await Promise.all(
      currencies.map(async (c) => {
        try {
          const issuerDomain = await this.deps.loadHomeDomain(c.issuer);
          return issuerDomain?.trim().toLowerCase() === homeDomain;
        } catch {
          return false;
        }
      })
    );
    const confirmed = currencies.filter((_, i) => checks[i]);

    await this.deps.cache.set(
      cacheKey,
      confirmed,
      confirmed.length > 0 ? POSITIVE_TTL_SECONDS : NEGATIVE_TTL_SECONDS
    );
    return confirmed;
  }

  private async lookup(code: string, issuer: string): Promise<AssetMetadata> {
    // Not-found / Horizon-down propagate: those aren't cacheable facts about the asset.
    const rawDomain = await this.deps.loadHomeDomain(issuer);
    if (!rawDomain) return emptyMetadata(code, issuer, null, "no_home_domain");

    const homeDomain = rawDomain.trim().toLowerCase();
    if (!isValidPublicHostname(homeDomain)) {
      return emptyMetadata(code, issuer, null, "invalid_home_domain");
    }

    let tomlText: string;
    try {
      tomlText = await this.deps.fetchText(`https://${homeDomain}/.well-known/stellar.toml`);
    } catch (err) {
      if (!(err instanceof SafeFetchError)) {
        console.error("[asset-metadata] unexpected toml fetch error", (err as Error)?.message);
      }
      return emptyMetadata(code, issuer, homeDomain, "toml_unavailable");
    }

    return parseStellarToml(tomlText, code, issuer, homeDomain);
  }
}
