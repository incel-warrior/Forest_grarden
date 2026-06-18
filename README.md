# Forest Garden 🍓

A pixel-art farming game built as a single self-contained HTML file that runs **inside an iframe on a Forest token page** and talks to Forest over `postMessage`. No build step, no dependencies — open the HTML and play.

## Play

Open [`forest_garden.html`](forest_garden.html) in a browser (or upload it to your Forest HTML project).

## Gameplay

- **Plant → Grow → Harvest → Sell** crops across a 3×3 garden. Three tiers: Crops, Fruit, Berries.
- **Seedboxes** (lootboxes) roll seeds, cures, and growth potions with rarity tiers and an animated reveal.
- **Cure** sick plants and **boost** growth with potions.
- **Leveling & XP** gate higher-tier crops.
- **Leaderboard** 🏆 — automatic, keyed on the connected Forest wallet (no manual entry).
- **Vault** 🏦 — deposit/withdraw via Forest (`forest.game.deposit` / `forest.game.withdraw`), shows wallet $GARDEN balance from a sell-quote snapshot.
- **Daily login bonus** 🎁 — 1 free Seedbox every 24h, with client-side anti-farming heuristics (timing-jitter bot detection + inactivity pause).

## Forest integration

Uses the Forest HTML SDK postMessage bridge: wallet identity (`FOREST_WALLET_CONNECTED`), game balance (`forest.game.*`), and swap quotes (`forest.swap.quote`). The connected wallet address is treated as display-only per the Forest trust model.

## ⚠️ Backend (planned — Railway)

All state (daily-bonus eligibility/claims, anti-abuse counters, leaderboard scores, the box/coin economy) currently lives in `localStorage` and is **advisory only** — fine while rewards are in-game, but it must move server-side before any of it maps to minted value. Required before launch:

1. **Identity** — key accounting on the verified Forest `userId` via the `forest.identity.code` → HMAC `/identity/redeem` handshake, not the display-only wallet address.
2. **Daily bonus** — enforce the 24h window and run anti-abuse heuristics server-side with server time; the server is the sole grantor.
3. **Grants** — issue Seedboxes/coins through a trusted settlement (`forest.game.action.authorize` → backend `/settlements`); never embed the Settlement Signing Secret in the HTML.
4. **Leaderboard** — server-authoritative, derived from settled gameplay; expose a shared read endpoint.

## Files

- `forest_garden.html` — the entire game (HTML/CSS/JS).
- `Plants_Forest_Garden.xlsx` — crop / drop-rate / economy design data.
