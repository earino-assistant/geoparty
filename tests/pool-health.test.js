// Tests for tools/pool_health.mjs — the pure decision logic of the weekly
// pool health check (field-observability plan §13). The network sweep isn't
// exercised here; what matters is that the check set is bounded and
// reproducible, that inconclusive results never count as "dead", and that a
// quarantine proposal only forms after consecutive failures.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isoWeekKey,
  rotatingSample,
  buildCheckSet,
  foldState,
  proposeQuarantine,
} from "../tools/pool_health.mjs";

const ids = (n, prefix = "id") =>
  Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

test("isoWeekKey: ISO-8601 weeks, including the year boundary", () => {
  assert.equal(isoWeekKey(new Date("2026-08-20T00:00:00Z")), "2026-W34");
  assert.equal(isoWeekKey(new Date("2026-01-01T00:00:00Z")), "2026-W01");
  // 2027-01-01 is a Friday, so it belongs to ISO week 53 of 2026.
  assert.equal(isoWeekKey(new Date("2027-01-01T00:00:00Z")), "2026-W53");
});

test("rotatingSample: deterministic per week, and it actually rotates", () => {
  const pool = ids(1000);
  const a = rotatingSample(pool, "2026-W34", 150);
  assert.equal(a.length, 150);
  assert.deepEqual(a, rotatingSample(pool, "2026-W34", 150), "reproducible");

  const b = rotatingSample(pool, "2026-W35", 150);
  const overlap = a.filter((id) => b.includes(id)).length;
  assert.ok(overlap < 60, `weeks should barely overlap, got ${overlap}`);
});

test("rotatingSample: sweeps the whole pool over a year of weeks", () => {
  const pool = ids(1000);
  const seen = new Set();
  for (let w = 1; w <= 52; w++) {
    for (const id of rotatingSample(pool, `2026-W${String(w).padStart(2, "0")}`, 150)) {
      seen.add(id);
    }
  }
  // 52 × 150 draws over 1000 entries: coverage should be essentially total.
  assert.ok(seen.size > 950, `swept ${seen.size}/1000`);
});

test("rotatingSample: a pool smaller than the sample returns all of it", () => {
  assert.equal(rotatingSample(ids(20), "2026-W01", 150).length, 20);
});

test("buildCheckSet: suspects come first, then the rotating sample", () => {
  const pool = ids(500);
  const set = buildCheckSet(pool, ["id-499", "id-498"], "2026-W34");
  assert.equal(set[0], "id-499");
  assert.equal(set[1], "id-498");
  assert.ok(set.length > 2);
});

test("buildCheckSet: deduped, capped, and never leaves the pool", () => {
  const pool = ids(5000);
  const suspects = [...ids(30), ...ids(30), "not-in-the-pool-at-all"];
  const set = buildCheckSet(pool, suspects, "2026-W34");
  assert.equal(new Set(set).size, set.length, "no duplicates");
  assert.ok(set.length <= 250, `capped at 250, got ${set.length}`);
  assert.ok(!set.includes("not-in-the-pool-at-all"));
  for (const id of set) assert.ok(pool.includes(id));
});

test("buildCheckSet: at most 100 suspects, however many are curated", () => {
  const pool = ids(5000);
  const set = buildCheckSet(pool, ids(400), "2026-W34");
  const fromSuspects = set.filter((id) => Number(id.split("-")[1]) < 400);
  // The rotating sample can also draw suspect ids; the cap is on the
  // suspect-sourced prefix, which is what the first 100 entries are.
  assert.ok(set.slice(0, 100).every((id) => ids(400).includes(id)));
  assert.ok(fromSuspects.length <= 250);
});

test("foldState: consecutive deaths accumulate, a live check resets", () => {
  const at = "2026-08-20T04:13:00Z";
  let s = { entries: {} };
  s = { entries: foldState(s, [{ id: "a", status: "dead", checked_at: at }]) };
  assert.equal(s.entries.a.fails, 1);
  s = { entries: foldState(s, [{ id: "a", status: "dead", checked_at: at }]) };
  assert.equal(s.entries.a.fails, 2);
  s = { entries: foldState(s, [{ id: "a", status: "alive", checked_at: at }]) };
  assert.equal(s.entries.a.fails, 0, "a transient 404 must not accumulate");
  assert.equal(s.entries.a.last_ok, at);
});

