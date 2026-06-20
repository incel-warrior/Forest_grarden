import crypto from 'node:crypto';
import { config } from './config.js';

// HMAC-SHA256 over the EXACT request-body string, formatted as the Forest header value.
function sign(body) {
  const hex = crypto.createHmac('sha256', config.settlementSecret).update(body).digest('hex');
  return `v1=${hex}`;
}

async function forestPost(path, payload) {
  const body = JSON.stringify(payload);
  const res = await fetch(`${config.forestApi}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forest-Settlement-Signature': sign(body),
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Forest ${path} -> ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

// ── Identity handshake (server side) ───────────────────────────────────────
// Redeem the opaque code the iframe got from forest.identity.code({ nonce }).
// Returns { userId, walletAddress, nonce, issuedAt }. Single-use — do not retry on loss.
export async function redeemIdentity(code) {
  return forestPost(`/campaigns/${config.projectId}/html/identity/redeem`, {
    code,
    timestamp: Math.floor(Date.now() / 1000),
  });
}

// ── Trusted settlement (the credit-producing path) ─────────────────────────
// actionId comes from the iframe's forest.game.action.authorize(...).
// Amounts are BASE-UNIT integer strings. Funded by the project's Game Vault.
// NOTE: to retry a lost response, resend the SAME actionId + body + timestamp.
export async function settle({ actionId, debitAmount = '0', creditAmount = '0', timestamp }) {
  return forestPost(`/campaigns/${config.projectId}/html/settlements`, {
    actionId,
    debitAmount: String(debitAmount),
    creditAmount: String(creditAmount),
    timestamp: timestamp ?? Math.floor(Date.now() / 1000),
  });
}

// Convert a display token amount ("500", "1.25") to a base-unit integer string.
export function toBaseUnits(displayAmount, decimals = config.tokenDecimals) {
  const [whole, frac = ''] = String(displayAmount).split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return (BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fracPadded || '0')).toString();
}
