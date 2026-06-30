import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { config, assertConfig } from './config.js';
import { pool, initSchema, withUserLock } from './db.js';
import { mintNonce, burnNonce, mintSession, requireAuth } from './auth.js';
import { redeemIdentity, settle, toBaseUnits } from './forest.js';
import {
  PLANTS, VARIANT, CURE_SELL, GROWTH_SELL, ITEMS_PER_BOX, LOOTBOX_COST, TILES,
  rollItem, saleValue, seedSellValue, harvestXP, applyXP, canGrow, growMs, invKey,
} from './economy.js';

const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(cors({
  origin: config.allowedOrigins.includes('*') ? true : config.allowedOrigins,
  methods: ['GET', 'POST'],
}));

// Throw these for clean 4xx; anything else becomes a generic 500 (no internal leakage).
function httpError(status, msg) { const e = new Error(msg); e.httpStatus = status; return e; }
// surface the Forest settlement error code to the client instead of a generic 500
function settleError(e) {
  const m = String((e && e.message) || '');
  const at = m.indexOf('{');
  if (at >= 0) { try { const o = JSON.parse(m.slice(at)); return httpError(400, o.code || o.message || 'settlement_failed'); } catch {} }
  return httpError(502, 'settlement_failed');
}
const wrap = fn => (req, res) => fn(req, res).catch(err => {
  if (err && err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

const num = v => Number(v || 0);
// Increment a count in a {key:count} object; delete keys that hit zero. Returns the object.
function bump(obj, key, delta) { obj = obj || {}; obj[key] = (obj[key] || 0) + delta; if (obj[key] <= 0) delete obj[key]; return obj; }

// Stable referral code from the verified userId (server-owned, not forgeable).
function codeFor(userId) {
  const h = crypto.createHash('sha256').update(userId).digest('hex');
  return 'GARDEN-' + BigInt('0x' + h.slice(0, 12)).toString(36).toUpperCase().slice(0, 5).padStart(5, '0');
}
async function ensureUser(userId, walletAddress) {
  const code = codeFor(userId);
  await pool.query(
    `INSERT INTO users (user_id, wallet_address, code) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET wallet_address = EXCLUDED.wallet_address`,
    [userId, walletAddress || null, code]
  );
  return (await pool.query('SELECT * FROM users WHERE user_id = $1', [userId])).rows[0];
}

// ─────────────────────────────── health ───────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ─────────────────────── identity handshake ───────────────────────────
app.post('/session/start', wrap(async (req, res) => {
  res.json({ nonce: await mintNonce() });
}));

// Atomic nonce burn is the guard — two concurrent redeems can't both mint a session.
app.post('/session/redeem', wrap(async (req, res) => {
  const { code, nonce } = req.body || {};
  if (!code || !nonce) throw httpError(400, 'code and nonce required');
  const ident = await redeemIdentity(code);               // Forest enforces single-use codes
  if (ident.nonce !== nonce) throw httpError(400, 'nonce mismatch');
  if (!(await burnNonce(nonce))) throw httpError(400, 'nonce already used or expired');
  const user = await ensureUser(ident.userId, ident.walletAddress);
  res.json({ token: mintSession(ident.userId), userId: ident.userId, code: user.code });
}));

// ─────────────────────────── referral ─────────────────────────────────
app.get('/referral/code', requireAuth, wrap(async (req, res) => {
  const u = (await pool.query('SELECT code, referred_by, activated FROM users WHERE user_id = $1', [req.userId])).rows[0];
  res.json({ code: u.code, referredBy: u.referred_by, activated: u.activated });
}));

app.post('/referral/redeem', requireAuth, wrap(async (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!code) throw httpError(400, 'code required');
  const me = (await pool.query('SELECT * FROM users WHERE user_id = $1', [req.userId])).rows[0];
  if (me.activated) throw httpError(409, 'already_activated');
  if (me.referred_by) throw httpError(409, 'already_redeemed');
  if (code === me.code) throw httpError(400, 'cannot_use_own_code');
  const ref = (await pool.query('SELECT user_id FROM users WHERE code = $1', [code])).rows[0];
  if (!ref) throw httpError(404, 'invalid_code');
  await pool.query('UPDATE users SET referred_by = $1 WHERE user_id = $2', [ref.user_id, req.userId]);
  res.json({ valid: true, discountPct: config.referralDiscountPct });
}));

// ─────────────────────────── activate ─────────────────────────────────
// Atomically flip activated (winner-only), then grant the referral half via settlement.
app.post('/activate', requireAuth, wrap(async (req, res) => {
  const { actionId } = req.body || {};
  const flipped = (await pool.query(
    'UPDATE users SET activated = TRUE, last_activity = $2 WHERE user_id = $1 AND activated = FALSE RETURNING referred_by',
    [req.userId, Date.now()]
  )).rows[0];
  if (!flipped) return res.json({ activated: true, granted: 0, replayed: true });

  let granted = 0;
  if (flipped.referred_by) {
    granted = Math.round(config.starterPack * config.referralDiscountPct);
    if (!actionId) {
      await pool.query('UPDATE users SET activated = FALSE WHERE user_id = $1', [req.userId]);
      throw httpError(400, 'actionId required for the bonus grant');
    }
    try {
      await settle({ actionId, debitAmount: '0', creditAmount: toBaseUnits(granted) });
    } catch (e) {
      await pool.query('UPDATE users SET activated = FALSE WHERE user_id = $1', [req.userId]);
      throw e;
    }
  }
  res.json({ activated: true, granted });
}));

// ─────────────────────────── game state ───────────────────────────────
app.get('/state', requireAuth, wrap(async (req, res) => {
  const u = (await pool.query('SELECT * FROM users WHERE user_id = $1', [req.userId])).rows[0];
  if (!u) throw httpError(404, 'no_user');
  res.json({
    code: u.code, activated: u.activated, referredBy: u.referred_by,
    coins: num(u.coins), boxes: u.boxes, level: u.level, xp: num(u.xp),
    totalEarned: num(u.total_earned), pendingReferral: num(u.pending_referral),
    seeds: u.seeds || {}, stock: u.stock || {}, cures: u.cures || {}, boosts: u.boosts || {}, plots: u.plots || [],
  });
}));

// ─── buy a Seedbox (server-priced) ───
app.post('/box/buy', requireAuth, wrap(async (req, res) => {
  res.json(await withUserLock(req.userId, async (client, u) => {
    if (num(u.coins) < LOOTBOX_COST) throw httpError(400, 'not_enough_coins');
    const coins = num(u.coins) - LOOTBOX_COST, boxes = u.boxes + 1;
    await client.query('UPDATE users SET coins = $2, boxes = $3, last_activity = $4 WHERE user_id = $1',
      [req.userId, coins, boxes, Date.now()]);
    return { coins, boxes };
  }));
}));

// ─── #2 FIX: open a Seedbox — loot is rolled SERVER-SIDE, not in the browser ───
app.post('/box/open', requireAuth, wrap(async (req, res) => {
  res.json(await withUserLock(req.userId, async (client, u) => {
    if (u.boxes < 1) throw httpError(400, 'no_boxes');
    let seeds = u.seeds || {}, cures = u.cures || {}, boosts = u.boosts || {};
    const items = [];
    for (let i = 0; i < ITEMS_PER_BOX; i++) {
      const it = rollItem(u.level);
      if (it.type === 'seed') seeds = bump(seeds, invKey(it.plant, it.variant), 1);
      else if (it.type === 'cure') cures = bump(cures, it.rarity, 1);
      else boosts = bump(boosts, it.tier, 1);
      items.push(it);
    }
    await client.query('UPDATE users SET boxes = boxes - 1, seeds = $2, cures = $3, boosts = $4, last_activity = $5 WHERE user_id = $1',
      [req.userId, JSON.stringify(seeds), JSON.stringify(cures), JSON.stringify(boosts), Date.now()]);
    return { boxes: u.boxes - 1, items, seeds, cures, boosts };
  }));
}));

// ─── plant a seed (consumes server inventory; records server plant time) ───
app.post('/plant', requireAuth, wrap(async (req, res) => {
  const { idx, plant, variant = 'common' } = req.body || {};
  if (!Number.isInteger(idx) || idx < 0 || idx >= TILES) throw httpError(400, 'bad idx');
  if (!PLANTS[plant]) throw httpError(400, 'bad plant');
  if (!VARIANT[variant]) throw httpError(400, 'bad variant');
  res.json(await withUserLock(req.userId, async (client, u) => {
    if (!canGrow(plant, u.level)) throw httpError(403, 'level_locked');
    const plots = Array.isArray(u.plots) ? u.plots : [];
    while (plots.length < TILES) plots.push(null);
    if (plots[idx]) throw httpError(409, 'plot_occupied');
    let seeds = u.seeds || {}; const k = invKey(plant, variant);
    if (!(seeds[k] > 0)) throw httpError(400, 'no_seed');
    seeds = bump(seeds, k, -1);
    plots[idx] = { plant, variant, plantedAt: Date.now(), growMs: growMs(plant, variant, config.tickMs) };
    await client.query('UPDATE users SET seeds = $2, plots = $3, last_activity = $4 WHERE user_id = $1',
      [req.userId, JSON.stringify(seeds), JSON.stringify(plots), Date.now()]);
    return { idx, plot: plots[idx] };
  }));
}));

// ─── harvest (server validates grow time elapsed; grants stock + XP) ───
app.post('/harvest', requireAuth, wrap(async (req, res) => {
  const { idx } = req.body || {};
  if (!Number.isInteger(idx) || idx < 0 || idx >= TILES) throw httpError(400, 'bad idx');
  res.json(await withUserLock(req.userId, async (client, u) => {
    const plots = Array.isArray(u.plots) ? u.plots : [];
    const p = plots[idx];
    if (!p) throw httpError(400, 'empty_plot');
    if (Date.now() - p.plantedAt + config.harvestGraceMs < p.growMs) throw httpError(425, 'not_ready');
    let stock = u.stock || {}; stock = bump(stock, invKey(p.plant, p.variant), 1);
    const { level, xp } = applyXP(u.level, u.xp, harvestXP(p.plant));
    plots[idx] = null;
    await client.query('UPDATE users SET stock = $2, plots = $3, level = $4, xp = $5, last_activity = $6 WHERE user_id = $1',
      [req.userId, JSON.stringify(stock), JSON.stringify(plots), level, xp, Date.now()]);
    return { harvested: invKey(p.plant, p.variant), level, xp };
  }));
}));

// ─── #1 FIX: sell — prices come from the SERVER, inventory is consumed SERVER-SIDE.
// The 10% referral reward derives from the server-computed value, never a client number.
app.post('/sell', requireAuth, wrap(async (req, res) => {
  const { kind, key } = req.body || {};
  const qty = Math.floor(Number(req.body?.qty || 0));
  if (!(qty > 0)) throw httpError(400, 'qty must be > 0');

  let col, priceOf;
  if (kind === 'stock' || kind === 'seed') {
    const [plant, variant] = String(key || '').split('|');
    if (!PLANTS[plant] || !VARIANT[variant]) throw httpError(400, 'bad key');
    col = kind === 'stock' ? 'stock' : 'seeds';
    priceOf = kind === 'stock' ? saleValue(plant, variant) : seedSellValue(plant);
  } else if (kind === 'cure') {
    if (!CURE_SELL[key]) throw httpError(400, 'bad cure'); col = 'cures'; priceOf = CURE_SELL[key];
  } else if (kind === 'boost') {
    if (!GROWTH_SELL[key]) throw httpError(400, 'bad boost'); col = 'boosts'; priceOf = GROWTH_SELL[key];
  } else throw httpError(400, 'bad kind');

  const out = await withUserLock(req.userId, async (client, u) => {
    let bucket = u[col] || {};
    if (!(bucket[key] >= qty)) throw httpError(400, 'not_enough');
    bucket = bump(bucket, key, -qty);
    const value = priceOf * qty;
    const coins = num(u.coins) + value, total = num(u.total_earned) + value;
    await client.query(`UPDATE users SET ${col} = $2, coins = $3, total_earned = $4, last_activity = $5 WHERE user_id = $1`,
      [req.userId, JSON.stringify(bucket), coins, total, Date.now()]);
    return { value, coins, referredBy: u.referred_by };
  });

  // Accrue the referrer's 10% from the SERVER value (separate row → after the lock).
  let referrerCredited = 0;
  if (out.referredBy) {
    referrerCredited = Math.round(out.value * config.referralRewardPct);
    if (referrerCredited > 0) {
      await pool.query('UPDATE users SET pending_referral = pending_referral + $2 WHERE user_id = $1',
        [out.referredBy, referrerCredited]);
    }
  }
  res.json({ value: out.value, coins: out.coins, referrerCredited });
}));

// Referrer claims accrued 10% — RESERVE atomically, then settle (no double-spend on concurrent claims).
app.post('/referral/claim', requireAuth, wrap(async (req, res) => {
  const { actionId } = req.body || {};
  const reserved = (await pool.query(
    'UPDATE users SET pending_referral = 0 WHERE user_id = $1 AND pending_referral > 0 RETURNING pending_referral',
    [req.userId]
  )).rows[0];
  const pending = reserved ? Number(reserved.pending_referral) : 0;
  if (pending <= 0) return res.json({ claimed: 0 });

  const giveBack = () => pool.query('UPDATE users SET pending_referral = pending_referral + $2 WHERE user_id = $1', [req.userId, pending]);
  if (!actionId) { await giveBack(); throw httpError(400, 'actionId required'); }
  try {
    await settle({ actionId, debitAmount: '0', creditAmount: toBaseUnits(pending) });
  } catch (e) {
    await giveBack();   // settlement failed → restore so the reward isn't lost
    throw e;
  }
  res.json({ claimed: pending });
}));

// ─────────────────────────── daily bonus ──────────────────────────────
app.post('/daily/claim', requireAuth, wrap(async (req, res) => {
  const now = Date.now();
  const u = (await pool.query('SELECT * FROM users WHERE user_id = $1', [req.userId])).rows[0];
  if (u.daily_revoked) return res.status(403).json({ granted: false, reason: u.daily_revoke_reason || 'revoked' });

  if (u.last_activity && now - Number(u.last_activity) > config.inactiveMs) {
    await pool.query(`UPDATE users SET daily_revoked = TRUE, daily_revoke_reason = 'inactive' WHERE user_id = $1`, [req.userId]);
    return res.status(403).json({ granted: false, reason: 'inactive' });
  }
  const available = now - Number(u.last_daily_claim) >= config.dayMs;
  if (!available) return res.json({ granted: false, nextInMs: config.dayMs - (now - Number(u.last_daily_claim)) });

  const becameAvailableAt = Number(u.last_daily_claim) + config.dayMs;
  const isFast = u.last_daily_claim > 0 && (now - becameAvailableAt) <= config.dailyFastWindowMs;
  const claims = u.daily_claims + 1;
  const fast = u.daily_fast + (isFast ? 1 : 0);
  let revoked = false, reason = null;
  if (claims >= config.dailyMinSample && fast / claims > config.dailyFastLimit) { revoked = true; reason = 'bot'; }

  await pool.query(
    `UPDATE users SET boxes = boxes + 1, last_daily_claim = $2, daily_claims = $3,
        daily_fast = $4, daily_revoked = $5, daily_revoke_reason = $6, last_activity = $2 WHERE user_id = $1`,
    [req.userId, now, claims, fast, revoked, reason]
  );
  res.json({ granted: true, boxes: u.boxes + 1, nextInMs: config.dayMs, ...(revoked ? { warning: 'revoked_after_claim' } : {}) });
}));

// ─── VAULT DEPOSIT: $GARDEN (Game Balance) → in-game coins (1:1) ───
// The iframe first runs forest.game.deposit (wallet → Game Balance) and authorizes an
// action. Here we DEBIT that Game Balance via settlement — Forest only allows the debit if
// the player truly has the balance + authorization, so coins can't be minted for free.
app.post('/vault/deposit', requireAuth, wrap(async (req, res) => {
  const { actionId } = req.body || {};
  const amount = Math.floor(Number(req.body?.amount || 0));
  if (!(amount > 0)) throw httpError(400, 'amount must be > 0');
  if (!actionId || typeof actionId !== 'string') throw httpError(400, 'actionId required');

  // claim the actionId (idempotent — a retry of an already-settled deposit won't double-credit)
  const claim = await pool.query(
    `INSERT INTO settled_actions (action_id, user_id, kind, amount) VALUES ($1, $2, 'deposit', $3)
     ON CONFLICT (action_id) DO NOTHING RETURNING action_id`, [actionId, req.userId, amount]);
  if (!claim.rows[0]) {
    const u = (await pool.query('SELECT coins FROM users WHERE user_id = $1', [req.userId])).rows[0];
    return res.json({ ok: true, coins: num(u && u.coins), replayed: true });
  }

  try {
    await settle({ actionId, debitAmount: toBaseUnits(amount), creditAmount: '0' });
  } catch (e) {
    await pool.query('DELETE FROM settled_actions WHERE action_id = $1', [actionId]);  // allow a clean retry
    console.error('[vault/deposit] settle failed:', e.message);
    throw settleError(e);
  }
  const out = await withUserLock(req.userId, async (client, u) => {
    const coins = num(u.coins) + amount;
    await client.query('UPDATE users SET coins = $2, last_activity = $3 WHERE user_id = $1', [req.userId, coins, Date.now()]);
    return { coins };
  });
  res.json({ ok: true, coins: out.coins });
}));

// ─── VAULT WITHDRAW: in-game coins → $GARDEN (Game Balance, vault-funded) → wallet ───
// #6: daily cap is server-side (per verified userId, per UTC day) so clearing localStorage
// can't bypass it. We debit coins + reserve the cap, then settle a vault-funded credit to the
// player's Game Balance; the iframe then runs forest.game.withdraw to move it to the wallet.
app.post('/vault/withdraw', requireAuth, wrap(async (req, res) => {
  const { actionId } = req.body || {};
  const amount = Math.floor(Number(req.body?.amount || 0));
  if (!(amount > 0)) throw httpError(400, 'amount must be > 0');
  if (!actionId || typeof actionId !== 'string') throw httpError(400, 'actionId required');
  const today = new Date().toISOString().slice(0, 10);

  const claim = await pool.query(
    `INSERT INTO settled_actions (action_id, user_id, kind, amount) VALUES ($1, $2, 'withdraw', $3)
     ON CONFLICT (action_id) DO NOTHING RETURNING action_id`, [actionId, req.userId, amount]);
  if (!claim.rows[0]) {
    const u = (await pool.query('SELECT coins FROM users WHERE user_id = $1', [req.userId])).rows[0];
    return res.json({ ok: true, coins: num(u && u.coins), replayed: true });
  }

  // reserve coins + daily cap atomically
  let reserved;
  try {
    reserved = await withUserLock(req.userId, async (client, u) => {
      if (num(u.coins) < amount) throw httpError(400, 'not_enough_coins');
      const used = (u.withdraw_day === today) ? num(u.withdraw_amount) : 0;
      const remaining = config.vaultDailyWithdrawLimit - used;
      if (amount > remaining) throw httpError(403, `daily_limit_remaining:${remaining}`);
      const coins = num(u.coins) - amount;
      await client.query('UPDATE users SET coins = $2, withdraw_day = $3, withdraw_amount = $4, last_activity = $5 WHERE user_id = $1',
        [req.userId, coins, today, used + amount, Date.now()]);
      return { coins };
    });
  } catch (e) {
    await pool.query('DELETE FROM settled_actions WHERE action_id = $1', [actionId]);
    throw e;
  }

  // credit the player's Game Balance from the Game Vault
  try {
    await settle({ actionId, debitAmount: '0', creditAmount: toBaseUnits(amount) });
  } catch (e) {
    // settlement failed (e.g. vault underfunded) → refund coins + cap, release the claim
    await withUserLock(req.userId, async (client, u) => {
      const used = (u.withdraw_day === today) ? num(u.withdraw_amount) : 0;
      await client.query('UPDATE users SET coins = coins + $2, withdraw_amount = $3 WHERE user_id = $1',
        [req.userId, amount, Math.max(0, used - amount)]);
    });
    await pool.query('DELETE FROM settled_actions WHERE action_id = $1', [actionId]);
    console.error('[vault/withdraw] settle failed:', e.message);
    throw settleError(e);
  }
  res.json({ ok: true, coins: reserved.coins });
}));

// ─────────────────────────── leaderboard ──────────────────────────────
app.get('/leaderboard', wrap(async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
  const rows = (await pool.query(
    `SELECT code, wallet_address, total_earned, level FROM users WHERE total_earned > 0
       ORDER BY total_earned DESC LIMIT $1`, [limit]
  )).rows;
  res.json({
    leaderboard: rows.map((r, i) => ({
      rank: i + 1, code: r.code, wallet: r.wallet_address, score: Number(r.total_earned), level: r.level,
    })),
  });
}));

// ─────────────────────────── boot ─────────────────────────────────────
assertConfig();
initSchema()
  .then(() => app.listen(config.port, () => console.log(`Forest Garden backend on :${config.port}`)))
  .catch(err => { console.error('Failed to init DB:', err); process.exit(1); });
