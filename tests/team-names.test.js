// Tests for js/team-names.js — the geography-pun bank + this device's
// recent-team-name memory (team-roster brief).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GEO_PUNS,
  randomPun,
  recentTeams,
  rememberTeam,
  suggestTeams,
  lastTeam,
  _setStorage,
} from "../js/team-names.js";

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
}

test.beforeEach(() => {
  _setStorage(memStorage()); // every test starts from a fresh, empty device
});

/* ---------------- GEO_PUNS ---------------- */

test("GEO_PUNS: 100 unique, non-empty strings", () => {
  assert.equal(GEO_PUNS.length, 100);
  assert.equal(new Set(GEO_PUNS.map((p) => p.toLowerCase())).size, 100);
  for (const p of GEO_PUNS) assert.equal(typeof p, "string");
});

/* ---------------- randomPun ---------------- */

test("randomPun: always returns a bank entry", () => {
  for (let i = 0; i < 25; i++) {
    assert.ok(GEO_PUNS.includes(randomPun()));
  }
});

test("randomPun: deterministic under a numeric seed", () => {
  const a = randomPun(42);
  const b = randomPun(42);
  assert.equal(a, b);
  assert.ok(GEO_PUNS.includes(a));
});

test("randomPun: deterministic under an injected rng function", () => {
  assert.equal(randomPun(() => 0), GEO_PUNS[0]);
  assert.equal(randomPun(() => 0.9999), GEO_PUNS[GEO_PUNS.length - 1]);
});

test("randomPun: different seeds can produce different puns", () => {
  // Seeds pick different indices across the bank. Robust to any pun-list
  // contents/length: assert we see more than one distinct index distribution
  // region rather than a specific pun. With 100 entries, a handful of seeds
  // spread across the range must land somewhere non-uniform.
  const indices = new Set();
  for (let seed = 0; seed < 20; seed++) {
    // recover the chosen index by scanning for the returned pun
    const p = randomPun(seed);
    indices.add(GEO_PUNS.indexOf(p));
  }
  // A real PRNG over 20 seeds across a 100-length bank can't all hit the same
  // index; allow a couple collisions but require spread.
  assert.ok(indices.size >= 3, `expected spread across seeds, got ${indices.size}`);
});

/* ---------------- rememberTeam / recentTeams / lastTeam ---------------- */

test("recentTeams: empty device → []", () => {
  assert.deepEqual(recentTeams(), []);
  assert.equal(lastTeam(), "");
});

test("rememberTeam: adds to the front, persists, and returns the list", () => {
  const out = rememberTeam("The Atlas Cats");
  assert.deepEqual(out, ["The Atlas Cats"]);
  assert.deepEqual(recentTeams(), ["The Atlas Cats"]);
  assert.equal(lastTeam(), "The Atlas Cats");
});

test("rememberTeam: most-recent-first order", () => {
  rememberTeam("Alpha");
  rememberTeam("Bravo");
  rememberTeam("Charlie");
  assert.deepEqual(recentTeams(), ["Charlie", "Bravo", "Alpha"]);
  assert.equal(lastTeam(), "Charlie");
});

test("rememberTeam: re-adding an existing name (case-insensitive) moves it to front, no duplicate", () => {
  rememberTeam("Alpha");
  rememberTeam("Bravo");
  rememberTeam("alpha"); // same team, different case
  assert.deepEqual(recentTeams(), ["alpha", "Bravo"]);
});

test("rememberTeam: caps at 5, dropping the oldest", () => {
  for (const name of ["One", "Two", "Three", "Four", "Five", "Six"]) {
    rememberTeam(name);
  }
  assert.deepEqual(recentTeams(), ["Six", "Five", "Four", "Three", "Two"]);
});

test("rememberTeam: blank/whitespace-only name is a no-op", () => {
  rememberTeam("Alpha");
  const out = rememberTeam("   ");
  assert.deepEqual(out, ["Alpha"]);
  assert.deepEqual(recentTeams(), ["Alpha"]);
});

test("recentTeams: max caps the returned slice independent of storage cap", () => {
  for (const name of ["One", "Two", "Three", "Four", "Five"]) rememberTeam(name);
  assert.deepEqual(recentTeams(2), ["Five", "Four"]);
});

/* ---------------- suggestTeams ---------------- */

test("suggestTeams: empty input → no suggestions", () => {
  rememberTeam("Alpha");
  assert.deepEqual(suggestTeams(""), []);
  assert.deepEqual(suggestTeams("   "), []);
});

test("suggestTeams: matches recent teams before puns, case-insensitive substring", () => {
  rememberTeam("The Kenya Believers"); // a recent team
  const out = suggestTeams("kenya");
  assert.equal(out[0], "The Kenya Believers"); // recent team ranks first
  assert.ok(out.some((n) => n.toLowerCase().includes("kenya believe it"))); // pun bank match too
});

test("suggestTeams: dedupes case-insensitive matches between recent + puns", () => {
  rememberTeam("Kenya Believe It"); // same text as a pun, different case use
  const out = suggestTeams("kenya");
  assert.equal(out.filter((n) => n.toLowerCase() === "kenya believe it").length, 1);
});

test("suggestTeams: caps at limit", () => {
  const out = suggestTeams("a", 3);
  assert.equal(out.length, 3);
});

test("suggestTeams: no match → []", () => {
  assert.deepEqual(suggestTeams("zzzzznomatch"), []);
});

/* ---------------- localStorage-unavailable safety ---------------- */

test("localStorage unavailable (null storage): every function is a safe no-op, never throws", () => {
  _setStorage(null);
  assert.doesNotThrow(() => {
    assert.deepEqual(recentTeams(), []);
    assert.equal(lastTeam(), "");
    // rememberTeam still hands back the computed list for this call (so the
    // UI can use it immediately); it just never survives to the next call.
    assert.deepEqual(rememberTeam("Alpha"), ["Alpha"]);
    assert.deepEqual(recentTeams(), []); // ...confirmed: nothing persisted
    assert.ok(Array.isArray(suggestTeams("al"))); // still pun matches — just no recents
    assert.ok(GEO_PUNS.includes(randomPun()));
  });
});

test("a storage whose getItem/setItem throw is treated as unavailable, never throws", () => {
  _setStorage({
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  });
  assert.doesNotThrow(() => {
    assert.deepEqual(recentTeams(), []);
    assert.deepEqual(rememberTeam("Alpha"), ["Alpha"]);
    assert.deepEqual(recentTeams(), []); // still unreadable — never persisted
  });
});
