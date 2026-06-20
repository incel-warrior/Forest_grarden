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
export async function nonceExists(nonce) {
  const r = await pool.query('SELECT 1 FROM login_nonces WHERE nonce = $1', [nonce]);
  return r.rowCount > 0;
}
export async function burnNonce(nonce) {
  await pool.query('DELETE FROM login_nonces WHERE nonce = $1', [nonce]);
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
