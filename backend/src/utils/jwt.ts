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
  authMethod?: AuthMethod;
}

const ACCESS_EXPIRY = "15m";
const REFRESH_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_KEY_PREFIX = "orbit-wal:refresh-token:";

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
 */
export class RedisRefreshTokenStore {
  private connectPromise?: Promise<void>;

  constructor(private readonly client: RedisClientType) {}

  private key(token: string): string {
    return `${REFRESH_KEY_PREFIX}${token}`;
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.isOpen) return;
    if (!this.connectPromise) {
      this.connectPromise = this.client.connect().then(() => undefined);
    }
    await this.connectPromise;
  }

  async generate(sub: string, authMethod?: AuthMethod): Promise<string> {
    await this.ensureConnected();
    const token = randomUUID();
    const record: RefreshRecord = { sub, revoked: false };
    if (authMethod) record.authMethod = authMethod;
    await this.client.set(this.key(token), JSON.stringify(record), {
      PX: REFRESH_EXPIRY_MS,
    });
    return token;
  }

  async rotate(
    oldToken: string
  ): Promise<{ sub: string; token: string; authMethod?: AuthMethod } | null> {
    await this.ensureConnected();
    const raw = await this.client.get(this.key(oldToken));
    if (!raw) return null;
    const record = JSON.parse(raw) as RefreshRecord;
    if (record.revoked) return null;

    await this.client.del(this.key(oldToken));
    const token = await this.generate(record.sub, record.authMethod);
    return { sub: record.sub, token, authMethod: record.authMethod };
  }

  async revoke(token: string): Promise<void> {
    await this.ensureConnected();
    await this.client.del(this.key(token));
  }

  async getSub(token: string): Promise<string | null> {
    await this.ensureConnected();
    const raw = await this.client.get(this.key(token));
    if (!raw) return null;
    const record = JSON.parse(raw) as RefreshRecord;
    return record.revoked ? null : record.sub;
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
  authMethod?: AuthMethod
): Promise<string> {
  return getDefaultStore().generate(sub, authMethod);
}

export async function rotateRefreshToken(
  oldToken: string
): Promise<{ accessToken: string; refreshToken: string } | null> {
  const result = await getDefaultStore().rotate(oldToken);
  if (!result) return null;
  return {
    accessToken: generateAccessToken(result.sub, result.authMethod),
    refreshToken: result.token,
  };
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await getDefaultStore().revoke(token);
}

export async function getRefreshTokenSub(token: string): Promise<string | null> {
  return getDefaultStore().getSub(token);
}
