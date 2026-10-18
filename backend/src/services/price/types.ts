import * as StellarSdk from "@stellar/stellar-sdk";
import { isValidIssuedAsset } from "../../validation/stellarAsset";

/** An asset as the price API understands it. */
export type PriceAsset = { type: "native" } | { type: "issued"; code: string; issuer: string };

/**
 * Where a price came from. `unavailable` means no provider could price the
 * asset (e.g. an illiquid token) — the API returns `price: null` rather
 * than inventing a number.
 */
export type PriceSource = "stellar_dex" | "coingecko" | "unavailable";

export interface PriceQuote {
  /** Canonical asset id: `XLM` or `CODE:ISSUER`. */
  asset: string;
  /** Decimal string, USD per one unit of `asset`; null when unavailable. */
  price: string | null;
  currency: "USD";
  source: PriceSource;
  /** ISO-8601 time the provider observed the price; null when unavailable. */
  updatedAt: string | null;
}

export interface ProviderQuote {
  price: string;
  updatedAt: string;
}

export interface PriceProvider {
  readonly name: Exclude<PriceSource, "unavailable">;
  /**
   * Prices as many of `assets` as this provider can. Assets it cannot
   * price are simply absent from the returned map (keyed by assetId) so
   * the next provider can try them. Throwing means "this provider is down"
   * and is treated the same as returning an empty map.
   */
  getPrices(assets: readonly PriceAsset[]): Promise<Map<string, ProviderQuote>>;
}

export function assetId(asset: PriceAsset): string {
  return asset.type === "native" ? "XLM" : `${asset.code}:${asset.issuer}`;
}

/**
 * Parses `XLM` / `native` (case-insensitive) or `CODE:ISSUER` (issuer
 * checksum-validated). Anything else — including a bare code like `USDC`,
 * which is ambiguous and exactly what a lookalike asset relies on — is
 * rejected by returning null.
 */
export function parseAssetId(raw: string): PriceAsset | null {
  const value = raw.trim();
  if (/^(xlm|native)$/i.test(value)) return { type: "native" };
  if (!isValidIssuedAsset(value)) return null;
  const [code, issuer] = value.split(":");
  return { type: "issued", code, issuer };
}

export function toSdkAsset(asset: PriceAsset): StellarSdk.Asset {
  return asset.type === "native" ? StellarSdk.Asset.native() : new StellarSdk.Asset(asset.code, asset.issuer);
}

/**
 * Formats a positive number as a plain decimal string (never exponent
 * notation), keeping 7 decimals for prices >= 1 and up to 12 below that so
 * sub-cent tokens don't collapse to "0".
 */
export function formatPrice(value: number): string {
  const fixed = value.toFixed(value >= 1 ? 7 : 12);
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}
