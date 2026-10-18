/**
 * Asset search for the add-trustline flow (issue #53).
 *
 * Typing "USDC" matches dozens of issuers on mainnet, most of them
 * lookalikes. This proxies Horizon's `/assets?asset_code=` and reorders the
 * page so curated verified issuers (see verifiedAssets.ts) come first, then
 * the rest by number of trustlines, descending.
 *
 * Two modes:
 *   - `code`: Horizon `/assets?asset_code=CODE&order=desc&limit=N`, cursor
 *     paginated. On the first page, verified issuers for CODE that Horizon
 *     didn't happen to return are fetched individually and included, so
 *     the right answer is always on page one.
 *   - `domain`: the CODE:ISSUER pairs that domain's stellar.toml lists and
 *     whose issuer's `home_domain` confirms it (AssetMetadataService).
 *     Single page, no cursor.
 *
 * Sorting happens within a page: Horizon itself can't order by trustline
 * count, so page 2 is not guaranteed to have fewer holders than page 1.
 */
import * as StellarSdk from "@stellar/stellar-sdk";
import type { AssetSearchPage, AssetSearchResult } from "@stellar-global-wallet/types";
import { config } from "../config";
import { HorizonError } from "../errors/appError";
import { AssetMetadataService } from "./assetMetadata";
import { VerifiedAssetRegistry, createVerifiedAssetRegistry } from "./verifiedAssets";

// Canonical definitions live in packages/types so web/mobile share them.
export type { AssetSearchPage, AssetSearchResult };

/** Loose shape of a Horizon asset record — only the fields read here. */
export interface HorizonAssetRecord {
  asset_type: string;
  asset_code: string;
  asset_issuer: string;
  paging_token: string;
  num_accounts?: number;
  accounts?: { authorized?: number };
  _links?: { toml?: { href?: string } };
}

export interface AssetSearchDeps {
  /** Horizon `/assets` page for `code`. */
  fetchAssetsPage: (params: { code: string; limit: number; cursor?: string }) => Promise<HorizonAssetRecord[]>;
  /** Horizon `/assets` for one exact CODE:ISSUER; null if Horizon has no record. */
  fetchAsset: (code: string, issuer: string) => Promise<HorizonAssetRecord | null>;
  verified: VerifiedAssetRegistry;
  metadata: Pick<AssetMetadataService, "listDomainCurrencies">;
}

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 50;

function horizonUnavailable(): HorizonError {
  return new HorizonError("Could not search assets on Horizon", {
    code: "HORIZON_UNAVAILABLE",
    retryable: true,
  });
}

function defaultDeps(): Omit<AssetSearchDeps, "metadata"> {
  const horizon = new StellarSdk.Horizon.Server(config.HORIZON_URL);
  return {
    fetchAssetsPage: async ({ code, limit, cursor }) => {
      try {
        let builder = horizon.assets().forCode(code).order("desc").limit(limit);
        if (cursor) builder = builder.cursor(cursor);
        const page = await builder.call();
        return page.records as unknown as HorizonAssetRecord[];
      } catch {
        throw horizonUnavailable();
      }
    },
    fetchAsset: async (code, issuer) => {
      try {
        const page = await horizon.assets().forCode(code).forIssuer(issuer).limit(1).call();
        return (page.records[0] as unknown as HorizonAssetRecord | undefined) ?? null;
      } catch {
        throw horizonUnavailable();
      }
    },
    verified: createVerifiedAssetRegistry(),
  };
}

function homeDomainFromToml(record: HorizonAssetRecord): string | null {
  const href = record._links?.toml?.href;
  if (!href) return null;
  try {
    return new URL(href).hostname || null;
  } catch {
    return null;
  }
}

function holderCount(record: HorizonAssetRecord): number {
  return record.accounts?.authorized ?? record.num_accounts ?? 0;
}

/** Verified first, then most trustlines first, then code:issuer for a stable order. */
export function rankResults(results: AssetSearchResult[]): AssetSearchResult[] {
  return [...results].sort((a, b) => {
    if (a.verified !== b.verified) return a.verified ? -1 : 1;
    const holders = (b.numAccounts ?? -1) - (a.numAccounts ?? -1);
    if (holders !== 0) return holders;
    return `${a.code}:${a.issuer}`.localeCompare(`${b.code}:${b.issuer}`);
  });
}

export class AssetSearchService {
  private readonly deps: AssetSearchDeps;

  constructor(deps: Partial<AssetSearchDeps> = {}) {
    const base = defaultDeps();
    this.deps = {
      ...base,
      metadata: deps.metadata ?? new AssetMetadataService(),
      ...deps,
    };
  }

  private toResult(record: HorizonAssetRecord): AssetSearchResult {
    return {
      code: record.asset_code,
      issuer: record.asset_issuer,
      homeDomain: homeDomainFromToml(record),
      numAccounts: holderCount(record),
      verified: this.deps.verified.isVerified(record.asset_code, record.asset_issuer),
    };
  }

  async searchByCode(params: { code: string; limit: number; cursor?: string }): Promise<AssetSearchPage> {
    const { code, limit, cursor } = params;
    const records = await this.deps.fetchAssetsPage({ code, limit, cursor });
    const results = records.map((r) => this.toResult(r));

    if (!cursor) {
      const present = new Set(results.map((r) => r.issuer));
      const missing = this.deps.verified.issuersForCode(code).filter((issuer) => !present.has(issuer));
      const extra = await Promise.all(missing.map((issuer) => this.deps.fetchAsset(code, issuer)));
      for (const record of extra) {
        if (record) results.push(this.toResult(record));
      }
    }

    // Horizon pages are cursor-based on its own ordering, so the cursor is
    // the last *Horizon* record's token, not the last item after re-ranking.
    const nextCursor = records.length === limit ? records[records.length - 1].paging_token : null;
    return { results: rankResults(results), nextCursor };
  }

  async searchByDomain(domain: string): Promise<AssetSearchPage> {
    const currencies = await this.deps.metadata.listDomainCurrencies(domain);
    const homeDomain = domain.trim().toLowerCase();
    const results = currencies.map((c) => ({
      code: c.code,
      issuer: c.issuer,
      homeDomain,
      numAccounts: null,
      verified: this.deps.verified.isVerified(c.code, c.issuer),
    }));
    return { results: rankResults(results), nextCursor: null };
  }
}
