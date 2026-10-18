import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { createClient, RedisClientType } from "redis";
import { config } from "../config";

export type AuthMethod = "api-key" | "sep10";

interface TokenPayload {
  sub: string;
  type: "access" | "refresh";
  auth_method?: AuthMethod;
}

interface RefreshRecord {
  sub: string;
  revoked: boolean;
  sessionId: string;
}

/**
 * Metadata captured when a refresh token (and therefore a session) is
 * created. `ipHash` is a hash of the client IP, never the raw address, so
 * the session listing can show "where" without storing PII (issue #37).
 */
export interface SessionMetadata {
  userAgent?: string;
  ipHash?: string;
}

/**
 * A first-class session record as exposed to clients via
 * `GET /auth/sessions`. `id` is the session id (not the refresh token),
 * so it is safe to return to the client and to use in
 * `DELETE /auth/sessions/:id`.
 */
export interface SessionInfo {
  id: string;
  userAgent: string | null;
  ipHash: string | null;
  createdAt: string;
  lastUsedAt: string;
}

const ACCESS_EXPIRY = "15m";
const REFRESH_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_KEY_PREFIX = "orbit-wal:refresh-token:";
const SESSION_KEY_PREFIX = "orbit-wal:session:";
const ACCOUNT_SESSIONS_KEY_PREFIX = "orbit-wal:account-sessions:";

export function generateAccessToken(sub: string, authMethod?: AuthMethod): string {
  const payload: TokenPayload = { sub, type: "access" };
  if (authMethod) payload.auth_method = authMethod;
  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: ACCESS_EXPIRY,
  });
}

export function verifyAccessToken(token: string): TokenPayload {
  return jwt.verify(token, config.JWT_SECRET) as TokenPayload;
}

/**
 * Redis-backed refresh-token store (issue #74). Replaces the old
 * process-local `Map` so refresh tokens survive restarts/deploys and are
 * visible to every instance sharing the same REDIS_URL — the same
 * cross-instance pattern already established by `RedisAccountLock`
 * (services/locks/redisAccountLock.ts), just applied to session state
 * instead of payment-submission locking.
 *
 * Expiry is modeled with Redis's own TTL (PX) rather than a stored
 * `expiresAt` field plus a manual sweep — Redis reclaims the key itself,
 * so there's no equivalent of the old `setInterval` sweep needed here.
 * Revocation is a `DEL`, but a `revoked` flag is still stored (write-then-
 * check) to keep provenance identical to the read-then-write shape the
 * old code had and to guard a narrow race between GET and DEL.
 *
 * Sessions (issue #37): every refresh token is now linked to a session
 * row keyed by `sessionId`. The session record holds device metadata and
 * is indexed per-account so `GET /auth/sessions` and revoke-all can find
 * every active session for a user. Revoking a session deletes its refresh
 * token, so a revoked session can never rotate again.
 */
export class RedisRefreshTokenStore {
  private connectPromise?: Promise<void>;

  constructor(private readonly client: RedisClientType) {}

  private key(token: string): string {
    return `${REFRESH_KEY_PREFIX}${token}`;
  }

  private sessionKey(sessionId: string): string {
    return `${SESSION_KEY_PREFIX}${sessionId}`;
  }

