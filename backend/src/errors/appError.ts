export interface ValidationIssue {
  location?: string;
  message: string;
  path?: string;
  type?: string;
  value?: unknown;
}

export interface AppErrorOptions {
  code: string;
  details?: unknown;
  retryable?: boolean;
  status: number;
}

export class AppError extends Error {
  readonly code: string;
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
}

export class InternalServerError extends AppError {
  constructor(message = "Internal server error") {
    super(message, { code: "INTERNAL_ERROR", status: 500 });
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found", code = "NOT_FOUND", details?: unknown) {
    super(message, { code, details, status: 404 });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized", code = "UNAUTHORIZED", details?: unknown) {
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
  constructor(message: string, code = "SEP7_INVALID_URI", details?: unknown) {
    super(message, { code, details, status: 400 });
  }
}

export class HorizonError extends AppError {
  constructor(
    message: string,
    options: {
      code: string;
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
