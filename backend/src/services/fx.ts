/**
 * Fiat FX rates for local-currency price display (#58).
 *
 * Rates are USD-based (one request returns every quote currency) and
 * cached in-process for FX_CACHE_TTL_MS (default 1h) — FX moves slowly
 * relative to how often price routes are hit, and the free upstream is
 * rate-limited. Concurrent cache misses share one in-flight request. If a
 * refresh fails and a previous rate set exists, it's served with
 * `stale: true` rather than failing the request; with nothing cached the
 * caller gets a retryable 503 FX_UNAVAILABLE.
 */
import { config } from "../config";
import { AppError } from "../errors/appError";
import { tError } from "./i18nHelper";

/**
 * Currencies accepted by `?currency=`. A fixed list (rather than "whatever
 * the upstream returns") so validation never needs a network call and the
 * set clients can rely on doesn't change when the provider does.
 */
export const SUPPORTED_CURRENCIES = [
  "USD", "EUR", "GBP", "NGN", "KES", "GHS", "ZAR", "EGP", "MAD", "UGX",
  "TZS", "XOF", "XAF", "BRL", "MXN", "ARS", "COP", "CLP", "PEN", "CAD",
  "INR", "PKR", "BDT", "PHP", "IDR", "VND", "THB", "MYR", "SGD", "CNY",
  "JPY", "KRW", "AUD", "NZD", "TRY", "AED", "SAR", "CHF", "SEK", "NOK",
] as const;

export type FiatCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export const FX_BASE_CURRENCY: FiatCurrency = "USD";

export function isSupportedCurrency(value: string): value is FiatCurrency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

export class UnsupportedCurrencyError extends AppError {
  constructor(currency: string, locale = "en") {
    super(
      tError("UNSUPPORTED_CURRENCY", locale, {
        currency,
        supported: SUPPORTED_CURRENCIES.join(", "),
      }),
      {
        code: "UNSUPPORTED_CURRENCY",
        status: 400,
        details: { currency, supported: [...SUPPORTED_CURRENCIES] },
      }
    );
  }
}

export class FxUnavailableError extends AppError {
  constructor(locale = "en") {
    super(tError("FX_UNAVAILABLE", locale), { code: "FX_UNAVAILABLE", status: 503, retryable: true });
  }
}

/**
 * Validate a raw `?currency=` value (case-insensitive). Absent → USD.
 * Throws UnsupportedCurrencyError (400) for anything not in the list.
 */
export function parseCurrency(raw: unknown, locale = "en"): FiatCurrency {
  if (raw === undefined || raw === "") return FX_BASE_CURRENCY;
  const value = typeof raw === "string" ? raw.trim().toUpperCase() : String(raw);
  if (!isSupportedCurrency(value)) throw new UnsupportedCurrencyError(value, locale);
  return value;
}

export interface FxQuote {
  base: FiatCurrency;
  quote: FiatCurrency;
  /** Units of `quote` per 1 `base`, as a decimal string. */
  rate: string;
  source: string;
  /** When the upstream last updated this rate (ISO 8601). */
  updatedAt: string;
  /** True when served from cache after a failed refresh. */
  stale: boolean;
}

interface RateSet {
  rates: Record<string, number>;
  updatedAt: string;
  fetchedAt: number;
}

interface ErApiResponse {
  result?: string;
  base_code?: string;
  time_last_update_unix?: number;
  rates?: Record<string, number>;
}

type FetchFn = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class FxService {
  private cache: RateSet | undefined;
  private inflight: Promise<RateSet> | undefined;

  constructor(
    private readonly fetchFn: FetchFn = (url) => fetch(url),
    private readonly url: string = config.FX_API_URL,
    private readonly ttlMs: number = config.FX_CACHE_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  /** USD → `currency` rate. USD itself never hits the network. */
  async getQuote(currency: FiatCurrency, locale = "en"): Promise<FxQuote> {
    if (currency === FX_BASE_CURRENCY) {
      return {
        base: FX_BASE_CURRENCY,
        quote: currency,
        rate: "1",
        source: "identity",
        updatedAt: new Date(this.now()).toISOString(),
        stale: false,
      };
    }

    let set: RateSet;
    let stale = false;
    try {
      set = await this.getRates();
    } catch (err) {
      if (!this.cache) {
        console.warn(`[fx] rate fetch failed with no cached rates: ${err}`);
        throw new FxUnavailableError(locale);
      }
      console.warn(`[fx] rate refresh failed, serving stale rates: ${err}`);
      set = this.cache;
      stale = true;
    }

    const rate = set.rates[currency];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
      // Supported by us but missing upstream — treat as unavailable rather
      // than inventing a rate.
      throw new FxUnavailableError(locale);
    }

    return {
      base: FX_BASE_CURRENCY,
      quote: currency,
      rate: String(rate),
      source: new URL(this.url).host,
      updatedAt: set.updatedAt,
      stale,
    };
  }

  private async getRates(): Promise<RateSet> {
    if (this.cache && this.now() - this.cache.fetchedAt < this.ttlMs) {
      return this.cache;
    }
    if (!this.inflight) {
      this.inflight = this.fetchRates().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private async fetchRates(): Promise<RateSet> {
    const res = await this.fetchFn(this.url);
    if (!res.ok) throw new Error(`FX upstream responded ${res.status}`);
    const body = (await res.json()) as ErApiResponse;
    if (body.result !== "success" || body.base_code !== FX_BASE_CURRENCY || !body.rates) {
      throw new Error("FX upstream returned an unexpected payload");
    }
    const set: RateSet = {
      rates: body.rates,
      updatedAt: body.time_last_update_unix
        ? new Date(body.time_last_update_unix * 1000).toISOString()
        : new Date(this.now()).toISOString(),
      fetchedAt: this.now(),
    };
    this.cache = set;
    return set;
  }
}

/**
 * Convert a USD decimal string with an FX rate. Display precision only
 * (float multiply, 2–7 dp) — never use the result for settlement.
 */
export function convertFromUsd(amountUsd: string | null, rate: string): string | null {
  if (amountUsd === null) return null;
  const value = Number(amountUsd) * Number(rate);
  if (!Number.isFinite(value)) return null;
  return value >= 1 ? value.toFixed(2) : value.toFixed(7);
}
