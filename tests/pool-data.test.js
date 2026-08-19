// Integrity tests for data/location_pool.json — the game's location pool
// is a production asset; this guards against a bad regeneration slipping in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pool = JSON.parse(
  await readFile(new URL("../data/location_pool.json", import.meta.url), "utf8")
);

test("pool: a non-trivial array", () => {
  assert.ok(Array.isArray(pool));
  assert.ok(pool.length >= 1000, `pool shrank to ${pool.length} entries`);
});

test("pool: every entry has the fields gameplay depends on", () => {
  for (const e of pool) {
    assert.equal(typeof e.image_id, "string");
    assert.ok(e.image_id.length > 0);
    assert.equal(typeof e.lat, "number");
    assert.equal(typeof e.lng, "number");
    assert.ok(Number.isFinite(e.lat) && Number.isFinite(e.lng));
  }
});

test("pool: coordinates are on the planet", () => {
  for (const e of pool) {
    assert.ok(e.lat >= -90 && e.lat <= 90, `bad lat ${e.lat} (${e.image_id})`);
    assert.ok(e.lng >= -180 && e.lng <= 180, `bad lng ${e.lng} (${e.image_id})`);
  }
});

test("pool: image ids are unique (sampling without replacement assumes it)", () => {
  const ids = new Set(pool.map((e) => e.image_id));
  assert.equal(ids.size, pool.length);
});

test("pool: names, when present, are non-empty strings", () => {
  for (const e of pool) {
    if ("name" in e && e.name !== null) {
      assert.equal(typeof e.name, "string", `bad name on ${e.image_id}`);
      assert.ok(e.name.trim().length > 0, `blank name on ${e.image_id}`);
    }
  }
});
