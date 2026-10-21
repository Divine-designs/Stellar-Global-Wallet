import { AppError, ErrorCode } from "../errors/appError";

export class SorobanNotConfiguredError extends AppError {
  constructor(message = "Soroban contract integration is not configured (missing contract ID)") {
    super(message, {
      code: "SOROBAN_NOT_CONFIGURED",
      retryable: false,
      status: 503,
    });
  }
}

export class SorobanSimulationError extends AppError {
  constructor(message: string, readonly raw?: string) {
    super(message, {
      code: "SOROBAN_SIMULATION_FAILED",
      details: raw ? { raw } : undefined,
      retryable: false,
      status: 422,
    });
  }
}

export class SorobanTransactionError extends AppError {
  constructor(message: string, readonly hash: string) {
    super(message, {
      code: "SOROBAN_TX_FAILED",
      details: { hash },
      retryable: false,
      status: 502,
    });
  }
}

/** Soroban RPC couldn't be reached (or is shedding load). Safe to retry. */
export class SorobanUnavailableError extends AppError {
  constructor(message = "Soroban RPC is unavailable. Try again shortly.") {
    super(message, {
      code: "SOROBAN_UNAVAILABLE",
      retryable: true,
      status: 503,
    });
  }
}

/**
 * The prepared transaction no longer fits the ledger — e.g. `txSorobanInvalid`
 * because the footprint changed after simulation, or the sequence moved. The
 * client must rebuild (which re-simulates) and sign again.
 */
export class SorobanRebuildRequiredError extends AppError {
  constructor(message: string, readonly resultCode: string) {
    super(message, {
      code: "SOROBAN_REBUILD_REQUIRED",
      details: { resultCode },
      retryable: true,
      status: 409,
    });
  }
}

/**
 * A simulation failed with a known globe-wallet contract error. `apiCode` is
 * the stable code from globeWalletErrors.ts (e.g. SPEND_LIMIT_EXCEEDED), so a
 * client can branch on it instead of parsing the message.
 */
export class SorobanContractError extends AppError {
  constructor(message: string, apiCode: string, contractErrorCode: number, readonly raw?: string) {
    super(message, {
      code: apiCode as ErrorCode,
      details: { contractErrorCode, ...(raw ? { raw } : {}) },
      retryable: false,
      status: 422,
    });
  }
}
