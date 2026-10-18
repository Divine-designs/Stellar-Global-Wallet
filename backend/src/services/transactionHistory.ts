/**
 * Display-ready transaction history (#59) and its filters (#61).
 *
 * Horizon's `/accounts/:id/operations` records are protocol-shaped: a
 * `path_payment_strict_send` doesn't say whether the viewing account sent
 * or received, a `create_account` names a `funder`/`account` pair instead
 * of a counterparty, and fee/memo live on the parent transaction. This
 * module turns one operation record (with its joined transaction) into a
 * `HistoryItem` a UI can render directly, and implements the client-side
 * filter + scan loop that Horizon can't do for us.
 *
 * Everything here is pure (no Horizon client) so it can be exercised with
 * recorded fixtures; `StellarService` owns the network calls.
 */
import type {
  AssetRef,
  HistoryDirection,
  HistoryItem,
  HistoryItemType,
  HistoryPage,
} from "@stellar-global-wallet/types";

export type { AssetRef, HistoryDirection, HistoryItem, HistoryItemType, HistoryPage };

export const HISTORY_ITEM_TYPES: readonly HistoryItemType[] = [
  "payment",
  "swap",
  "trustline",
  "account_created",
  "contract",
  "other",
];

export const HISTORY_DIRECTIONS: readonly HistoryDirection[] = ["in", "out", "self"];

/** Horizon's maximum `limit` for a single page. */
export const HORIZON_MAX_PAGE_SIZE = 200;

/**
 * The subset of a Horizon operation record this module reads. Typed
 * loosely on purpose: Horizon's operation union has ~27 members and the SDK
 * types don't cover every field Horizon actually returns (e.g.
 * `asset_balance_changes` on `invoke_host_function`).
 */
export interface HorizonOperationLike {
  id: string;
  paging_token: string;
  type: string;
  source_account: string;
  transaction_hash: string;
  created_at: string;
  transaction_successful?: boolean;
  [field: string]: unknown;
}

/** The subset of the joined parent transaction this module reads. */
export interface HorizonTransactionLike {
  fee_charged?: string | number;
  fee_account?: string;
  source_account?: string;
  memo?: string;
  memo_type?: string;
  operation_count?: number;
  successful?: boolean;
}

interface AssetBalanceChange {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  type?: string;
  from?: string;
  to?: string;
  amount?: string;
}

// ---------------------------------------------------------------------------
//  Small helpers
// ---------------------------------------------------------------------------

const STROOPS_PER_XLM = BigInt(10_000_000);