  private accountSessionsKey(sub: string): string {
    return `${ACCOUNT_SESSIONS_KEY_PREFIX}${sub}`;
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.isOpen) return;
    if (!this.connectPromise) {
      this.connectPromise = this.client.connect().then(() => undefined);
    }
    await this.connectPromise;
  }

  private async createSession(
    sub: string,
    metadata: SessionMetadata
  ): Promise<{ sessionId: string; token: string }> {
    const sessionId = randomUUID();
    const token = randomUUID();
    const now = new Date().toISOString();
    const record: RefreshRecord = { sub, revoked: false, sessionId };
    const session: SessionInfo = {
      id: sessionId,
      userAgent: metadata.userAgent ?? null,
      ipHash: metadata.ipHash ?? null,
      createdAt: now,
      lastUsedAt: now,
    };

    await this.client.set(this.key(token), JSON.stringify(record), {
      PX: REFRESH_EXPIRY_MS,
    });
    await this.client.set(this.sessionKey(sessionId), JSON.stringify(session), {
      PX: REFRESH_EXPIRY_MS,
    });
    await this.client.sAdd(this.accountSessionsKey(sub), sessionId);
    await this.client.pExpire(this.accountSessionsKey(sub), REFRESH_EXPIRY_MS);

    return { sessionId, token };
  }

  async generate(sub: string, metadata: SessionMetadata = {}): Promise<string> {
    await this.ensureConnected();
    const { token } = await this.createSession(sub, metadata);
    return token;
  }

  async rotate(
    oldToken: string,
    metadata: SessionMetadata = {}
  ): Promise<{ sub: string; token: string; sessionId: string } | null> {
    await this.ensureConnected();
    const raw = await this.client.get(this.key(oldToken));
    if (!raw) return null;
    const record = JSON.parse(raw) as RefreshRecord;
    if (record.revoked) return null;

    // A session that has been revoked (e.g. via revoke-all) must not be
    // able to rotate even if a stale refresh token still exists.
    const sessionRaw = await this.client.get(this.sessionKey(record.sessionId));
    if (!sessionRaw) return null;

    await this.client.del(this.key(oldToken));

    const token = randomUUID();
    const now = new Date().toISOString();
    const nextRecord: RefreshRecord = {
      sub: record.sub,
      revoked: false,
      sessionId: record.sessionId,
    };
    await this.client.set(this.key(token), JSON.stringify(nextRecord), {
      PX: REFRESH_EXPIRY_MS,
    });

    const session = JSON.parse(sessionRaw) as SessionInfo;
    const updated: SessionInfo = {
      ...session,
      lastUsedAt: now,
      userAgent: metadata.userAgent ?? session.userAgent,
      ipHash: metadata.ipHash ?? session.ipHash,
    };
    await this.client.set(this.sessionKey(record.sessionId), JSON.stringify(updated), {
      PX: REFRESH_EXPIRY_MS,
    });

    return { sub: record.sub, token, sessionId: record.sessionId };
  }

  async revoke(token: string): Promise<void> {
    await this.ensureConnected();
    const raw = await this.client.get(this.key(token));
    await this.client.del(this.key(token));
    if (!raw) return;
    const record = JSON.parse(raw) as RefreshRecord;
    await this.revokeSession(record.sub, record.sessionId);
  }

  async getSub(token: string): Promise<string | null> {
    await this.ensureConnected();
    const raw = await this.client.get(this.key(token));
    if (!raw) return null;
    const record = JSON.parse(raw) as RefreshRecord;
    return record.revoked ? null : record.sub;
  }

  async getSessionId(token: string): Promise<string | null> {
    await this.ensureConnected();
    const raw = await this.client.get(this.key(token));
    if (!raw) return null;
    const record = JSON.parse(raw) as RefreshRecord;
    return record.revoked ? null : record.sessionId;
  }

  async listSessions(sub: string): Promise<SessionInfo[]> {
    await this.ensureConnected();
    const ids = await this.client.sMembers(this.accountSessionsKey(sub));
    if (ids.length === 0) return [];

    const sessions: SessionInfo[] = [];
    for (const id of ids) {
      const raw = await this.client.get(this.sessionKey(id));
      if (!raw) {
        // Session expired or was revoked; prune the stale index entry.
        await this.client.sRem(this.accountSessionsKey(sub), id);
        continue;
      }
      sessions.push(JSON.parse(raw) as SessionInfo);
    }
    return sessions.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  }

  /**
   * Revoke a single session, but only if it belongs to `sub`. Returns
   * `true` when a session was revoked, `false` when it did not exist or
   * belonged to another account (deny-by-default, issue #37).
   */
  async revokeSession(sub: string, sessionId: string): Promise<boolean> {
    await this.ensureConnected();
    const isMember = await this.client.sIsMember(
      this.accountSessionsKey(sub),
      sessionId
    );
    if (!isMember) return false;

    await this.client.del(this.sessionKey(sessionId));
    await this.client.sRem(this.accountSessionsKey(sub), sessionId);
    return true;
  }

  /**
   * Revoke every session for `sub` except `keepSessionId` (the caller's
   * current session). Returns the number of sessions revoked.
   */
  async revokeAllSessions(sub: string, keepSessionId?: string): Promise<number> {
    await this.ensureConnected();
    const ids = await this.client.sMembers(this.accountSessionsKey(sub));
    let revoked = 0;
    for (const id of ids) {
      if (keepSessionId && id === keepSessionId) continue;
      await this.client.del(this.sessionKey(id));
      await this.client.sRem(this.accountSessionsKey(sub), id);
      revoked += 1;
    }
    return revoked;
  }
}

let defaultClient: RedisClientType | undefined;
function getDefaultClient(): RedisClientType {
  if (!defaultClient) {
    defaultClient = createClient({ url: config.REDIS_URL });
    defaultClient.on("error", (err) => {
      console.error("[jwt refresh store] redis client error", err);
    });
  }
  return defaultClient;
}

let defaultStore: RedisRefreshTokenStore | undefined;
function getDefaultStore(): RedisRefreshTokenStore {
  if (!defaultStore) {
    defaultStore = new RedisRefreshTokenStore(getDefaultClient());
  }
  return defaultStore;
}

export async function generateRefreshToken(
  sub: string,
  metadata: SessionMetadata = {}
): Promise<string> {
  return getDefaultStore().generate(sub, metadata);
}

export async function rotateRefreshToken(
  oldToken: string,
  metadata: SessionMetadata = {}
): Promise<{ accessToken: string; refreshToken: string; sessionId: string } | null> {
  const result = await getDefaultStore().rotate(oldToken, metadata);
  if (!result) return null;
  return {
    accessToken: generateAccessToken(result.sub, result.authMethod),
    refreshToken: result.token,
    sessionId: result.sessionId,
  };
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await getDefaultStore().revoke(token);
}

export async function getRefreshTokenSub(token: string): Promise<string | null> {
  return getDefaultStore().getSub(token);
}

export async function getRefreshTokenSessionId(token: string): Promise<string | null> {
  return getDefaultStore().getSessionId(token);
}

export async function listSessions(sub: string): Promise<SessionInfo[]> {
  return getDefaultStore().listSessions(sub);
}

export async function revokeSession(sub: string, sessionId: string): Promise<boolean> {
  return getDefaultStore().revokeSession(sub, sessionId);
}

export async function revokeAllSessions(
  sub: string,
  keepSessionId?: string
): Promise<number> {
  return getDefaultStore().revokeAllSessions(sub, keepSessionId);
}
