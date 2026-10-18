/**
 * Query-param parsing for GET /api/v1/account/:publicKey/history (#61).
 *
 * Each validator throws with a field-specific message so express-validator
 * reports it through the shared VALIDATION_ERROR envelope; the matching
 * `parse*` helpers turn the (already-validated) raw strings into a
 * `HistoryFilters` object.
 */
import { StrKey } from "@stellar/stellar-sdk";
import {
  AssetFilter,
  HISTORY_DIRECTIONS,
  HISTORY_ITEM_TYPES,
  HistoryDirection,
  HistoryFilters,
  HistoryItemType,
} from "../services/transactionHistory";

/** Max comma-separated values accepted for a list filter. */
const MAX_LIST_VALUES = 10;
const ASSET_CODE = /^[A-Za-z0-9]{1,12}$/;

function splitList(raw: unknown): string[] {
  if (typeof raw !== "string") throw new Error("must be a string");
  const values = raw.split(",").map((v) => v.trim()).filter(Boolean);
  if (values.length === 0) throw new Error("must not be empty");
  if (values.length > MAX_LIST_VALUES) throw new Error(`accepts at most ${MAX_LIST_VALUES} comma-separated values`);
  return values;
}

/** Checksum-validated (not just shape-checked) G... address. */
export function isValidAccountId(value: unknown): boolean {
  return typeof value === "string" && StrKey.isValidEd25519PublicKey(value);
}

function parseAssetToken(token: string): AssetFilter {
  if (token.toUpperCase() === "XLM" || token.toLowerCase() === "native") {
    return { kind: "native" };
  }
  const [code, issuer, ...rest] = token.split(":");
  if (rest.length > 0 || !ASSET_CODE.test(code)) {
    throw new Error(`"${token}" is not a valid asset; use XLM, CODE or CODE:ISSUER`);
  }
  if (issuer === undefined) return { kind: "code", code };
  if (!isValidAccountId(issuer)) {
    throw new Error(`"${token}" has an invalid issuer; it must be a valid G... address`);
  }
  return { kind: "exact", code, issuer };
}

export function validateAssetFilter(raw: unknown): true {
  splitList(raw).forEach(parseAssetToken);
  return true;
}

export function validateTypeFilter(raw: unknown): true {
  for (const v of splitList(raw)) {
    if (!HISTORY_ITEM_TYPES.includes(v as HistoryItemType)) {
      throw new Error(`"${v}" is not a valid type; expected one of ${HISTORY_ITEM_TYPES.join(", ")}`);
    }
  }
  return true;
}

export function validateDirectionFilter(raw: unknown): true {
  for (const v of splitList(raw)) {
    if (!HISTORY_DIRECTIONS.includes(v as HistoryDirection)) {
      throw new Error(`"${v}" is not a valid direction; expected one of ${HISTORY_DIRECTIONS.join(", ")}`);
    }
  }
  return true;
}

/** `until` must be after `since` when both are given. */
export function validateDateRange(until: unknown, since: unknown): true {
  if (typeof since === "string" && typeof until === "string" && Date.parse(until) <= Date.parse(since)) {
    throw new Error("until must be later than since");
  }
  return true;
}

export function parseHistoryFilters(query: Record<string, unknown>): HistoryFilters {
  const filters: HistoryFilters = {};
  if (typeof query.asset === "string") filters.assets = splitList(query.asset).map(parseAssetToken);
  if (typeof query.type === "string") filters.types = splitList(query.type) as HistoryItemType[];
  if (typeof query.direction === "string") {
    filters.directions = splitList(query.direction) as HistoryDirection[];
  }
  if (typeof query.since === "string") filters.since = new Date(query.since);
  if (typeof query.until === "string") filters.until = new Date(query.until);
  return filters;
}
