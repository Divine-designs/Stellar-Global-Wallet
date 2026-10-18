import { PriceAsset, PriceProvider, ProviderQuote, assetId, formatPrice } from "./types";

export interface CoinGeckoProviderOptions {
  baseUrl: string;
  apiKey?: string;
  /**
   * Maps an asset to its CoinGecko coin id, or undefined if it must not be
   * priced here. Issued assets are only mapped via the verified-asset list
   * (#54): pricing by bare code would quote a scam "USDC" at $1.
   */
  coinIdFor: (asset: PriceAsset) => string | undefined;
  timeoutMs?: number;
  /** Cooldown after a 429 when the response has no Retry-After header. */
  defaultCooldownMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface SimplePriceEntry {
  usd?: number;
  last_updated_at?: number;
}

/**
 * Fallback price source: CoinGecko `/simple/price`, one request for the
 * whole batch. The free tier is rate limited, so a 429 puts the provider
 * into a cooldown (Retry-After, else 60 s) during which it returns nothing
 * and the remaining assets come back as `unavailable` instead of hammering
 * the API and extending the ban.
 */
export class CoinGeckoProvider implements PriceProvider {
  readonly name = "coingecko" as const;
  private cooldownUntil = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: CoinGeckoProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async getPrices(assets: readonly PriceAsset[]): Promise<Map<string, ProviderQuote>> {
    const out = new Map<string, ProviderQuote>();
    if (this.now() < this.cooldownUntil) return out;

    const idsByAsset = new Map<string, string>();
    for (const asset of assets) {
      const coinId = this.options.coinIdFor(asset);
      if (coinId) idsByAsset.set(assetId(asset), coinId);
    }
    if (idsByAsset.size === 0) return out;

    const url = new URL(`${this.options.baseUrl.replace(/\/$/, "")}/simple/price`);
    url.searchParams.set("ids", [...new Set(idsByAsset.values())].join(","));
    url.searchParams.set("vs_currencies", "usd");
    url.searchParams.set("include_last_updated_at", "true");

    const headers: Record<string, string> = { accept: "application/json" };
    if (this.options.apiKey) headers["x-cg-demo-api-key"] = this.options.apiKey;

    const res = await this.fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
    });

    if (res.status === 429) {
      const retryAfter = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
      const cooldownMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : this.options.defaultCooldownMs ?? 60_000;
      this.cooldownUntil = this.now() + cooldownMs;
      throw new Error(`CoinGecko rate limited; cooling down for ${cooldownMs} ms`);
    }
    if (!res.ok) {
      throw new Error(`CoinGecko responded ${res.status}`);
    }

    const body = (await res.json()) as Record<string, SimplePriceEntry | undefined>;
    for (const [id, coinId] of idsByAsset) {
      const entry = body[coinId];
      if (typeof entry?.usd !== "number" || !(entry.usd > 0)) continue;
      const updatedAt = typeof entry.last_updated_at === "number"
        ? new Date(entry.last_updated_at * 1000).toISOString()
        : new Date(this.now()).toISOString();
      out.set(id, { price: formatPrice(entry.usd), updatedAt });
    }
    return out;
  }
}
