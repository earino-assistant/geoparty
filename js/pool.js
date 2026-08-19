// pool.js — location pool loading + sampling without replacement (spec §9).
// Entries are passed through verbatim: {image_id, lng, lat, viewer_url,
// thumb, name}, where `name` is the pre-geocoded human-readable place name
// the reveal UI displays (tools/name_location_pool.py).
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

// Cursor-based sampling without replacement. The host persists the cursor in
// the room state so refresh/resume continues from the right place, and bumps
// it past dead imagery when MapillaryJS fails to load an entry.
export class PoolSampler {
  constructor(pool, roomCode, cursor = 0) {
    this.order = shuffledPool(pool, roomCode);
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
