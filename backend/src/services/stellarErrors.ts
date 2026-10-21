import { AppError, HorizonError, NotFoundError } from "../errors/appError";

export class SequenceConflictError extends HorizonError {
  constructor(message: string, readonly horizonResultCodes?: unknown) {
    super(message, {
      code: "SEQUENCE_CONFLICT",
      details: horizonResultCodes ? { horizonResultCodes } : undefined,
      retryable: true,
      status: 409,
    });
  }
}

export class MemoRequiredError extends AppError {
  constructor(message: string) {
    super(message, {
      code: "MEMO_REQUIRED",
      retryable: false,
      status: 400,
    });
  }
}

export class LockAcquisitionError extends AppError {
  constructor(message: string) {
    super(message, {
      code: "LOCK_TIMEOUT",
      retryable: true,
      status: 503,
    });
  }
}

export class NonRetryableHorizonError extends HorizonError {
  constructor(message: string, readonly horizonResultCodes?: unknown) {
    super(message, {
      code: "HORIZON_REJECTED",
      details: horizonResultCodes ? { horizonResultCodes } : undefined,
      retryable: false,
      status: 400,
    });
  }
}

/**
 * #65 — the destination account does not exist on the network and the
 * payment can't create it: only native XLM can fund a new account, and only
 * via `createAccount` with at least the minimum starting balance (1 XLM).
 * `details.reason` is `NON_NATIVE_ASSET` or `BELOW_MINIMUM_STARTING_BALANCE`
 * so clients can show the right fix without parsing `error`.
 */
export class DestinationNotFundedError extends AppError {
  constructor(
    message: string,
    details: {
      reason: "NON_NATIVE_ASSET" | "BELOW_MINIMUM_STARTING_BALANCE";
      destination: string;
      minimumStartingBalance: string;
    }
  ) {
    super(message, {
      code: "DESTINATION_NOT_FUNDED",
      details,
      retryable: false,
      status: 400,
    });
  }
}

/**
 * The unsigned-XDR build endpoints need the source account's current
 * sequence number, so an account that doesn't exist yet can't be built for.
 * Distinct from the generic ACCOUNT_NOT_FOUND so the client can tell "fund
 * your wallet first" apart from "that recipient doesn't exist".
 */
export class SourceAccountNotFoundError extends NotFoundError {
  constructor(sourcePublicKey: string) {
    super(
      `Source account ${sourcePublicKey} does not exist on the network. Fund it before building a transaction.`,
      "SOURCE_ACCOUNT_NOT_FOUND",
      { source: sourcePublicKey }
    );
  }
}

/**
 * #21 — user-facing copy for the Horizon result codes this service maps into
 * `HORIZON_REJECTED` / `SEQUENCE_CONFLICT` errors. Kept next to the error
 * classes so the catalogue in `docs/error-codes.md` stays in sync with the
 * codes the backend actually emits. Messages avoid technical jargon.
 */
export const HORIZON_RESULT_CODE_MESSAGES: Record<string, string> = {
  tx_bad_seq: "Something changed, please try again.",
  tx_insufficient_fee: "The network fee was too low. Please try again.",
  tx_insufficient_balance: "There isn't enough balance to cover this payment.",
  tx_no_source_account: "We couldn't find the sending account. Please sign in again.",
  tx_no_destination: "The receiving account doesn't exist yet.",
  tx_too_late: "This request took too long and expired. Please try again.",
  tx_too_early: "This request isn't valid yet. Please try again in a moment.",
  tx_missing_operation: "The payment details were incomplete. Please try again.",
  tx_bad_auth: "We couldn't confirm your authorization. Please sign in again.",
  tx_bad_auth_extra: "We couldn't confirm your authorization. Please sign in again.",
  op_underfunded: "There isn't enough balance to cover this payment.",
  op_no_destination: "The receiving account doesn't exist yet.",
  op_no_trust: "The receiving account can't hold this asset yet.",
  op_line_full: "The receiving account can't hold any more of this asset.",
  op_malformed: "The payment details were incomplete. Please try again.",
  op_already_exists: "This account already exists.",
  op_low_reserve: "This account needs a higher balance before it can do that.",
};
