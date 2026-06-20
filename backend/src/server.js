import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { config, assertConfig } from './config.js';
import { pool, initSchema } from './db.js';
import { mintNonce, nonceExists, burnNonce, mintSession, requireAuth } from './auth.js';
import { redeemIdentity, settle, toBaseUnits } from './forest.js';

const app = express();
app.use(express.json());
app.use(cors({
  origin: config.allowedOrigins.includes('*') ? true : config.allowedOrigins,
  methods: ['GET', 'POST'],
}));

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  console.error(err);
  res.status(500).json({ error: 'server_error', detail: String(err.message || err) });
});

// Stable referral code from the verified userId (server-owned, not forgeable).
function codeFor(userId) {
  const h = crypto.createHash('sha256').update(userId).digest('hex');
  return 'GARDEN-' + BigInt('0x' + h.slice(0, 12)).toString(36).toUpperCase().slice(0, 5).padStart(5, '0');
}
async function ensureUser(userId, walletAddress) {
  const code = codeFor(userId);
  await pool.query(
    `INSERT INTO users (user_id, wallet_address, code)
       VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET wallet_address = EXCLUDED.wallet_address`,
    [userId, walletAddress || null, code]
  );
  return (await pool.query('SELECT * FROM users WHERE user_id = $1', [userId])).rows[0];
}

// ─────────────────────────────── health ───────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ─────────────────────── identity handshake ───────────────────────────
// Step 1: client asks for a nonce, then calls forest.identity.code({ nonce }).
app.post('/session/start', wrap(async (req, res) => {
  const nonce = await mintNonce();
  res.json({ nonce });
}));

// Step 2: client relays the opaque code + the nonce it used.
app.post('/session/redeem', wrap(async (req, res) => {
  const { code, nonce } = req.body || {};
  if (!code || !nonce) return res.status(400).json({ error: 'code and nonce required' });
  if (!(await nonceExists(nonce))) return res.status(400).json({ error: 'unknown or expired nonce' });

  const ident = await redeemIdentity(code); // { userId, walletAddress, nonce, issuedAt }
  if (ident.nonce !== nonce) return res.status(400).json({ error: 'nonce mismatch' });
  await burnNonce(nonce);

  const user = await ensureUser(ident.userId, ident.walletAddress);
  res.json({ token: mintSession(ident.userId), userId: ident.userId, code: user.code });
}));

// ─────────────────────────── referral ─────────────────────────────────
app.get('/referral/code', requireAuth, wrap(async (req, res) => {
  const u = (await pool.query('SELECT code, referred_by, activated FROM users WHERE user_id = $1', [req.userId])).rows[0];
  res.json({ code: u.code, referredBy: u.referred_by, activated: u.activated });
}));

// Redeem a friend's code for the 50% discount (first purchase only, not your own).
app.post('/referral/redeem', requireAuth, wrap(async (req, res) => {
  const code = String((req.body?.code || '')).trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'code required' });

  const me = (await pool.query('SELECT * FROM users WHERE user_id = $1', [req.userId])).rows[0];
  if (me.activated) return res.status(409).json({ error: 'already_activated' });
  if (me.referred_by) return res.status(409).json({ error: 'already_redeemed' });
  if (code === me.code) return res.status(400).json({ error: 'cannot_use_own_code' });

  const ref = (await pool.query('SELECT user_id FROM users WHERE code = $1', [code])).rows[0];
  if (!ref) return res.status(404).json({ error: 'invalid_code' });

  await pool.query('UPDATE users SET referred_by = $1 WHERE user_id = $2', [ref.user_id, req.userId]);
  res.json({ valid: true, discountPct: config.referralDiscountPct });
}));

// ─────────────────────────── activate ─────────────────────────────────
// Player already bought their half on-chain (iframe forest.swap.buy).
// If they used a referral code, grant the project-funded half (e.g. 500 $GARDEN)
// as a Game-Balance CREDIT settlement (funded by the Game Vault).
// Body: { actionId } from iframe forest.game.action.authorize({ actionId, debitLimitAmount: "0" }).
app.post('/activate', requireAuth, wrap(async (req, res) => {
  const { actionId } = req.body || {};
  const me = (await pool.query('SELECT * FROM users WHERE user_id = $1', [req.userId])).rows[0];
  if (me.activated) return res.json({ activated: true, granted: 0, replayed: true });

  let granted = 0;
  if (me.referred_by) {
    granted = Math.round(config.starterPack * config.referralDiscountPct); // 500
    if (!actionId) return res.status(400).json({ error: 'actionId required for the bonus grant' });
    await settle({ actionId, debitAmount: '0', creditAmount: toBaseUnits(granted) });
  }
  await pool.query('UPDATE users SET activated = TRUE, last_activity = $2 WHERE user_id = $1',
    [req.userId, Date.now()]);
  res.json({ activated: true, granted });
}));

