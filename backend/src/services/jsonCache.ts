/**
 * Small Redis-backed JSON cache with per-entry TTLs, for upstream lookups
 * that are expensive and change rarely (e.g. stellar.toml metadata, #52).
 *
 * Same failure policy as sorobanCache.ts: Redis being down must never break
 * a request, so every operation logs and degrades to a cache miss / no-op.
 */
import { createClient, RedisClientType } from "redis";
import { config } from "../config";

const KEY_PREFIX = "orbit-wal:json-cache:";

type CacheClient = ReturnType<typeof createClient>;

let _client: CacheClient | undefined;

async function getConnectedClient(): Promise<CacheClient> {
  if (!_client) {
    _client = createClient({ url: config.REDIS_URL });
    (_client as unknown as RedisClientType).on("error", (err: Error) => {
      console.error("[json-cache] redis error", err.message);
    });
  }
  if (!(_client as unknown as RedisClientType).isOpen) {
    await _client.connect();
  }
  return _client;
}

export interface JsonCache {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

export const redisJsonCache: JsonCache = {
  async get<T>(key: string): Promise<T | null> {
    try {
      const client = await getConnectedClient();
      const raw = await client.get(KEY_PREFIX + key);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch (err) {
      console.error("[json-cache] get error", (err as Error).message);
      return null;
    }
  },

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      const client = await getConnectedClient();
      await client.set(KEY_PREFIX + key, JSON.stringify(value), { EX: ttlSeconds });
    } catch (err) {
      console.error("[json-cache] set error", (err as Error).message);
    }
  },
};
