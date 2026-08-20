// Tests for js/pool.js — seeded shuffle determinism, cursor-based sampling
// without replacement (the resume contract), and the S3 difficulty tiers
// (tier filtering + the easy-first-round guard).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shuffledPool,
  orderedPool,
  PoolSampler,
  entryTier,
  tierEligible,
  normalizeDifficulty,
  DIFFICULTIES,
  DIFFICULTY_DEFAULT,
  EASY_LEAD,
} from "../js/pool.js";

const pool = Array.from({ length: 200 }, (_, i) => ({
  image_id: `img-${i}`,
  lat: i,
  lng: -i,
}));

// A scored pool: tiers cycle 1,2,3,1,2,3,... so every tier is well
// represented and interleaved in any shuffle.
const scoredPool = Array.from({ length: 210 }, (_, i) => ({
  image_id: `img-${i}`,
  lat: i,
  lng: -i,
  difficulty: (i % 3) + 1,
}));

test("shuffledPool: deterministic for the same room code", () => {
  const a = shuffledPool(pool, "KWPF");
  const b = shuffledPool(pool, "KWPF");
  assert.deepEqual(a.map((e) => e.image_id), b.map((e) => e.image_id));
});

test("shuffledPool: a permutation — nothing lost, nothing duplicated", () => {
  const shuffled = shuffledPool(pool, "QXJM");
  assert.equal(shuffled.length, pool.length);
  assert.deepEqual(
    shuffled.map((e) => e.image_id).sort(),
    pool.map((e) => e.image_id).sort()
  );
});

test("shuffledPool: different room codes give different orders", () => {
  const a = shuffledPool(pool, "AAAA").map((e) => e.image_id);
  const b = shuffledPool(pool, "ZZZZ").map((e) => e.image_id);
  assert.notDeepEqual(a, b);
});

test("shuffledPool: does not mutate the source pool", () => {
  const before = pool.map((e) => e.image_id);
  shuffledPool(pool, "KWPF");
  assert.deepEqual(pool.map((e) => e.image_id), before);
});

test("shuffledPool: actually shuffles (not the identity order)", () => {
  const shuffled = shuffledPool(pool, "KWPF").map((e) => e.image_id);
  assert.notDeepEqual(shuffled, pool.map((e) => e.image_id));
});

test("PoolSampler: peek does not advance; advance walks without repeats", () => {
  const s = new PoolSampler(pool, "KWPF");
  const first = s.peek();
  assert.equal(s.peek(), first); // peek is idempotent
  const seen = new Set();
  let entry = s.peek();
  while (entry) {
    assert.ok(!seen.has(entry.image_id), `repeat: ${entry.image_id}`);
    seen.add(entry.image_id);
    entry = s.advance();
  }
  assert.equal(seen.size, pool.length); // full pool, no replacement
  assert.equal(s.peek(), null); // exhausted
  assert.equal(s.advance(), null); // stays exhausted
});

test("PoolSampler: resuming from a persisted cursor lands on the same entry", () => {
  const original = new PoolSampler(pool, "KWPF");
  for (let i = 0; i < 7; i++) original.advance();
  // A refreshed host rebuilds the sampler from the room's saved cursor and
  // must continue exactly where the game left off.
  const resumed = new PoolSampler(pool, "KWPF", original.cursor);
  assert.equal(resumed.peek().image_id, original.peek().image_id);
  // The in-flight round's entry is order[cursor - 1] (the resume contract
  // host-ui relies on to restore currentTruth).
  assert.equal(
    resumed.order[resumed.cursor - 1].image_id,
    original.order[original.cursor - 1].image_id
  );
});

/* ================================================================
 * S3 difficulty tiers
 * ================================================================ */

test("entryTier: scored tiers pass through, anything else is unscored", () => {
  assert.equal(entryTier({ difficulty: 1 }), 1);
  assert.equal(entryTier({ difficulty: 3 }), 3);
  assert.equal(entryTier({}), null); // pre-S3 pool data
  assert.equal(entryTier({ difficulty: "2" }), null); // corrupt: not a tier
  assert.equal(entryTier({ difficulty: 7 }), null);
  assert.equal(entryTier(null), null);
});

