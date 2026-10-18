/**
 * SDK HTTP client with transparent token refresh and retry handling.
 *
 * - Single-flight refresh: parallel 401s share one `/auth/refresh` call.
 * - Only `TOKEN_EXPIRED` triggers refresh; other 401s surface as-is.
 * - Pluggable `TokenStore` (in-memory default; web/mobile supply their own).
 * - 429/503 retried with exponential backoff + jitter, honouring `Retry-After`.
 * - Non-idempotent POSTs are only retried when an `Idempotency-Key` is present.
 *
 * Runtime-safe for Node, browsers and React Native (no Node-only modules).
 */

export interface TokenStore {
  get(): Promise<string | null> | string | null;
  set(token: string): Promise<void> | void;
  clear(): Promise<void> | void;
}

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

/** Thrown when the refresh token itself is expired or revoked. */
export class SessionExpiredError extends Error {
  readonly code = 'SESSION_EXPIRED';

  constructor(message = 'Session expired; please sign in again.') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

/** Thrown when a request fails with a non-retryable, non-auth error. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ClientOptions {
  baseUrl: string;
  tokenStore?: TokenStore;
  /** Called when the refresh token is expired/revoked. */
  onSessionExpired?: () => void;
  /** Max retry attempts for 429/503. Default 3. */
  maxRetries?: number;
  /** Base backoff in ms. Default 250. */
  baseDelayMs?: number;
  /** Injectable fetch (defaults to global fetch). */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  /** Idempotency key; required to retry non-idempotent POSTs. */
  idempotencyKey?: string;
}

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: string }).name === 'AbortError'
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

export class Client {
  private readonly baseUrl: string;
  private readonly tokenStore: TokenStore;
  private readonly onSessionExpired?: () => void;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly fetchImpl: typeof fetch;

  /** Shared in-flight refresh promise (single-flight). */
  private refreshPromise: Promise<string> | null = null;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.tokenStore = options.tokenStore ?? new InMemoryTokenStore();
    this.onSessionExpired = options.onSessionExpired;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Single-flight refresh. All concurrent callers share one promise so
   * rotating refresh tokens are only consumed once.
   */
  private refresh(): Promise<string> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.performRefresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async performRefresh(): Promise<string> {
    const current = await this.tokenStore.get();
    const res = await this.fetchImpl(`${this.baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(current ? { Authorization: `Bearer ${current}` } : {}),
      },
    });

    if (!res.ok) {
      await this.tokenStore.clear();
      this.onSessionExpired?.();
      throw new SessionExpiredError();
    }

    const data = (await res.json()) as { accessToken?: string; token?: string };
    const token = data.accessToken ?? data.token;
    if (!token) {
      await this.tokenStore.clear();
      this.onSessionExpired?.();
      throw new SessionExpiredError();
    }
    await this.tokenStore.set(token);
    return token;
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = (options.method ?? 'GET').toUpperCase();
    const idempotent = IDEMPOTENT_METHODS.has(method) || Boolean(options.idempotencyKey);

    let refreshed = false;
    let attempt = 0;

    for (;;) {
      if (options.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      const token = await this.tokenStore.get();
      const headers: Record<string, string> = {
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
        ...options.headers,
      };

      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: options.signal,
        });
      } catch (err) {
        if (isAbortError(err)) throw err;
        throw err;
      }

      if (res.status === 401 && !refreshed) {
        const body = await this.safeJson(res);
        const code = (body as { code?: string } | null)?.code;
        if (code === 'TOKEN_EXPIRED') {
          refreshed = true;
          // Await the shared refresh; if aborted while waiting, propagate.
          await this.refresh();
          if (options.signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }
          continue;
        }
        throw new ApiError('Unauthorized', res.status, code, body);
      }

      if ((res.status === 429 || res.status === 503) && idempotent && attempt < this.maxRetries) {
        const retryAfter = parseRetryAfter(res.headers.get('Retry-After'));
        const backoff = this.baseDelayMs * 2 ** attempt;
        const jitter = Math.random() * this.baseDelayMs;
        const delay = retryAfter ?? backoff + jitter;
        attempt += 1;
        await sleep(delay, options.signal);
        continue;
      }

      const body = await this.safeJson(res);
      if (!res.ok) {
        const code = (body as { code?: string } | null)?.code;
        throw new ApiError(`Request failed with status ${res.status}`, res.status, code, body);
      }
      return body as T;
    }
  }

  private async safeJson(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
