// Central config — all secrets come from environment variables (never hardcode).
export const config = {
  port: Number(process.env.PORT || 3000),

  // Forest (trusted) — from the launch congratulations screen
  forestApi: (process.env.FOREST_API_BASE_URL || '').replace(/\/+$/, ''),
  settlementSecret: process.env.SETTLEMENT_SECRET || '',
  projectId: process.env.PROJECT_ID || '',

  // Your own
  jwtSecret: process.env.JWT_SECRET || 'dev-only-change-me',
  allowedOrigins: (process.env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim()),
  databaseUrl: process.env.DATABASE_URL || '',
  pgSsl: String(process.env.PGSSL || 'false') === 'true',

  // Economy (mirrors the iframe constants)
  tokenDecimals: Number(process.env.TOKEN_DECIMALS || 18),
  starterPack: 1000,          // $GARDEN to activate
  referralDiscountPct: 0.5,   // 50% off first pack with a code
  referralRewardPct: 0.10,    // 10% of a referee's coin earnings → referrer

  // Daily bonus (server-authoritative)
  dayMs: 24 * 60 * 60 * 1000,
  dailyFastWindowMs: 2 * 60 * 60 * 1000,   // claimed within 2h of becoming available = "fast"
  dailyMinSample: 7,                        // need this many claims before the bot gate applies
  dailyFastLimit: 0.90,                     // >90% fast claims = machine-like
  inactiveMs: 5 * 24 * 60 * 60 * 1000,      // no lootbox purchase for 5 days → pause
};

// Fail fast in production if the trusted-path secrets are missing.
export function assertConfig() {
  const missing = [];
  if (!config.forestApi) missing.push('FOREST_API_BASE_URL');
  if (!config.settlementSecret) missing.push('SETTLEMENT_SECRET');
  if (!config.projectId) missing.push('PROJECT_ID');
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (config.jwtSecret === 'dev-only-change-me') missing.push('JWT_SECRET');
  if (missing.length) {
    console.warn('[config] WARNING — missing/placeholder env vars: ' + missing.join(', ') +
      '\n  The server will boot, but Forest calls and sessions will fail until these are set.');
  }
}
