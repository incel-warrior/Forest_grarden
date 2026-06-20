// Server-authoritative economy — ported from forest_garden.html.
// The client may DISPLAY these, but only this module's results are trusted for value.
import crypto from 'node:crypto';

// Secure random float in [0,1) — server-only RNG the client cannot influence.
export function rnd() { return crypto.randomInt(0, 1_000_000) / 1_000_000; }

export const RARITY = {
  common: { growMin: 20,  xpBase: 5  },
  rare:   { growMin: 120, xpBase: 16 },
  mythic: { growMin: 480, xpBase: 42 },
};

// rarity / level-gate / within-category drop weight / base sell value
export const PLANTS = {
  wheat:{rarity:'common',lvl:1,drop:0.50,yield:20},   rice:{rarity:'common',lvl:5,drop:0.20,yield:35},
  potato:{rarity:'common',lvl:10,drop:0.12,yield:55}, corn:{rarity:'common',lvl:15,drop:0.08,yield:75},
  tomato:{rarity:'common',lvl:20,drop:0.06,yield:95}, soy:{rarity:'common',lvl:30,drop:0.03,yield:125},
  yam:{rarity:'common',lvl:50,drop:0.01,yield:245},
  apple:{rarity:'rare',lvl:1,drop:0.50,yield:50},     orange:{rarity:'rare',lvl:5,drop:0.20,yield:100},
  pear:{rarity:'rare',lvl:10,drop:0.12,yield:125},    peach:{rarity:'rare',lvl:15,drop:0.08,yield:175},
  papaya:{rarity:'rare',lvl:20,drop:0.06,yield:225},  mango:{rarity:'rare',lvl:30,drop:0.03,yield:280},
  pitaya:{rarity:'rare',lvl:50,drop:0.01,yield:555},
  strawberries:{rarity:'mythic',lvl:1,drop:0.50,yield:85},   raspberries:{rarity:'mythic',lvl:5,drop:0.20,yield:135},
  blackberries:{rarity:'mythic',lvl:10,drop:0.12,yield:175}, blueberries:{rarity:'mythic',lvl:15,drop:0.08,yield:215},
  cherries:{rarity:'mythic',lvl:20,drop:0.06,yield:255},     cranberries:{rarity:'mythic',lvl:30,drop:0.03,yield:750},
  acai:{rarity:'mythic',lvl:50,drop:0.01,yield:1250},
};
export const PLANT_KEYS = Object.keys(PLANTS);
const keysOf = r => PLANT_KEYS.filter(k => PLANTS[k].rarity === r);

export const VARIANT = {
  common:    { mult:1.0, boost:0.00 }, rare:      { mult:1.3, boost:0.15 },
  mythic:    { mult:1.5, boost:0.25 }, legendary: { mult:2.0, boost:0.50 },
};
export const VARIANTS = Object.keys(VARIANT);
export const CURES  = ['common','rare','mythic'];
export const BOOSTS = ['rare','mythic','legendary'];

const ITEM_WEIGHTS    = { crop:0.55, fruit:0.17, berry:0.08, growth:0.10, cure:0.10 };
const CAT_RARITY      = { crop:'common', fruit:'rare', berry:'mythic' };
const GROWTH_WEIGHTS  = { rare:0.65, mythic:0.25, legendary:0.10 };
const CURE_WEIGHTS    = { common:0.60, rare:0.25, mythic:0.15 };
const VARIANT_WEIGHTS = { common:0.71, rare:0.15, mythic:0.09, legendary:0.05 };

export const CURE_SELL   = { common:50, rare:90, mythic:130 };
export const GROWTH_SELL = { rare:30, mythic:45, legendary:120 };
export const ITEMS_PER_BOX = 5;
export const LOOTBOX_COST  = 350;
export const TILES = 9;

export const harvestValue  = pk => Math.round(PLANTS[pk].yield);
export const saleValue     = (pk, v) => Math.round(harvestValue(pk) * VARIANT[v].mult);
export const seedSellValue = pk => Math.max(1, Math.round(harvestValue(pk) * 0.20));
export const xpToNext      = lv => Math.round(75 * Math.pow(lv, 1.7));
export const harvestXP     = pk => Math.max(1, Math.round(RARITY[PLANTS[pk].rarity].xpBase * (1 + PLANTS[pk].lvl * 0.15)));

function pickWeighted(weights) {
  const tot = Object.values(weights).reduce((a, b) => a + b, 0);
  let r = rnd() * tot;
  for (const k in weights) { r -= weights[k]; if (r <= 0) return k; }
  return Object.keys(weights)[0];
}
function pickCrop(rarity, level) {
  const w = {};
  keysOf(rarity).forEach(k => {
    let weight = PLANTS[k].drop; const lv = PLANTS[k].lvl;
    if (lv === 1 && level <= 5) weight *= 1.30;
    else if (lv === 5 && level >= 5 && level <= 10) weight *= 1.20;
    w[k] = weight;
  });
  return pickWeighted(w);
}

// Roll ONE loot item (server RNG). Returns a descriptor the caller applies to inventory.
export function rollItem(level) {
  const kind = pickWeighted(ITEM_WEIGHTS);
  if (kind === 'crop' || kind === 'fruit' || kind === 'berry') {
    const plant = pickCrop(CAT_RARITY[kind], level);
    const variant = pickWeighted(VARIANT_WEIGHTS);
    return { type: 'seed', plant, variant };
  }
  if (kind === 'cure')  return { type: 'cure',  rarity: pickWeighted(CURE_WEIGHTS) };
  return { type: 'boost', tier: pickWeighted(GROWTH_WEIGHTS) };
}

// XP → level (returns the new level + leftover xp).
export function applyXP(level, xp, gained) {
  level = Number(level); xp = Number(xp) + gained;
  while (xp >= xpToNext(level)) { xp -= xpToNext(level); level++; }
  return { level, xp };
}

// Level gate for planting.
export const canGrow = (plant, level) => level >= PLANTS[plant].lvl;

// Grow time (ms) for a freshly planted seed, reduced by its own variant boost.
// One game-minute = TICK_MS real ms (matches the client's testing pace by default).
export function growMs(plant, variant, tickMs) {
  const base = RARITY[PLANTS[plant].rarity].growMin * tickMs;
  return Math.round(base * (1 - VARIANT[variant].boost));
}
export const invKey = (p, v) => p + '|' + v;
