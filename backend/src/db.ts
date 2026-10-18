import { Pool } from "pg";
import { config } from "./config";
import { ensureDevicesTable } from "./services/deviceRegistry";
import { ensureVerifiedEmailsTable } from "./services/emailVerification";

export const pool = new Pool({ connectionString: config.DATABASE_URL });

export async function ensureAuditTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS keypair_audit_log (
      id BIGSERIAL PRIMARY KEY,
      issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      api_key_hash VARCHAR(64) NOT NULL,
      public_key VARCHAR(56) NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source_public_key VARCHAR(56) NOT NULL,
      idempotency_key VARCHAR(255) NOT NULL,
      result_hash VARCHAR(64) NOT NULL,
      result_successful BOOLEAN NOT NULL,
      UNIQUE (source_public_key, idempotency_key)
    )
  `);

  // #87 — device token table for push notifications.
  await ensureDevicesTable(pool);

  // #90 — verified email table for email notification fallback.
  await ensureVerifiedEmailsTable(pool);

  // #74 — pending multisig transaction store for co-signers.
  await ensurePendingTxsTable(pool);

  // #37 — first-class session records for listing and revoke-all.
  await ensureSessionsTable(pool);
}

export async function ensurePendingTxsTable(db: Pool) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS pending_txs (
      id BIGSERIAL PRIMARY KEY,
      account VARCHAR(56) NOT NULL,
      xdr TEXT NOT NULL,
      required_weight INTEGER NOT NULL,
      collected_signers JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by VARCHAR(56) NOT NULL,
      expires_at TIMESTAMPTZ,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS pending_txs_account_status_idx
      ON pending_txs (account, status)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS pending_txs_expires_at_idx
      ON pending_txs (expires_at)
      WHERE status = 'pending'
  `);
}

export async function ensureSessionsTable(db: Pool) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id UUID PRIMARY KEY,
      account VARCHAR(56) NOT NULL,
      refresh_hash VARCHAR(64) NOT NULL,
      user_agent TEXT,
      ip_hash VARCHAR(64),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS sessions_account_idx
      ON sessions (account)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS sessions_refresh_hash_idx
      ON sessions (refresh_hash)
  `);
}
