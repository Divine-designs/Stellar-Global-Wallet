import { NextFunction, Request, Response, Router } from "express";
import { ValidationError } from "../errors/appError";
import {
  HISTORY_RANGES,
  PriceAsset,
  PriceHistoryService,
  PriceService,
  assetId,
  isHistoryRange,
  parseAssetId,
} from "../services/price";

/** Max distinct-or-not entries accepted in one batch lookup (#56). */
export const MAX_BATCH_ASSETS = 50;

const ASSET_MESSAGE = "must be XLM or CODE:ISSUER with a valid Stellar issuer (G...)";

function parseAssetParam(raw: string, location: "params" | "query", path: string): PriceAsset {
  const asset = parseAssetId(raw);
  if (!asset) {
    throw new ValidationError([{ location, path, message: ASSET_MESSAGE, value: raw }]);
  }
  return asset;
}

/**
 * Parses `?assets=XLM,USDC:GA5Z...`: rejects (rather than skips) any
 * malformed entry, caps the list at MAX_BATCH_ASSETS entries, and removes
 * duplicates while keeping first-occurrence order.
 */
export function parseBatchAssets(raw: unknown): PriceAsset[] {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ValidationError([
      { location: "query", path: "assets", message: "assets is required: a comma-separated list, e.g. XLM,USDC:G..." },
    ]);
  }

  const entries = raw.split(",").map((e) => e.trim());
  if (entries.length > MAX_BATCH_ASSETS) {
    throw new ValidationError([
      { location: "query", path: "assets", message: `at most ${MAX_BATCH_ASSETS} assets per request` },
    ]);
  }

  const issues = entries.flatMap((entry, i) =>
    parseAssetId(entry) ? [] : [{ location: "query", path: `assets[${i}]`, message: ASSET_MESSAGE, value: entry }]
  );
  if (issues.length > 0) throw new ValidationError(issues);

  const unique = new Map<string, PriceAsset>();
  for (const entry of entries) {
    const asset = parseAssetId(entry) as PriceAsset;
    if (!unique.has(assetId(asset))) unique.set(assetId(asset), asset);
  }
  return [...unique.values()];
}

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

/**
 * Price routes (#55, #56, #57). Public and unauthenticated: prices are the
 * same for every caller and carry no account data. See docs/prices.md.
 */
export function createPriceRouter(prices: PriceService, history: PriceHistoryService): Router {
  const router = Router();

  // GET /api/v1/price?assets=XLM,USDC:G...  (#56)
  router.get(
    "/",
    wrap(async (req, res) => {
      const assets = parseBatchAssets(req.query.assets);
      const quotes = await prices.getPrices(assets);
      res.set("Cache-Control", "public, max-age=30");
      res.json({ currency: "USD", prices: quotes });
    })
  );

  // GET /api/v1/price/:asset/history?range=24h|7d|30d|1y  (#57)
  router.get(
    "/:asset/history",
    wrap(async (req, res) => {
      const asset = parseAssetParam(req.params.asset, "params", "asset");
      const range = req.query.range ?? "7d";
      if (!isHistoryRange(range)) {
        throw new ValidationError([
          {
            location: "query",
            path: "range",
            message: `must be one of ${Object.keys(HISTORY_RANGES).join(", ")}`,
            value: range,
          },
        ]);
      }
      const series = await history.getHistory(asset, range);
      res.set("Cache-Control", `public, max-age=${Math.floor(HISTORY_RANGES[range].cacheTtlMs / 1000)}`);
      res.json(series);
    })
  );

  // GET /api/v1/price/:asset  (#55)
  router.get(
    "/:asset",
    wrap(async (req, res) => {
      const asset = parseAssetParam(req.params.asset, "params", "asset");
      const quote = await prices.getPrice(asset);
      res.set("Cache-Control", "public, max-age=30");
      res.json(quote);
    })
  );

  return router;
}
