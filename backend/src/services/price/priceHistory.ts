import * as StellarSdk from "@stellar/stellar-sdk";
import { HorizonError } from "../../errors/appError";
import { TtlCache } from "../ttlCache";
import { PriceAsset, assetId, toSdkAsset } from "./types";
import { UsdQuoteAsset, isUsdQuoteAsset } from "./usdQuote";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Supported chart ranges (#57). `resolution` is the Horizon trade-
 * aggregation bucket we fetch; `step` is the spacing of returned points
 * (a multiple of `resolution` — finer buckets are folded into it). Every
 * range returns exactly `points` points (≤ 200).
 */
export const HISTORY_RANGES = {
  "24h": { resolution: "1h", resolutionMs: HOUR, stepMs: HOUR, points: 24, cacheTtlMs: MINUTE },
  "7d": { resolution: "1h", resolutionMs: HOUR, stepMs: HOUR, points: 168, cacheTtlMs: 5 * MINUTE },
  "30d": { resolution: "1h", resolutionMs: HOUR, stepMs: 4 * HOUR, points: 180, cacheTtlMs: 15 * MINUTE },
  "1y": { resolution: "1d", resolutionMs: DAY, stepMs: 2 * DAY, points: 183, cacheTtlMs: HOUR },
} as const;

export type HistoryRange = keyof typeof HISTORY_RANGES;

export function isHistoryRange(value: unknown): value is HistoryRange {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(HISTORY_RANGES, value);
}

export interface HistoryPoint {
  /** ISO-8601 start of the point's interval. */
  t: string;
  /** Last traded price (USD) at or before the end of this interval, or null. */
  price: string | null;
  /** True when no trade happened in this interval and `price` was carried forward. */
  filled: boolean;
}

export interface PriceHistory {
  asset: string;
  currency: "USD";
  range: HistoryRange;
  resolution: string;
  intervalSeconds: number;
  source: "stellar_dex" | "unavailable";
  from: string;
  to: string;
  points: HistoryPoint[];
}

export interface AggregationRecord {
  timestamp: number | string;
  close: string;
}

/**
 * Folds trade-aggregation buckets (ascending) onto a fixed grid of
 * `points` intervals of `stepMs` starting at `startMs`. Each point takes
 * the close of the last bucket inside it. Intervals with no trades carry
 * the previous point's price forward (`filled: true`); intervals before
 * the first trade in the window are `null`.
 */
export function downsample(
  records: readonly AggregationRecord[],
  startMs: number,
  stepMs: number,
  points: number
): HistoryPoint[] {
  const closes: (string | null)[] = new Array(points).fill(null);
  for (const record of records) {
    const index = Math.floor((Number(record.timestamp) - startMs) / stepMs);
    if (index >= 0 && index < points) closes[index] = record.close;
  }

  let last: string | null = null;
  return closes.map((close, i) => {
    const t = new Date(startMs + i * stepMs).toISOString();
    if (close !== null) {
      last = close;
      return { t, price: close, filled: false };
    }
    return { t, price: last, filled: last !== null };
  });
}

/** Historical USD price series from Horizon `/trade_aggregations` vs USDC. */
export class PriceHistoryService {
  private readonly cache = new TtlCache<PriceHistory>(MINUTE);
  private readonly quote: StellarSdk.Asset;

  constructor(
    private readonly horizon: StellarSdk.Horizon.Server,
    private readonly usdQuote: UsdQuoteAsset,
    private readonly now: () => number = Date.now
  ) {
    this.quote = new StellarSdk.Asset(usdQuote.code, usdQuote.issuer);
  }

  async getHistory(asset: PriceAsset, range: HistoryRange): Promise<PriceHistory> {
    const spec = HISTORY_RANGES[range];
    // Grid end is the next step boundary so the newest point covers the
    // in-progress interval. Epoch-aligned steps are also aligned to the
    // Horizon resolution, which Horizon requires of start/end times.
    const endMs = Math.ceil(this.now() / spec.stepMs) * spec.stepMs;
    const startMs = endMs - spec.points * spec.stepMs;
    const id = assetId(asset);
    const cacheKey = `${id}|${range}|${startMs}`;

    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    let points: HistoryPoint[];
    if (asset.type === "issued" && isUsdQuoteAsset(asset.code, asset.issuer, this.usdQuote)) {
      points = downsample([], startMs, spec.stepMs, spec.points).map((p) => ({ ...p, price: "1" }));
    } else {
      const records = await this.fetchAggregations(asset, startMs, endMs, spec.resolutionMs);
      points = downsample(records, startMs, spec.stepMs, spec.points);
    }

    const history: PriceHistory = {
      asset: id,
      currency: "USD",
      range,
      resolution: spec.resolution,
      intervalSeconds: spec.stepMs / 1000,
      source: points.some((p) => p.price !== null) ? "stellar_dex" : "unavailable",
      from: new Date(startMs).toISOString(),
      to: new Date(endMs).toISOString(),
      points,
    };
    this.cache.set(cacheKey, history, spec.cacheTtlMs);
    return history;
  }

  private async fetchAggregations(
    asset: PriceAsset,
    startMs: number,
    endMs: number,
    resolutionMs: number
  ): Promise<AggregationRecord[]> {
    const PAGE = 200;
    const maxPages = Math.ceil((endMs - startMs) / resolutionMs / PAGE) + 1;
    const records: AggregationRecord[] = [];

    try {
      let page = await this.horizon
        .tradeAggregation(toSdkAsset(asset), this.quote, startMs, endMs, resolutionMs, 0)
        .limit(PAGE)
        .order("asc")
        .call();
      for (let i = 0; i < maxPages && page.records.length > 0; i++) {
        records.push(...page.records);
        if (page.records.length < PAGE) break;
        page = await page.next();
      }
    } catch (err) {
      console.error(`[price] trade_aggregations failed for ${assetId(asset)}:`, (err as Error).message);
      throw new HorizonError("Price history is temporarily unavailable", {
        code: "PRICE_HISTORY_UNAVAILABLE",
        retryable: true,
        status: 502,
      });
    }
    return records;
  }
}
