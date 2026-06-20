# Forest Garden — Backend (Railway)

Trusted server for the parts the iframe **cannot** do safely: verified identity, referral codes,
the credit-producing settlements (50%-off starter grant, 10% referral reward), the
server-authoritative daily bonus, and the leaderboard.

It holds the **Settlement Signing Secret** and signs Forest API calls. The HTML never holds it.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET  | `/health` | — | health check |
| POST | `/session/start` | — | mint a login nonce |
| POST | `/session/redeem` | — | redeem `forest.identity.code` → verified `userId` + JWT |
| GET  | `/referral/code` | JWT | this player's referral code |
| POST | `/referral/redeem` | JWT | redeem a friend's code (50% off, first purchase) |
| POST | `/activate` | JWT | grant the project-funded half via settlement |
| POST | `/earn` | JWT | record coin earnings; accrue referrer's 10% |
| POST | `/referral/claim` | JWT | referrer settles their accrued 10% |
| POST | `/daily/claim` | JWT | server-authoritative daily Seedbox + anti-abuse |
| GET  | `/leaderboard` | — | top scores |

## Prerequisite — get the secret

The `SETTLEMENT_SECRET` + `FOREST_API_BASE_URL` are shown **once** on the Forest HTML-project
launch "congratulations" screen. Launch `forest_garden.html` as a Forest HTML project first, then
copy that env block here.

## Deploy on Railway (dashboard)

1. Push this repo (or this `backend/` subfolder) to GitHub.
2. [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo** → pick the repo.
   - If `backend/` is a subfolder: Service → **Settings → Root Directory** = `backend`.
3. In the project, **+ New → Database → Add PostgreSQL**. Railway injects `DATABASE_URL` automatically.
4. Service → **Variables**, add: `FOREST_API_BASE_URL`, `SETTLEMENT_SECRET`, `PROJECT_ID`,
   `JWT_SECRET`, `ALLOWED_ORIGIN` (your Forest game origin), and `TOKEN_DECIMALS` if not 18.
5. Service → **Settings → Networking → Generate Domain** → you get
   `https://forest-garden-api.up.railway.app`. Deploys happen automatically on every push.
6. Verify: open `https://<your-domain>/health` → `{ "ok": true }`.

## Fund the Game Vault

`/activate`, `/referral/claim` produce **credits** paid from your project's **Game Vault**. Top it
up with $GARDEN in Forest's project tools, or settlements fail with insufficient vault capacity.

## Wire the iframe

In `forest_garden.html`, set the API base and replace the `ReferralBackend` stubs (and the daily /
leaderboard local logic) with `fetch()` calls to these endpoints. Run the identity handshake once
on load to get the JWT, then send `Authorization: Bearer <token>` on the rest. The game owner can
do this after the domain is live — ask Claude to "wire the iframe to the Railway backend" with the
domain in hand.

## Local dev

```bash
cd backend
cp .env.example .env      # fill in values; point DATABASE_URL at a local/remote Postgres
npm install
npm start                 # http://localhost:3000/health
```
