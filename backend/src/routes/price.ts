import { Router } from "express";
import {
  FX_BASE_CURRENCY,
  FxService,
  SUPPORTED_CURRENCIES,
  convertFromUsd,
  parseCurrency,
} from "../services/fx";

/**
 * Price routes. `?currency=` (#58) selects the fiat currency for `price`;
 * `price_usd` is always USD. Unsupported currencies → 400
 * UNSUPPORTED_CURRENCY with the supported list in `details.supported`.
 */
export function createPriceRouter(fx: FxService = new FxService()): Router {
  const router = Router();

  // Registered before /:asset so "currencies" isn't treated as an asset.
  router.get("/currencies", (_req, res) => {
    res.json({ base: FX_BASE_CURRENCY, currencies: [...SUPPORTED_CURRENCIES] });
  });

  // Placeholder — wire up CoinGecko / Stellar DEX orderbook in production
  router.get("/:asset", async (req, res, next) => {
    try {
      const currency = parseCurrency(req.query.currency, req.locale);
      const quote = await fx.getQuote(currency, req.locale);
      const priceUsd: string | null = null;
      const { asset } = req.params;
      res.json({
        asset: asset.toUpperCase(),
        currency,
        price: convertFromUsd(priceUsd, quote.rate),
        price_usd: priceUsd,
        fx: quote,
        source: "not_configured",
        message: "Connect a price oracle in src/routes/price.ts",
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export const priceRouter = createPriceRouter();