test("normalizeDifficulty: known names pass, everything else defaults", () => {
  for (const d of DIFFICULTIES) assert.equal(normalizeDifficulty(d), d);
  assert.equal(normalizeDifficulty(undefined), DIFFICULTY_DEFAULT);
  assert.equal(normalizeDifficulty("nightmare"), DIFFICULTY_DEFAULT);
});

test("tierEligible: casual is easy-only, expert hard-only, world takes all", () => {
  const [easy, medium, hard] = [1, 2, 3].map((difficulty) => ({ difficulty }));
  assert.ok(tierEligible(easy, "casual") && !tierEligible(medium, "casual") &&
    !tierEligible(hard, "casual"));
  assert.ok(!tierEligible(easy, "expert") && !tierEligible(medium, "expert") &&
    tierEligible(hard, "expert"));
  for (const e of [easy, medium, hard]) assert.ok(tierEligible(e, "world"));
  // Unscored entries are wildcards; unknown difficulties match everything.
  assert.ok(tierEligible({}, "casual") && tierEligible({}, "expert"));
  assert.ok(tierEligible(hard, "someday-new-mode"));
});

test("orderedPool: deterministic and duplicate-free for the same room", () => {
  const a = orderedPool(scoredPool, "KWPF", "world");
  const b = orderedPool(scoredPool, "KWPF", "world");
  assert.deepEqual(a.map((e) => e.image_id), b.map((e) => e.image_id));
  assert.equal(new Set(a.map((e) => e.image_id)).size, a.length);
  // World tour is the full pool — nothing filtered out, just reordered.
  assert.equal(a.length, scoredPool.length);
});

test("orderedPool: the easy first-round guard leads every difficulty", () => {
  for (const difficulty of DIFFICULTIES) {
    const order = orderedPool(scoredPool, "QXJM", difficulty);
    for (let i = 0; i < EASY_LEAD; i++) {
      assert.equal(entryTier(order[i]), 1,
        `${difficulty}: order[${i}] must be easy (first impressions)`);
    }
  }
});

test("orderedPool: after the lead, only the difficulty's tiers remain", () => {
  const casual = orderedPool(scoredPool, "QXJM", "casual");
  assert.ok(casual.every((e) => entryTier(e) === 1));
  const expert = orderedPool(scoredPool, "QXJM", "expert");
  assert.ok(expert.slice(EASY_LEAD).every((e) => entryTier(e) === 3));
  // Nothing eligible is lost: every hard entry is in the expert order.
  assert.equal(expert.length,
    EASY_LEAD + scoredPool.filter((e) => e.difficulty === 3).length);
});

test("orderedPool: an unscored pool degrades to the plain seeded shuffle", () => {
  // Pre-re-score deploy window: the setting exists, the data does not yet.
  for (const difficulty of DIFFICULTIES) {
    assert.deepEqual(
      orderedPool(pool, "KWPF", difficulty).map((e) => e.image_id),
      shuffledPool(pool, "KWPF").map((e) => e.image_id));
  }
});

test("orderedPool: unscored entries in a scored pool stay in every difficulty", () => {
  const mixed = scoredPool.map((e, i) =>
    i % 7 === 0 ? { image_id: e.image_id, lat: e.lat, lng: e.lng } : e);
  const expert = orderedPool(mixed, "QXJM", "expert");
  const wildcards = mixed.filter((e) => entryTier(e) === null).length;
  const hard = mixed.filter((e) => entryTier(e) === 3).length;
  // Lead may be shorter than EASY_LEAD here; everything else must be
  // hard or wildcard.
  const lead = expert.filter((e) => entryTier(e) === 1).length;
  assert.equal(expert.length, lead + hard + wildcards);
});

test("PoolSampler: without a difficulty the legacy order is untouched", () => {
  // Rooms persisted before S3 must rebuild the exact order they started
  // with — even against a freshly re-scored pool.
  const s = new PoolSampler(scoredPool, "KWPF", 5);
  assert.deepEqual(
    s.order.map((e) => e.image_id),
    shuffledPool(scoredPool, "KWPF").map((e) => e.image_id));
});