// ─────────────────────────── earn (10% referral accrual) ──────────────
// Record coin earnings; accrue the referrer's 10% to their pending balance.
// Body: { coins }
app.post('/earn', requireAuth, wrap(async (req, res) => {
  const coins = Math.max(0, Math.floor(Number(req.body?.coins || 0)));
  if (!coins) return res.status(400).json({ error: 'coins must be > 0' });

  const me = (await pool.query(
    `UPDATE users SET total_earned = total_earned + $2, last_activity = $3
       WHERE user_id = $1 RETURNING referred_by`,
    [req.userId, coins, Date.now()]
  )).rows[0];

  let referrerCredited = 0;
  if (me.referred_by) {
    referrerCredited = Math.round(coins * config.referralRewardPct);
    if (referrerCredited > 0) {
      await pool.query('UPDATE users SET pending_referral = pending_referral + $2 WHERE user_id = $1',
        [me.referred_by, referrerCredited]);
    }
  }
  res.json({ ok: true, referrerCredited });
}));

// Referrer (while online) claims their accrued 10% — settled to their Game Balance.
// Body: { actionId } from forest.game.action.authorize({ actionId, debitLimitAmount: "0" }).
app.post('/referral/claim', requireAuth, wrap(async (req, res) => {
  const { actionId } = req.body || {};
  const u = (await pool.query('SELECT pending_referral FROM users WHERE user_id = $1', [req.userId])).rows[0];
  const pending = Number(u.pending_referral || 0);
  if (pending <= 0) return res.json({ claimed: 0 });
  if (!actionId) return res.status(400).json({ error: 'actionId required' });

  // NOTE: coins -> $GARDEN conversion rate is your economy's call; 1:1 shown here.
  await settle({ actionId, debitAmount: '0', creditAmount: toBaseUnits(pending) });
  await pool.query('UPDATE users SET pending_referral = 0 WHERE user_id = $1', [req.userId]);
  res.json({ claimed: pending });
}));

// ─────────────────────────── daily bonus ──────────────────────────────
// Server-authoritative 24h window + anti-abuse. Grants a Seedbox (in-game item).
app.post('/daily/claim', requireAuth, wrap(async (req, res) => {
  const now = Date.now();
  const u = (await pool.query('SELECT * FROM users WHERE user_id = $1', [req.userId])).rows[0];

  if (u.daily_revoked) return res.status(403).json({ granted: false, reason: u.daily_revoke_reason || 'revoked' });

  // Inactivity pause: no lootbox activity for 5 days → pause the bonus.
  if (u.last_activity && now - Number(u.last_activity) > config.inactiveMs) {
    await pool.query(`UPDATE users SET daily_revoked = TRUE, daily_revoke_reason = 'inactive' WHERE user_id = $1`, [req.userId]);
    return res.status(403).json({ granted: false, reason: 'inactive' });
  }

  const available = now - Number(u.last_daily_claim) >= config.dayMs;
  if (!available) {
    return res.json({ granted: false, nextInMs: config.dayMs - (now - Number(u.last_daily_claim)) });
  }

  // "Fast" = claimed within the fast window of becoming available.
  const becameAvailableAt = Number(u.last_daily_claim) + config.dayMs;
  const isFast = u.last_daily_claim > 0 && (now - becameAvailableAt) <= config.dailyFastWindowMs;
  const claims = u.daily_claims + 1;
  const fast = u.daily_fast + (isFast ? 1 : 0);

  // Bot gate: enough samples AND > fastLimit of claims are machine-fast → revoke.
  let revoked = false, reason = null;
  if (claims >= config.dailyMinSample && fast / claims > config.dailyFastLimit) {
    revoked = true; reason = 'bot';
  }

  await pool.query(
    `UPDATE users SET boxes = boxes + 1, last_daily_claim = $2, daily_claims = $3,
        daily_fast = $4, daily_revoked = $5, daily_revoke_reason = $6, last_activity = $2
       WHERE user_id = $1`,
    [req.userId, now, claims, fast, revoked, reason]
  );
  res.json({ granted: true, boxes: u.boxes + 1, nextInMs: config.dayMs, ...(revoked ? { warning: 'revoked_after_claim' } : {}) });
}));

// ─────────────────────────── leaderboard ──────────────────────────────
app.get('/leaderboard', wrap(async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
  const rows = (await pool.query(
    `SELECT code, wallet_address, total_earned, level
       FROM users WHERE total_earned > 0
       ORDER BY total_earned DESC LIMIT $1`, [limit]
  )).rows;
  res.json({
    leaderboard: rows.map((r, i) => ({
      rank: i + 1,
      code: r.code,
      wallet: r.wallet_address,
      score: Number(r.total_earned),
      level: r.level,
    })),
  });
}));

// ─────────────────────────── boot ─────────────────────────────────────
assertConfig();
initSchema()
  .then(() => app.listen(config.port, () => console.log(`Forest Garden backend on :${config.port}`)))
  .catch(err => { console.error('Failed to init DB:', err); process.exit(1); });
