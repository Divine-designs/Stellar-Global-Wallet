import type { ErrorCode } from "./codes";

export type { ErrorCode } from "./codes";
export { ERROR_CODES, isErrorCode } from "./codes";

export interface ValidationIssue {
  location?: string;
  message: string;
  path?: string;
  type?: string;
  value?: unknown;
}

export interface AppErrorOptions {
  code: ErrorCode;
  details?: unknown;
  retryable?: boolean;
  status: number;
}

/**
 * User-facing copy for an error code. Kept free of technical jargon so the
 * web and mobile apps can render it directly. `message` is what the user
 * sees; `action` is the suggested next step.
 */
export interface ErrorCodeCopy {
  action: string;
  message: string;
  retryable: boolean;
  status: number;
  when: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly retryable?: boolean;
  readonly status: number;

  constructor(message: string, options: AppErrorOptions) {
    super(message);
    this.name = new.target.name;
    this.code = options.code;
    this.details = options.details;
    this.retryable = options.retryable;
    this.status = options.status;
  }

  /**
   * Whether the caller should retry the request. Falls back to the HTTP
   * status when the mapper did not set an explicit `retryable` flag.
   */
  isRetryable(): boolean {
    if (typeof this.retryable === "boolean") {
      return this.retryable;
    }
    return this.status === 429 || this.status >= 500;
  }
}

export class InternalServerError extends AppError {
  constructor(message = "Internal server error") {
    super(message, { code: "INTERNAL_ERROR", status: 500 });
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found", code: ErrorCode = "NOT_FOUND", details?: unknown) {
    super(message, { code, details, status: 404 });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized", code: ErrorCode = "UNAUTHORIZED", details?: unknown) {
    super(message, { code, details, status: 401 });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = "Request body exceeds the configured size limit") {
    super(message, { code: "PAYLOAD_TOO_LARGE", status: 413 });
  }
}

export class ValidationError extends AppError {
  readonly details: ValidationIssue[];

  constructor(issues: ValidationIssue[], message = "Request validation failed") {
    super(message, { code: "VALIDATION_ERROR", details: issues, status: 400 });
    this.details = issues;
  }
}

export class Sep7Error extends AppError {
  constructor(message: string, code: ErrorCode = "SEP7_INVALID_URI", details?: unknown) {
    super(message, { code, details, status: 400 });
  }
}

export class HorizonError extends AppError {
  constructor(
    message: string,
    options: {
      code: ErrorCode;
      details?: unknown;
      retryable?: boolean;
      status?: number;
    }
  ) {
    super(message, {
      code: options.code,
      details: options.details,
      retryable: options.retryable,
      status: options.status ?? 502,
    });
  }
}

/**
 * Raised when a requested `setOptions` change would make the account's
 * thresholds unreachable (e.g. sum of signer weights below a threshold, or
 * master weight 0 with no other signers). This is a deny-by-default guard so
 * a client can never build an XDR that permanently locks the account.
 */
export class LockoutError extends AppError {
  readonly warnings: string[];

