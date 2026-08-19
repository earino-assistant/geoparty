// Tests for js/pool.js — seeded shuffle determinism and cursor-based
// sampling without replacement (the resume contract).
import { test } from "node:test";
import assert from "node:assert/strict";
import { shuffledPool, PoolSampler } from "../js/pool.js";

const pool = Array.from({ length: 200 }, (_, i) => ({
  image_id: `img-${i}`,
  lat: i,
  lng: -i,
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
