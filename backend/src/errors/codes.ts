/**
 * Single source of truth for every error code the backend can emit.
 *
 * The SDK derives its `ErrorCode` union from this list so UI code can
 * exhaustively `switch (err.code)` and catch removed/renamed codes at
 * compile time.
 */
export const ERROR_CODES = [
  // Generic / transport
  "INTERNAL_ERROR",
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "RATE_LIMITED",
  "BAD_REQUEST",

  // Accounts
  "ACCOUNT_NOT_FOUND",
  "ACCOUNT_NOT_FUNDED",
  "SOURCE_ACCOUNT_NOT_FOUND",
  "INSUFFICIENT_BALANCE",
  "INSUFFICIENT_RESERVE",
  "ASSET_ISSUER_NOT_FOUND",
  "ASSET_ALREADY_ADDED",
  "ASSET_HAS_ACTIVE_SPEND_LIMIT",
  "TRUSTLINE_NOT_FOUND",
  "TRUSTLINE_HAS_BALANCE",

  // Transactions
  "TRANSACTION_FAILED",
  "TRANSACTION_NOT_FOUND",
  "INVALID_TRANSACTION",
  "INSUFFICIENT_FEE",
  "TIMEOUT",
  "TX_EXPIRED",
  "TX_ALREADY_SUBMITTED",
  "PATH_EXPIRED",
  "DESTINATION_NO_TRUSTLINE",

  // Horizon result codes (mapped to a fixed set)
  "HORIZON_ERROR",
  "HORIZON_TX_INSUFFICIENT_BALANCE",
  "HORIZON_TX_NO_DESTINATION",
  "HORIZON_TX_BAD_SEQUENCE",
  "HORIZON_TX_TOO_EARLY",
  "HORIZON_TX_TOO_LATE",
  "HORIZON_TX_MISSING_OPERATION",
  "HORIZON_TX_BAD_AUTH",
  "HORIZON_TX_INSUFFICIENT_FEE",
  "HORIZON_OP_NO_ACCOUNT",
  "HORIZON_OP_LOW_RESERVE",
  "HORIZON_OP_LINE_FULL",
  "HORIZON_OP_UNDERFUNDED",

  // Soroban / contracts
  "SOROBAN_ERROR",
  "CONTRACT_ERROR",
  "CONTRACT_NOT_FOUND",
  "CONTRACT_INVOCATION_FAILED",
  "SOROBAN_UNAVAILABLE",
  "SOROBAN_REBUILD_REQUIRED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}
