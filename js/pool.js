// pool.js — location pool loading + sampling without replacement (spec §9).
// Entries are passed through verbatim: {image_id, lng, lat, viewer_url,
// thumb, name}, where `name` is the pre-geocoded human-readable place name
// the reveal UI displays (tools/name_location_pool.py). S3 adds an additive
// per-entry `difficulty` tier (1 easy / 2 medium / 3 hard, scored offline
// by tools/score_location_pool.py) that drives the host's difficulty pick.
// The shuffle is seeded from the room code so a resumed host (or anyone
// replaying the same room) deterministically sees the same order.

let rawPool = null;

export async function loadPool() {
  if (rawPool) return rawPool;
  const res = await fetch("data/location_pool.json");
  if (!res.ok) throw new Error(`Failed to load location pool: ${res.status}`);
  rawPool = await res.json();
  if (!Array.isArray(rawPool) || rawPool.length === 0) {
    throw new Error("Location pool is empty");
  }
  return rawPool;
}

// Small string hash -> 32-bit seed.
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// mulberry32 PRNG — deterministic, tiny.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Seeded Fisher–Yates over a copy of the pool.
export function shuffledPool(pool, roomCode) {
  const rand = mulberry32(hashSeed(roomCode));
  const arr = pool.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ================================================================
 * S3 difficulty tiers.
 * The host picks a named difficulty at setup; the room samples from the
 * matching tier(s) of the scored pool. Entries without a tier (a pool from
 * before the scorer ran, or mid-re-score) count as wildcards that match
 * every difficulty, so the game keeps working before/after a re-score.
 * ================================================================ */

export const DIFFICULTIES = ["casual", "world", "expert"];
export const DIFFICULTY_DEFAULT = "world";

// Which scored tiers each difficulty samples from. Casual is the pool's
// recognizable slice, World tour is the whole pool (the pre-S3 experience),
// Expert is the brutal bottom slice.
const DIFFICULTY_TIERS = {
  casual: [1],
  world: [1, 2, 3],
  expert: [3],
};

// How many easy-tier entries get pulled to the front of every room's order:
// round 1 stays easy (first impressions) even if the opening image is dead
// and the host burns through a couple of entries.
export const EASY_LEAD = 3;

export function normalizeDifficulty(value) {
  return DIFFICULTIES.includes(value) ? value : DIFFICULTY_DEFAULT;
}

// The entry's scored tier, or null when unscored (pre-S3 pool data).
export function entryTier(entry) {
  const d = entry && entry.difficulty;
  return d === 1 || d === 2 || d === 3 ? d : null;
}

// Unscored entries match every difficulty; unknown difficulty matches all.
export function tierEligible(entry, difficulty) {
  const tiers = DIFFICULTY_TIERS[difficulty];
  const t = entryTier(entry);
  return !tiers || t === null || tiers.includes(t);
}

// Difficulty-aware deterministic order: the room's seeded shuffle filtered
// to the difficulty's tiers, with the first EASY_LEAD easy entries of the
// WHOLE pool (shuffle order) pulled to the front — every room opens on a
// recognizable place, Expert rooms included. On an unscored pool the lead
// is empty and every entry is eligible, i.e. the plain seeded shuffle.
export function orderedPool(pool, roomCode, difficulty) {
  const shuffled = shuffledPool(pool, roomCode);
  const lead = [];
  for (const e of shuffled) {
    if (lead.length >= EASY_LEAD) break;
    if (entryTier(e) === 1) lead.push(e);
  }
  const leadIds = new Set(lead.map((e) => e.image_id));
  return lead.concat(shuffled.filter(
    (e) => !leadIds.has(e.image_id) && tierEligible(e, difficulty)));
}

// Cursor-based sampling without replacement. The host persists the cursor in
// the room state so refresh/resume continues from the right place, and bumps
// it past dead imagery when MapillaryJS fails to load an entry.
export class PoolSampler {
  // difficulty: a DIFFICULTIES name for rooms created with the S3 setting,
  // or null/undefined for the legacy full-pool order. Rooms persisted
  // before the setting existed carry no difficulty and MUST rebuild the
  // exact order they started with, so the legacy path stays untouched.
  constructor(pool, roomCode, cursor = 0, difficulty = null) {
    this.order = difficulty
      ? orderedPool(pool, roomCode, difficulty)
      : shuffledPool(pool, roomCode);
    this.cursor = cursor;
  }

  // Entry at the current cursor (or null when exhausted). Does not advance.
  peek() {
    return this.cursor < this.order.length ? this.order[this.cursor] : null;
  }

  advance() {
    this.cursor++;
    return this.peek();
  }
}
