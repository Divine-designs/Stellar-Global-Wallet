import { pool } from "../db";

/** Cached results are replayed for 24 hours; after that the key is free to be used again. */
const TTL_SQL = "INTERVAL '24 hours'";

export interface IdempotencyResult {
  hash: string;
  successful: boolean;
}

export async function getCachedResult(
  sourcePublicKey: string,
  idempotencyKey: string
): Promise<IdempotencyResult | null> {
  const result = await pool.query(
    `SELECT result_hash, result_successful FROM idempotency_keys
     WHERE source_public_key = $1 AND idempotency_key = $2 AND created_at > NOW() - ${TTL_SQL}`,
    [sourcePublicKey, idempotencyKey]
  );
  if (result.rows.length > 0) {
    return {
      hash: result.rows[0].result_hash,
      successful: result.rows[0].result_successful,
    };
  }
  return null;
}

export async function cacheResult(
  sourcePublicKey: string,
  idempotencyKey: string,
  hash: string,
  successful: boolean
): Promise<void> {
  await pool.query(
    `INSERT INTO idempotency_keys (source_public_key, idempotency_key, result_hash, result_successful) 
     VALUES ($1, $2, $3, $4) 
     ON CONFLICT (source_public_key, idempotency_key) DO UPDATE
       SET result_hash = EXCLUDED.result_hash,
           result_successful = EXCLUDED.result_successful,
           created_at = NOW()
       WHERE idempotency_keys.created_at <= NOW() - ${TTL_SQL}`,
    [sourcePublicKey, idempotencyKey, hash, successful]
  );
}
