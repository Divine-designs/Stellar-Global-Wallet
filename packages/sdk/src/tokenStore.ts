/**
 * Pluggable token storage for the SDK.
 *
 * The SDK never touches platform storage directly: web (localStorage /
 * cookies), mobile (SecureStore / Keychain) and Node (in-memory) each supply
 * their own implementation. The default is an in-memory store, which is safe
 * for Node and tests but does not survive a process restart.
 *
 * Storage rules per platform:
 * - Node / tests: in-memory (default) — tokens live for the process lifetime.
 * - Browser: persist the refresh token in an httpOnly cookie (RFC 6265) and
 *   keep the short-lived access token in memory only.
 * - React Native: persist the refresh token in SecureStore / Keychain and keep
 *   the access token in memory only.
 *
 * Access tokens are short-lived by design (see `utils/jwt.ts`); the SDK
 * refreshes them transparently, so only the refresh token needs persistence.
 */

export interface TokenStore {
  /** Returns the current access token, or `null` when signed out. */
  get(): string | null | Promise<string | null>;
  /** Stores a (new) access token. */
  set(token: string): void | Promise<void>;
  /** Clears stored credentials, e.g. after the refresh token is revoked. */
  clear(): void | Promise<void>;
}

/**
 * Default in-memory {@link TokenStore}. Works in Node, browsers and React
 * Native; tokens are lost when the process/page is torn down.
 */
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

/**
 * Thrown when the refresh token itself is expired or revoked. The token store
 * has already been cleared when this surfaces; callers should route the user
 * back to sign-in (the SDK also invokes `onSessionExpired`).
 */
export class SessionExpiredError extends Error {
  readonly code = 'SESSION_EXPIRED' as const;

  constructor(message = 'Session expired; please sign in again.') {
    super(message);
    this.name = 'SessionExpiredError';
    // Restore prototype chain for ES5/transpiled targets.
    Object.setPrototypeOf(this, SessionExpiredError.prototype);
  }
}

/** Resolves a possibly-async token store read. */
export async function readToken(store: TokenStore): Promise<string | null> {
  return await store.get();
}

/** Resolves a possibly-async token store write. */
export async function writeToken(
  store: TokenStore,
  token: string,
): Promise<void> {
  await store.set(token);
}

/** Resolves a possibly-async token store clear. */
export async function clearToken(store: TokenStore): Promise<void> {
  await store.clear();
}
