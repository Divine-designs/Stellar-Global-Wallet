import { AppError, HorizonError } from "../errors/appError";

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
