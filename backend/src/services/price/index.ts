import * as StellarSdk from "@stellar/stellar-sdk";
import { config } from "../../config";
import { findVerifiedAsset } from "../verifiedAssets";
import { CoinGeckoProvider } from "./coinGeckoProvider";
import { PriceHistoryService } from "./priceHistory";
import { PriceService } from "./priceService";
import { StellarDexProvider } from "./stellarDexProvider";
import { PriceAsset, PriceProvider } from "./types";
import { resolveUsdQuoteAsset } from "./usdQuote";

export * from "./types";
export { PriceService } from "./priceService";
export { PriceHistoryService, HISTORY_RANGES, isHistoryRange, downsample } from "./priceHistory";
export type { HistoryRange, PriceHistory, HistoryPoint } from "./priceHistory";

/** Only XLM and verified assets with a `coingeckoId` are priced via CoinGecko. */
export function coinGeckoIdFor(asset: PriceAsset): string | undefined {
  if (asset.type === "native") return "stellar";
  return findVerifiedAsset(asset.code, asset.issuer)?.coingeckoId;
}

/** Wires providers in PRICE_PROVIDERS order from the environment config. */
export function createDefaultPriceServices(): { prices: PriceService; history: PriceHistoryService } {
  const horizon = new StellarSdk.Horizon.Server(config.HORIZON_URL);
  const usdQuote = resolveUsdQuoteAsset();

  const available: Record<string, () => PriceProvider> = {
    stellar_dex: () => new StellarDexProvider(horizon, usdQuote),
    coingecko: () =>
      new CoinGeckoProvider({
        baseUrl: config.COINGECKO_BASE_URL,
        apiKey: config.COINGECKO_API_KEY,
        coinIdFor: coinGeckoIdFor,
      }),
  };

  const providers = config.PRICE_PROVIDERS.split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => {
      const make = available[name];
      if (!make) throw new Error(`Unknown price provider "${name}" in PRICE_PROVIDERS`);
      return make();
    });

  return {
    prices: new PriceService(providers, config.PRICE_CACHE_TTL_SECONDS * 1000),
    history: new PriceHistoryService(horizon, usdQuote),
  };
}