  constructor(message: string, warnings: string[] = [], details?: unknown) {
    super(message, {
      code: "SET_OPTIONS_LOCKOUT",
      details,
      status: 422,
    });
    this.warnings = warnings;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Single source of truth for the user-facing error catalogue. The
 * `docs/error-codes.md` page is generated from this map via
 * `npm run docs:errors`, so copy changes here flow straight into the docs.
 *
 * Messages are intentionally jargon-free: `tx_bad_seq` becomes "Something
 * changed, please try again" rather than leaking Horizon internals.
 */
export const ERROR_CODE_COPY: Record<ErrorCode, ErrorCodeCopy> = {
  INTERNAL_ERROR: {
    status: 500,
    retryable: true,
    when: "An unexpected failure occurred on the server.",
    message: "Something went wrong on our side.",
    action: "Wait a moment and try again. If it keeps happening, contact support.",
  },
  NOT_FOUND: {
    status: 404,
    retryable: false,
    when: "The requested resource does not exist.",
    message: "We couldn't find what you were looking for.",
    action: "Check the link or go back and pick a different item.",
  },
  UNAUTHORIZED: {
    status: 401,
    retryable: false,
    when: "The request is missing valid authentication.",
    message: "Please sign in to continue.",
    action: "Sign in again and retry.",
  },
  VALIDATION_ERROR: {
    status: 400,
    retryable: false,
    when: "One or more inputs failed validation.",
    message: "Some of the details you entered aren't quite right.",
    action: "Review the highlighted fields and try again.",
  },
  PAYLOAD_TOO_LARGE: {
    status: 413,
    retryable: false,
    when: "The request body exceeds the configured size limit.",
    message: "That file or request is too large.",
    action: "Reduce the size and try again.",
  },
  SEP7_INVALID_URI: {
    status: 400,
    retryable: false,
    when: "A SEP-7 payment URI could not be parsed.",
    message: "That payment link isn't valid.",
    action: "Ask the sender for a fresh link.",
  },
  SET_OPTIONS_LOCKOUT: {
    status: 422,
    retryable: false,
    when: "A setOptions change would lock the account out.",
    message: "This change would lock you out of your account.",
    action: "Adjust the signers or thresholds and try again.",
  },
  REFRESH_TOKEN_INVALID: {
    status: 401,
    retryable: false,
    when: "The refresh token is missing, expired, or revoked.",
    message: "Your session has expired.",
    action: "Sign in again to continue.",
  },
  LOGIN_RATE_LIMITED: {
    status: 429,
    retryable: true,
    when: "Too many sign-in attempts were made in a short window.",
    message: "Too many attempts. Please slow down.",
    action: "Wait a minute, then try signing in again.",
  },
  ROUTE_NOT_FOUND: {
    status: 404,
    retryable: false,
    when: "No route matches the requested path.",
    message: "That page doesn't exist.",
    action: "Check the address or return to the home screen.",
  },
  HORIZON_TX_BAD_SEQ: {
    status: 409,
    retryable: true,
    when: "The transaction sequence number is out of date.",
    message: "Something changed, please try again.",
    action: "Retry the operation to pick up the latest state.",
  },
  HORIZON_TX_INSUFFICIENT_FEE: {
    status: 409,
    retryable: true,
    when: "The transaction fee was below the network minimum.",
    message: "The network is busy right now.",
    action: "Try again in a moment.",
  },
  HORIZON_TX_INSUFFICIENT_BALANCE: {
    status: 422,
    retryable: false,
    when: "The account lacks funds for the transaction.",
    message: "You don't have enough funds for this.",
    action: "Add funds or lower the amount and try again.",
  },
  HORIZON_TX_NO_ACCOUNT: {
    status: 422,
    retryable: false,
    when: "The source account does not exist on the network.",
    message: "That account isn't active yet.",
    action: "Fund the account first, then try again.",
  },
  HORIZON_TX_BAD_AUTH: {
    status: 403,
    retryable: false,
    when: "The transaction signatures are missing or invalid.",
    message: "We couldn't verify this transaction.",
    action: "Re-authorize and try again.",
  },
  HORIZON_UNAVAILABLE: {
    status: 502,
    retryable: true,
    when: "Horizon could not be reached or returned an error.",
    message: "The Stellar network is temporarily unavailable.",
    action: "Wait a moment and try again.",
  },
  SOROBAN_SIMULATION_FAILED: {
    status: 502,
    retryable: true,
    when: "A Soroban contract simulation failed.",
    message: "We couldn't prepare this contract action.",
    action: "Try again. If it persists, contact support.",
  },
  SOROBAN_CONTRACT_ERROR: {
    status: 422,
    retryable: false,
    when: "A Soroban contract returned an error result.",
    message: "The contract couldn't complete this action.",
    action: "Review the details and try again.",
  },
  SOROBAN_INVOKE_FAILED: {
    status: 502,
    retryable: true,
    when: "A Soroban contract invocation failed to submit.",
    message: "We couldn't submit this contract action.",
    action: "Try again in a moment.",
  },
  GLOBE_WALLET_NOT_FOUND: {
    status: 404,
    retryable: false,
    when: "The requested Globe wallet does not exist.",
    message: "We couldn't find that wallet.",
    action: "Pick a different wallet or create a new one.",
  },
  GLOBE_WALLET_CONFLICT: {
    status: 409,
    retryable: false,
    when: "A Globe wallet change conflicts with existing state.",
    message: "This wallet was changed somewhere else.",
    action: "Refresh and try again.",
  },
};
