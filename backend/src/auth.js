import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { pool } from './db.js';

// Single-use login nonces, stored so they survive across requests/instances.
export async function mintNonce() {
  const nonce = crypto.randomUUID();
  await pool.query('INSERT INTO login_nonces(nonce) VALUES ($1)', [nonce]);
  return nonce;
}
// Atomically consume a nonce: deletes and reports whether THIS call won the row.
// Two concurrent redeems with the same nonce → only one gets true (no double-mint).
export async function burnNonce(nonce) {
  const r = await pool.query('DELETE FROM login_nonces WHERE nonce = $1 RETURNING nonce', [nonce]);
  return r.rowCount === 1;
}

// Our own player session, keyed on the VERIFIED Forest userId.
export function mintSession(userId) {
  return jwt.sign({ uid: userId }, config.jwtSecret, { expiresIn: '7d' });
}

// Express middleware — sets req.userId from a Bearer token.
export function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing token' });
  try {
    req.userId = jwt.verify(token, config.jwtSecret).uid;
    next();
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
}
