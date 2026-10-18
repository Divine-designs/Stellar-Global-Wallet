import { TtlCache } from "../ttlCache";
import { PriceAsset, PriceProvider, PriceQuote, assetId } from "./types";

/**
 * Spot prices with provider fallback and a shared TTL cache (#55, #56).
 *
 * For each asset not in the cache, providers are tried in order; the first
 * one that prices it wins. Providers receive every still-unpriced asset in
 * one call, so a batch of 50 misses costs one CoinGecko request rather
 * than 50. Concurrent requests for the same uncached asset share one
 * upstream lookup. Assets no provider can price are returned (and cached)
 * as `{ price: null, source: "unavailable" }`.
 */
export class PriceService {
  private readonly cache: TtlCache<PriceQuote>;
  private readonly inFlight = new Map<string, Promise<PriceQuote>>();

  constructor(
    private readonly providers: readonly PriceProvider[],
    ttlMs: number,
    now: () => number = Date.now
  ) {
    this.cache = new TtlCache<PriceQuote>(ttlMs, now);
  }

  async getPrice(asset: PriceAsset): Promise<PriceQuote> {
    const [quote] = await this.getPrices([asset]);
    return quote;
  }

  /** Returns one quote per input asset, in input order. Callers dedupe. */
  async getPrices(assets: readonly PriceAsset[]): Promise<PriceQuote[]> {
    const pending = new Map<string, Promise<PriceQuote>>();
    const misses: PriceAsset[] = [];

    for (const asset of assets) {
      const id = assetId(asset);
      if (pending.has(id)) continue;
      const cached = this.cache.get(id);
      if (cached) {
        pending.set(id, Promise.resolve(cached));
        continue;
      }
      const inFlight = this.inFlight.get(id);
      if (inFlight) {
        pending.set(id, inFlight);
        continue;
      }
      misses.push(asset);
    }

    if (misses.length > 0) {
      const lookup = this.resolve(misses);
      for (const asset of misses) {
        const id = assetId(asset);
        const promise = lookup.then((byId) => byId.get(id) as PriceQuote);
        this.inFlight.set(id, promise);
        pending.set(id, promise);
      }
      lookup.finally(() => {
        for (const asset of misses) this.inFlight.delete(assetId(asset));
      }).catch(() => undefined);
    }

    return Promise.all(assets.map((asset) => pending.get(assetId(asset)) as Promise<PriceQuote>));
  }

  /** Drops one asset's cached price (or all of them). */
  invalidate(asset?: PriceAsset): void {
    if (asset) this.cache.delete(assetId(asset));
    else this.cache.clear();
  }

  private async resolve(assets: readonly PriceAsset[]): Promise<Map<string, PriceQuote>> {
    const result = new Map<string, PriceQuote>();
    let remaining = [...assets];

    for (const provider of this.providers) {
      if (remaining.length === 0) break;
      try {
        const quotes = await provider.getPrices(remaining);
        for (const [id, quote] of quotes) {
          result.set(id, { asset: id, price: quote.price, currency: "USD", source: provider.name, updatedAt: quote.updatedAt });
        }
      } catch (err) {
        console.error(`[price] provider ${provider.name} failed:`, (err as Error).message);
      }
      remaining = remaining.filter((asset) => !result.has(assetId(asset)));
    }

    for (const asset of remaining) {
      const id = assetId(asset);
      result.set(id, { asset: id, price: null, currency: "USD", source: "unavailable", updatedAt: null });
    }
    for (const quote of result.values()) this.cache.set(quote.asset, quote);
    return result;
  }
}