/** Convert an integer stroop amount to a 7-dp XLM decimal string, without float rounding. */
export function stroopsToXlm(stroops: string | number): string {
  const value = BigInt(stroops);
  const negative = value < BigInt(0);
  const abs = negative ? -value : value;
  const whole = abs / STROOPS_PER_XLM;
  const frac = (abs % STROOPS_PER_XLM).toString().padStart(7, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Build an AssetRef from Horizon's `<prefix>asset_type` / `_code` / `_issuer` triple. */
export function assetFromFields(
  record: Record<string, unknown>,
  prefix = ""
): AssetRef | null {
  const type = str(record[`${prefix}asset_type`]);
  if (!type) return null;
  if (type === "native") {
    return { id: "XLM", type: "native", code: "XLM", issuer: null };
  }
  if (type === "liquidity_pool_shares") {
    const poolId = str(record[`${prefix}liquidity_pool_id`]) ?? str(record.liquidity_pool_id) ?? "";
    return { id: `pool:${poolId}`, type, code: "POOL", issuer: null };
  }
  const code = str(record[`${prefix}asset_code`]) ?? "";
  const issuer = str(record[`${prefix}asset_issuer`]);
  return {
    id: issuer ? `${code}:${issuer}` : code,
    type: type as AssetRef["type"],
    code,
    issuer,
  };
}

/** Parse Horizon's canonical string form (`native` or `CODE:ISSUER`), used by claimable balances. */
function assetFromCanonical(value: unknown): AssetRef | null {
  const s = str(value);
  if (!s) return null;
  if (s === "native") return { id: "XLM", type: "native", code: "XLM", issuer: null };
  const [code, issuer] = s.split(":");
  return {
    id: s,
    type: code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
    code,
    issuer: issuer ?? null,
  };
}

function directionFor(account: string, from: string | null, to: string | null): HistoryDirection {
  if (from === account && to === account) return "self";
  if (from === account) return "out";
  if (to === account) return "in";
  // The account is involved some other way (e.g. it's the op source but
  // neither endpoint) — treat as its own action.
  return "self";
}

function counterpartyFor(account: string, from: string | null, to: string | null): string | null {
  if (from === account && to !== account) return to;
  if (to === account && from !== account) return from;
  return null;
}

// ---------------------------------------------------------------------------
//  Operation → HistoryItem
// ---------------------------------------------------------------------------

type Mapped = Pick<
  HistoryItem,
  | "type"
  | "direction"
  | "amount"
  | "asset"
  | "sourceAmount"
  | "sourceAsset"
  | "counterparty"
  | "trustlineLimit"
  | "contractFunction"
>;

const EMPTY: Omit<Mapped, "type" | "direction"> = {
  amount: null,
  asset: null,
  sourceAmount: null,
  sourceAsset: null,
  counterparty: null,
  trustlineLimit: null,
  contractFunction: null,
};

function mapPayment(op: HorizonOperationLike, account: string): Mapped {
  const from = str(op.from);
  const to = str(op.to);
  return {
    ...EMPTY,
    type: "payment",
    direction: directionFor(account, from, to),
    amount: str(op.amount),
    asset: assetFromFields(op),
    counterparty: counterpartyFor(account, from, to),
  };
}

/**
 * Path payments. When the account is both sender and receiver this is a
 * swap (convert asset A → B in one's own wallet): `amount`/`asset` is what
 * was received and `sourceAmount`/`sourceAsset` what was spent. Otherwise
 * it's a cross-asset payment and `amount`/`asset` is what *this account*
 * moved — the source side when sending, the destination side when receiving.
 */
function mapPathPayment(op: HorizonOperationLike, account: string): Mapped {
  const from = str(op.from);
  const to = str(op.to);
  const destAmount = str(op.amount);
  const destAsset = assetFromFields(op);
  const srcAmount = str(op.source_amount);
  const srcAsset = assetFromFields(op, "source_");
  const direction = directionFor(account, from, to);

  if (from === account && to === account) {
    return {
      ...EMPTY,
      type: "swap",
      direction: "self",
      amount: destAmount,
      asset: destAsset,
      sourceAmount: srcAmount,
      sourceAsset: srcAsset,
    };
  }

  return {
    ...EMPTY,
    type: "payment",
    direction,
    amount: direction === "out" ? srcAmount : destAmount,
    asset: direction === "out" ? srcAsset : destAsset,
    sourceAmount: srcAmount,
    sourceAsset: srcAsset,
    counterparty: counterpartyFor(account, from, to),
  };
}

function mapCreateAccount(op: HorizonOperationLike, account: string): Mapped {
  const funder = str(op.funder);
  const created = str(op.account);
  return {
    ...EMPTY,
    type: "account_created",
    direction: directionFor(account, funder, created),
    amount: str(op.starting_balance),
    asset: { id: "XLM", type: "native", code: "XLM", issuer: null },
    counterparty: counterpartyFor(account, funder, created),
  };
}

function mapChangeTrust(op: HorizonOperationLike, account: string): Mapped {
  const trustor = str(op.trustor) ?? op.source_account;
  return {
    ...EMPTY,
    type: "trustline",
    direction: trustor === account ? "self" : "in",
    asset: assetFromFields(op),
    trustlineLimit: str(op.limit),
    counterparty: trustor === account ? null : trustor,
  };
}

/**
 * Soroban invocations. Horizon attaches `asset_balance_changes` (SAC
 * transfers/mints/burns caused by the call); the first change that
 * touches the viewing account decides direction/amount/asset. With no
 * such change the call is reported as the account's own action.
 */
function mapInvokeHostFunction(op: HorizonOperationLike, account: string): Mapped {
  const changes = Array.isArray(op.asset_balance_changes)
    ? (op.asset_balance_changes as AssetBalanceChange[])
    : [];
  const relevant = changes.find((c) => c.from === account || c.to === account);
  const base: Mapped = {
    ...EMPTY,
    type: "contract",
    direction: "self",
    contractFunction: str(op.function),
    counterparty: str(op.address),
  };
  if (!relevant) return base;

  const from = str(relevant.from);
  const to = str(relevant.to);
  return {
    ...base,
    direction: directionFor(account, from, to),
    amount: str(relevant.amount),
    asset: assetFromFields(relevant as Record<string, unknown>),
    counterparty: counterpartyFor(account, from, to) ?? base.counterparty,
  };
}

function mapAccountMerge(op: HorizonOperationLike, account: string): Mapped {
  const from = str(op.account) ?? op.source_account;
  const to = str(op.into);
  return {
    ...EMPTY,
    type: "other",
    direction: directionFor(account, from, to),
    // The merged balance isn't on the operation record (only in effects).
    asset: { id: "XLM", type: "native", code: "XLM", issuer: null },
    counterparty: counterpartyFor(account, from, to),
  };
}

function mapOther(op: HorizonOperationLike, account: string): Mapped {
  // Some non-payment ops still carry a single amount/asset worth showing
  // (e.g. create_claimable_balance's `asset: "CODE:ISSUER"` + `amount`).
  const asset = assetFromFields(op) ?? assetFromCanonical(op.asset);
  return {
    ...EMPTY,
    type: "other",
    direction: op.source_account === account ? "self" : "in",
    amount: str(op.amount),
    asset,
    counterparty: op.source_account === account ? null : op.source_account,
  };
}

/**
 * Map one Horizon operation (+ its parent transaction, when joined) to a
 * HistoryItem from `account`'s point of view.
 */
export function mapOperationToHistoryItem(
  op: HorizonOperationLike,
  tx: HorizonTransactionLike | undefined,
  account: string
): HistoryItem {
  let mapped: Mapped;
  switch (op.type) {
    case "payment":
      mapped = mapPayment(op, account);
      break;
    case "path_payment_strict_send":
    case "path_payment_strict_receive":
    case "path_payment": // pre-protocol-12 name, still returned for old ledgers
      mapped = mapPathPayment(op, account);
      break;
    case "create_account":
      mapped = mapCreateAccount(op, account);
      break;
    case "change_trust":
      mapped = mapChangeTrust(op, account);
      break;
    case "invoke_host_function":
      mapped = mapInvokeHostFunction(op, account);
      break;
    case "account_merge":
      mapped = mapAccountMerge(op, account);
      break;
    default:
      mapped = mapOther(op, account);
  }

  const feeCharged = tx?.fee_charged;
  return {
    id: op.id,
    pagingToken: op.paging_token,
    operationType: op.type,
    ...mapped,
    memo: str(tx?.memo),
    memoType: str(tx?.memo_type),
    fee: feeCharged !== undefined && feeCharged !== null ? stroopsToXlm(feeCharged) : null,
    feePayer: str(tx?.fee_account) ?? str(tx?.source_account),
    transactionHash: op.transaction_hash,
    transactionOperationCount: typeof tx?.operation_count === "number" ? tx.operation_count : null,
    createdAt: op.created_at,
    successful: op.transaction_successful ?? tx?.successful ?? true,
  };
}

// ---------------------------------------------------------------------------
//  Filters (#61)
// ---------------------------------------------------------------------------

/**
 * `XLM` matches the native asset; `CODE` matches that code from any issuer;
 * `CODE:ISSUER` matches exactly.
 */
export type AssetFilter =
  | { kind: "native" }
  | { kind: "code"; code: string }
  | { kind: "exact"; code: string; issuer: string };

export interface HistoryFilters {
  assets?: AssetFilter[];
  types?: HistoryItemType[];
  directions?: HistoryDirection[];
  /** Inclusive lower bound on createdAt. */
  since?: Date;
  /** Exclusive upper bound on createdAt. */
  until?: Date;
}

export function hasActiveFilters(filters: HistoryFilters | undefined): boolean {
  if (!filters) return false;
  return Boolean(
    filters.assets?.length ||
      filters.types?.length ||
      filters.directions?.length ||
      filters.since ||
      filters.until
  );
}

function assetMatches(asset: AssetRef | null, filter: AssetFilter): boolean {
  if (!asset) return false;
  switch (filter.kind) {
    case "native":
      return asset.type === "native";
    case "code":
      return asset.type !== "native" && asset.code.toUpperCase() === filter.code.toUpperCase();
    case "exact":
      return asset.code === filter.code && asset.issuer === filter.issuer;
  }
}

/**
 * Whether an item passes every non-date filter. An item matches an asset
 * filter if either side of it does — so `asset=USDC` includes a swap from
 * XLM into USDC.
 */
export function matchesFilters(item: HistoryItem, filters: HistoryFilters): boolean {
  if (filters.types?.length && !filters.types.includes(item.type)) return false;
  if (filters.directions?.length && !filters.directions.includes(item.direction)) return false;
  if (filters.assets?.length) {
    const ok = filters.assets.some(
      (f) => assetMatches(item.asset, f) || assetMatches(item.sourceAsset, f)
    );
    if (!ok) return false;
  }
  const t = Date.parse(item.createdAt);
  if (filters.since && t < filters.since.getTime()) return false;
  if (filters.until && t >= filters.until.getTime()) return false;
  return true;
}

// ---------------------------------------------------------------------------
//  Scan loop (#61)
// ---------------------------------------------------------------------------

export type FetchHistoryPage = (
  cursor: string | undefined,
  pageSize: number
) => Promise<HistoryItem[]>;

/**
 * Collect up to `limit` matching items, newest first.
 *
 * Horizon can't filter operations by asset/type/date server-side, so with
 * filters active this pages through the account's operations (200 at a
 * time) until `limit` matches are found, the account's history runs out,
 * the scan passes `since` (records are newest-first, so nothing older can
 * match), or `scanCap` operations have been examined — in which case
 * `scanCapped: true` is returned with a `next` cursor that resumes the scan
 * exactly where it stopped.
 *
 * `next` is always the paging token of the last operation *examined*, not
 * the last one fetched, so stopping mid-page never skips records.
 *
 * Without filters this is a single Horizon request of `limit` records.
 */
export async function scanHistory(
  fetchPage: FetchHistoryPage,
  options: { limit: number; cursor?: string; filters?: HistoryFilters; scanCap: number }
): Promise<HistoryPage> {
  const { limit, filters, scanCap } = options;
  const filtered = hasActiveFilters(filters);
  const items: HistoryItem[] = [];
  let cursor = options.cursor;
  let scanned = 0;

  for (;;) {
    const remaining = scanCap - scanned;
    if (filtered && remaining <= 0) {
      return { items, next: cursor, hasMore: true, scanCapped: true, scanned };
    }

    const pageSize = filtered ? Math.min(HORIZON_MAX_PAGE_SIZE, remaining) : limit;
    const page = await fetchPage(cursor, pageSize);

    for (const item of page) {
      scanned++;
      cursor = item.pagingToken;

      if (filters?.since && Date.parse(item.createdAt) < filters.since.getTime()) {
        // Newest-first: every remaining record is older than `since` too.
        return { items, next: undefined, hasMore: false, scanCapped: false, scanned };
      }

      if (!filtered || matchesFilters(item, filters!)) {
        items.push(item);
        if (items.length === limit) {
          return { items, next: cursor, hasMore: true, scanCapped: false, scanned };
        }
      }
    }

    if (page.length < pageSize) {
      return { items, next: undefined, hasMore: false, scanCapped: false, scanned };
    }
  }
}

// ---------------------------------------------------------------------------
//  Explorer links (#60)
// ---------------------------------------------------------------------------

const PUBLIC_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

/**
 * stellar.expert URL for a transaction on the configured network, or null
 * for networks stellar.expert doesn't index (futurenet, standalone).
 */
export function explorerTxUrl(networkPassphrase: string, hash: string): string | null {
  const network =
    networkPassphrase === PUBLIC_PASSPHRASE
      ? "public"
      : networkPassphrase === TESTNET_PASSPHRASE
        ? "testnet"
        : null;
  return network ? `https://stellar.expert/explorer/${network}/tx/${hash}` : null;
}
