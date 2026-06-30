import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.pgSsl ? { rejectUnauthorized: false } : false,
});

// Create tables on boot (idempotent). For a real project, prefer versioned migrations.
export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id          TEXT PRIMARY KEY,         -- verified Forest userId (NEVER the wallet address)
      wallet_address   TEXT,                     -- verified display/payout reference
      code             TEXT UNIQUE,              -- this player's referral code
      referred_by      TEXT REFERENCES users(user_id),
      activated        BOOLEAN DEFAULT FALSE,    -- bought the starter pack
      pending_referral BIGINT  DEFAULT 0,        -- coins owed to THIS user as a referrer (await claim)
      boxes            INTEGER DEFAULT 0,        -- server-authoritative Seedbox count
      total_earned     BIGINT  DEFAULT 0,        -- leaderboard score (lifetime coins earned)
      level            INTEGER DEFAULT 1,
      last_activity    BIGINT  DEFAULT 0,        -- epoch ms; for inactivity pause
      last_daily_claim BIGINT  DEFAULT 0,        -- epoch ms
      daily_claims     INTEGER DEFAULT 0,
      daily_fast       INTEGER DEFAULT 0,        -- claims made within fast window of availability
      daily_revoked    BOOLEAN DEFAULT FALSE,
      daily_revoke_reason TEXT,
      created_at       TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS login_nonces (
      nonce      TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    -- idempotency for vault deposit/withdraw settlements (one row per actionId)
    CREATE TABLE IF NOT EXISTS settled_actions (
      action_id  TEXT PRIMARY KEY,
      user_id    TEXT,
      kind       TEXT,          -- 'deposit' | 'withdraw'
      amount     BIGINT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_users_total_earned ON users (total_earned DESC);
  `);

  // Server-authoritative economy columns (added idempotently to the existing table).
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS coins           BIGINT DEFAULT 1000;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS xp              BIGINT DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS seeds           JSONB  DEFAULT '{}'::jsonb;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS stock           JSONB  DEFAULT '{}'::jsonb;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS cures           JSONB  DEFAULT '{}'::jsonb;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS boosts          JSONB  DEFAULT '{}'::jsonb;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS plots           JSONB  DEFAULT '[]'::jsonb;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS withdraw_day    TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS withdraw_amount BIGINT DEFAULT 0;
  `);

  // Sweep nonces older than 10 minutes so the table stays small.
  await pool.query(`DELETE FROM login_nonces WHERE created_at < now() - interval '10 minutes'`);
}

// Run fn inside a transaction with the user row locked (SELECT … FOR UPDATE),
// preventing concurrent-request races on inventory/coins/claims.
export async function withUserLock(userId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM users WHERE user_id = $1 FOR UPDATE', [userId]);
    if (!rows[0]) { await client.query('ROLLBACK'); throw new Error('user not found'); }
    const result = await fn(client, rows[0]);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}
