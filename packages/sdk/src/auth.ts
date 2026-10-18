/**
 * Token storage and refresh primitives for the SDK.
 *
 * Runtime-safe in Node, browsers and React Native: no Node-only modules.
 */

/**
 * Pluggable token storage. Web and mobile clients supply their own
 * implementation (e.g. localStorage, SecureStore); the SDK ships an
 * in-memory default suitable for short-lived processes and tests.
 */
export interface TokenStore {
  get(): string | null | Promise<string | null>;
  set(token: string): void | Promise<void>;
  clear(): void | Promise<void>;
}

/** Default in-memory token store. */
export class InMemoryTokenStore implements TokenStore {
  private token: string | null = null;

  get(): string | null {
    return this.token;
  }

  set(token: string): void {
    this.token = token;
  }

  clear(): void {
    this.token = null;
  }
}

/** Raised when the refresh token is expired or revoked. */
export class SessionExpiredError extends Error {
  readonly code = 'SESSION_EXPIRED';

  constructor(message = 'Session expired; please sign in again.') {
    super(message);
    this.name = 'SessionExpiredError';
    Object.setPrototypeOf(this, SessionExpiredError.prototype);
  }
}

/** Shape returned by the `/auth/refresh` endpoint. */
export interface RefreshResult {
  accessToken: string;
  refreshToken?: string;
}

/**
 * Single-flight token refresher.
 *
 * All concurrent callers share one in-flight refresh promise, so N parallel
 * 401s trigger exactly one `/auth/refresh` call. Refresh tokens rotate, so
 * naive parallel refreshes would invalidate each other.
 */
export class TokenRefresher {
  private inFlight: Promise<string> | null = null;

  constructor(
    private readonly store: TokenStore,
    private readonly refreshFn: () => Promise<RefreshResult>,
    private readonly onSessionExpired?: (error: SessionExpiredError) => void,
  ) {}

  /**
   * Refresh the access token, coalescing concurrent calls.
   *
   * @throws {SessionExpiredError} when the refresh token is expired/revoked.
   */
  refresh(): Promise<string> {
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  private async doRefresh(): Promise<string> {
    try {
      const result = await this.refreshFn();
      await this.store.set(result.accessToken);
      return result.accessToken;
    } catch (err) {
      await this.store.clear();
      const expired = new SessionExpiredError();
      this.onSessionExpired?.(expired);
      throw expired;
    }
  }
}

/**
 * Compute a retry delay for 429/503 responses using exponential backoff
 * with full jitter, honouring `Retry-After` when present.
 *
 * @param attempt  zero-based retry attempt index
 * @param retryAfter value of the `Retry-After` header in seconds, if any
 */
export function computeRetryDelay(attempt: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }
  const base = Math.min(30_000, 500 * 2 ** attempt);
  return Math.random() * base;
}

/** HTTP methods that are safe to retry without an idempotency key. */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

/**
 * Whether a request may be retried on 429/503.
 * Non-idempotent POSTs are only retried when an `Idempotency-Key` is present.
 */
export function isRetryable(
  method: string,
  headers: Record<string, string> | undefined,
): boolean {
  const upper = method.toUpperCase();
  if (IDEMPOTENT_METHODS.has(upper)) {
    return true;
  }
  if (upper === 'POST') {
    const key = headers?.['Idempotency-Key'] ?? headers?.['idempotency-key'];
    return Boolean(key);
  }
  return false;
}