test("PoolSampler: a difficulty room resumes onto the same entry", () => {
  const original = new PoolSampler(scoredPool, "KWPF", 0, "expert");
  for (let i = 0; i < 6; i++) original.advance();
  const resumed = new PoolSampler(scoredPool, "KWPF", original.cursor, "expert");
  assert.equal(resumed.peek().image_id, original.peek().image_id);
  assert.equal(
    resumed.order[resumed.cursor - 1].image_id,
    original.order[original.cursor - 1].image_id);
});

test("PoolSampler: round 1 of every new room is easy on a scored pool", () => {
  for (const difficulty of DIFFICULTIES) {
    const s = new PoolSampler(scoredPool, "ZZAA", 0, difficulty);
    assert.equal(entryTier(s.peek()), 1);
    // ...and stays easy through a couple of dead-image skips.
    assert.equal(entryTier(s.advance()), 1);
    assert.equal(entryTier(s.advance()), 1);
  }
});

/* ================================================================
 * §13 quarantine: loadPool filters proposal-reviewed dead ids.
 * Each case imports a FRESH module instance (the query string defeats the
 * ESM cache) because loadPool memoizes the pool by design.
 * ================================================================ */

const FAKE_POOL = [
  { image_id: "alive-1", lat: 1, lng: 1 },
  { image_id: "dead-1", lat: 2, lng: 2 },
  { image_id: "alive-2", lat: 3, lng: 3 },
];

// Minimal fetch double: routes by URL, `null` means "file not there".
function stubFetch(routes) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = (url) => {
    seen.push(String(url));
    const body = routes[String(url)];
    if (body === undefined) return Promise.reject(new Error("not found"));
    if (body === null) return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
}

test("loadPool: quarantined ids are filtered out of the loaded pool", async () => {
  const f = stubFetch({
    "data/location_pool.json": FAKE_POOL,
    "data/pool_quarantine.json": ["dead-1"],
  });
  try {
    const mod = await import("../js/pool.js?case=quarantined");
    const pool = await mod.loadPool();
    assert.deepEqual(pool.map((e) => e.image_id), ["alive-1", "alive-2"]);
  } finally { f.restore(); }
});

test("loadPool: an absent quarantine file is a no-op (file:// / old checkouts)", async () => {
  const f = stubFetch({ "data/location_pool.json": FAKE_POOL });
  try {
    const mod = await import("../js/pool.js?case=absent");
    const pool = await mod.loadPool();
    assert.equal(pool.length, 3);
  } finally { f.restore(); }
});

test("loadPool: a 404 or malformed quarantine file is a no-op too", async () => {
  const f = stubFetch({
    "data/location_pool.json": FAKE_POOL,
    "data/pool_quarantine.json": null,
  });
  try {
    const mod = await import("../js/pool.js?case=404");
    assert.equal((await mod.loadPool()).length, 3);
  } finally { f.restore(); }

  const g = stubFetch({
    "data/location_pool.json": FAKE_POOL,
    "data/pool_quarantine.json": { not: "an array" },
  });
  try {
    const mod = await import("../js/pool.js?case=malformed");
    assert.equal((await mod.loadPool()).length, 3);
  } finally { g.restore(); }
});

test("loadPool: the pool itself failing still throws (unchanged behavior)", async () => {
  const f = stubFetch({ "data/location_pool.json": null });
  try {
    const mod = await import("../js/pool.js?case=poolfail");
    await assert.rejects(() => mod.loadPool(), /Failed to load location pool: 404/);
  } finally { f.restore(); }
});

test("the shipped quarantine file is a valid (empty) id array", async () => {
  const { readFileSync } = await import("node:fs");
  const raw = JSON.parse(readFileSync(
    new URL("../data/pool_quarantine.json", import.meta.url), "utf8"));
  assert.ok(Array.isArray(raw));
  for (const id of raw) assert.equal(typeof id, "string");
});