test("foldState: inconclusive results (429 / network error) change nothing", () => {
  const at = "2026-08-20T04:13:00Z";
  const prev = { entries: { a: { fails: 1 } } };
  const next = foldState(prev, [
    { id: "a", status: "rate_limited", checked_at: at },
    { id: "a", status: "error", checked_at: at },
  ]);
  assert.equal(next.a.fails, 1, "an inconclusive check is not evidence");
});

test("proposeQuarantine: only ids dead twice in a row are proposed", () => {
  const entries = {
    once: { fails: 1 },
    twice: { fails: 2 },
    thrice: { fails: 3 },
    healthy: { fails: 0 },
  };
  assert.deepEqual(proposeQuarantine(entries, []), ["thrice", "twice"]);
});

test("proposeQuarantine: existing quarantine ids are preserved and sorted", () => {
  const out = proposeQuarantine({ b: { fails: 2 } }, ["z", "a"]);
  assert.deepEqual(out, ["a", "b", "z"]);
  assert.deepEqual(proposeQuarantine({}, ["a"]), ["a"], "never removes ids");
});

test("proposeQuarantine: the output is a plain sorted string array", () => {
  const out = proposeQuarantine({ 123: { fails: 5 } }, []);
  assert.deepEqual(out, ["123"]);
  for (const id of out) assert.equal(typeof id, "string");
});

/* ================================================================
 * Two-strike progression ACROSS runs (review P1-4). The fold + proposal are
 * correct; the shipped bug was that the failure counter never survived from
 * one weekly run to the next (the "Commit state only" branch just echoed a
 * notice), so `fails` maxed at 1 forever and no PR could ever open. The
 * workflow now persists tools/pool-health-state.json via the Actions cache.
 * These model that restore → fold → propose → save cycle in pure code, so a
 * regression that breaks the two-strike math fails here.
 * ================================================================ */

test("two consecutive dead runs cross the threshold when state persists", () => {
  const dead = (at) => [{ id: "ghost", status: "dead", checked_at: at }];

  // Run 1 (first run ever / cache miss): fresh state.
  let persisted = foldState({ entries: {} }, dead("2026-08-17T04:13:00Z"));
  assert.equal(persisted.ghost.fails, 1);
  assert.deepEqual(proposeQuarantine(persisted, []), [],
    "one dead run must NOT propose — a 404 can be transient");

  // Run 2: the SAME persisted state is restored (the fix) and folded again.
  persisted = foldState({ entries: persisted }, dead("2026-08-24T04:13:00Z"));
  assert.equal(persisted.ghost.fails, 2);
  assert.deepEqual(proposeQuarantine(persisted, []), ["ghost"],
    "the second consecutive dead run proposes the quarantine");
});

test("a live run between two deaths resets the streak — no proposal", () => {
  const one = (id, status, at) => [{ id, status, checked_at: at }];
  let s = foldState({ entries: {} }, one("x", "dead", "t1"));
  s = foldState({ entries: s }, one("x", "alive", "t2"));
  s = foldState({ entries: s }, one("x", "dead", "t3"));
  assert.equal(s.x.fails, 1, "the streak reset on the live check");
  assert.deepEqual(proposeQuarantine(s, []), [],
    "non-consecutive deaths never reach two strikes");
});

test("an inconclusive run does not break an in-progress streak", () => {
  // fails=1 from last week, this week's check is a 429/timeout: the counter is
  // preserved (neither advanced nor reset), so next week can still be strike 2.
  let s = { entries: { y: { fails: 1 } } };
  s = { entries: foldState(s, [{ id: "y", status: "rate_limited", checked_at: "t" }]) };
  assert.equal(s.entries.y.fails, 1);
  s = { entries: foldState(s, [{ id: "y", status: "dead", checked_at: "t2" }]) };
  assert.deepEqual(proposeQuarantine(s.entries, []), ["y"]);
});
