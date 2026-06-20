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

    CREATE INDEX IF NOT EXISTS idx_users_total_earned ON users (total_earned DESC);
  `);

  // Sweep nonces older than 10 minutes so the table stays small.
  await pool.query(`DELETE FROM login_nonces WHERE created_at < now() - interval '10 minutes'`);
}
