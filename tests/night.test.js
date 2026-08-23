// Tests for js/night.js — Crown Night (G3, spec §3.3, §6.1). The tally fold,
// deterministic game winner (tie-break parity with h2hWinner), champion at
// exactly 3, carry vs. reset-after-champion, late joins at 0, and the tolerant
// load of a malformed/absent night.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CROWNS_TO_WIN,
  defaultNight,
  normalizeNight,
  gameWinner,
  bumpNight,
  champion,
  nextNight,
  carryNight,
  gameNight,
  nightSummary,
  tallyLineText,
  crownHookText,
  championText,
} from "../js/night.js";
import { h2hWinner } from "../js/h2h.js";

const teams = {
  t1: { name: "Atlas Cats", total: 9000 },
  t2: { name: "Pin Pals", total: 7000 },
  t3: { name: "Map Rats", total: 9000 },   // ties t1 for the lead
};

/* ---------------- load posture ---------------- */

test("normalizeNight: malformed / absent / wrong-version → fresh", () => {
  assert.deepEqual(normalizeNight(null), defaultNight());
  assert.deepEqual(normalizeNight(undefined), defaultNight());
  assert.deepEqual(normalizeNight("nope"), defaultNight());
  assert.deepEqual(normalizeNight({ v: 99, games: 5 }), defaultNight());
  // A valid night is preserved and its crowns coerced to clean ints.
  const n = normalizeNight({ v: 1, games: 2, crowns: { t1: 2, t2: 1, bad: "x" } });
  assert.deepEqual(n, { v: 1, games: 2, crowns: { t1: 2, t2: 1 } });
});

/* ---------------- winner + tie-break parity ---------------- */

test("gameWinner: standings leader, ties broken exactly like h2hWinner", () => {
  const solo = { t1: { name: "A", total: 100 }, t2: { name: "B", total: 50 } };
  assert.equal(gameWinner(solo, "ROOMAB"), "t1");
  // A tie: parity with h2h's deterministic seeded flip across many codes.
  for (const code of ["AAAAAA", "ROOMXY", "ZZTOPQ", "GEOOOO", "MAPRAT"]) {
    assert.equal(gameWinner(teams, code), h2hWinner(teams, code));
  }
});

/* ---------------- the fold ---------------- */

test("bumpNight: games+1 and a crown for the winner", () => {
  let n = defaultNight();
  n = bumpNight(n, "t1");
  assert.deepEqual(n, { v: 1, games: 1, crowns: { t1: 1 } });
  n = bumpNight(n, "t2");
  n = bumpNight(n, "t1");
  assert.deepEqual(n, { v: 1, games: 3, crowns: { t1: 2, t2: 1 } });
});

test("champion: only at exactly 3 crowns", () => {
  let n = defaultNight();
  n = bumpNight(n, "t1");
  n = bumpNight(n, "t1");
  assert.equal(champion(n), null);         // 2 crowns — not yet
  n = bumpNight(n, "t1");
  assert.equal(champion(n), "t1");         // 3 — champion
});

test("nextNight / carryNight: reset after a champion, carry otherwise", () => {
  let n = defaultNight();
  n = bumpNight(n, "t1");
  n = bumpNight(n, "t2");
  // No champion yet → carry forward, bumping for the next winner.
  const carried = carryNight(n, "t1");
  assert.deepEqual(carried, { v: 1, games: 3, crowns: { t1: 2, t2: 1 } });
  // The crown that reaches 3 resets the night for the next game.
  const crowning = bumpNight(carried, "t1");   // t1 → 3
  assert.equal(champion(crowning), "t1");
  assert.deepEqual(nextNight(crowning), defaultNight());
  assert.deepEqual(carryNight(carried, "t1"), defaultNight());
});

test("late join: a new slot starts at 0 crowns", () => {
  let n = bumpNight(bumpNight(defaultNight(), "t1"), "t1");   // t1: 2
  n = bumpNight(n, "t4");   // a team that joined mid-night
  assert.equal(n.crowns.t4, 1);
  assert.equal(n.crowns.t1, 2);
});

/* ---------------- formatting ---------------- */

test("nightSummary / tallyLineText: sorted, named, invisible before game 2", () => {
  const empty = defaultNight();
  assert.deepEqual(nightSummary(empty, teams), []);
  assert.equal(tallyLineText(empty, teams), "");
  let n = bumpNight(defaultNight(), "t1");
  n = bumpNight(n, "t1");
  n = bumpNight(n, "t2");
  assert.deepEqual(nightSummary(n, teams).map((r) => `${r.name}:${r.crowns}`),
    ["Atlas Cats:2", "Pin Pals:1"]);
  assert.equal(tallyLineText(n, teams),
    `👑 Atlas Cats ×2 · Pin Pals ×1 — first to ${CROWNS_TO_WIN} takes the night`);
  assert.equal(crownHookText(n, teams, 4), "👑 Atlas Cats ×2 · Pin Pals ×1 — Game 4 next?");
  assert.equal(championText("Atlas Cats"), "👑 CHAMPION OF THE NIGHT — Atlas Cats");
});

// R2: gameNight resolves a game-over's crown deterministically, so the finish
// path and a host-refresh recompute BYTE-IDENTICAL results — the night survives
// a refresh between games. RTDB holds only the pre-bump seeded night; the crown
// must be reconstructable from (night, teams, roomCode) alone.
test("gameNight: refresh recompute reproduces the same bump + carry", () => {
  const teams = { t1: { total: 900 }, t2: { total: 400 } };
  const seeded = { v: 1, games: 1, crowns: { t1: 1 } }; // carried into this game
  const a = gameNight(seeded, teams, "ROOMAB");
  const b = gameNight(seeded, teams, "ROOMAB"); // the refresh recompute
  assert.deepEqual(a, b);
  assert.equal(a.winner, "t1");
  assert.deepEqual(a.bumped, bumpNight(seeded, "t1"));
  assert.deepEqual(a.carry, carryNight(seeded, "t1"));
  assert.equal(a.champ, null); // t1 at 2 crowns, not yet champion
});

test("gameNight: at the third crown it reports the champion and resets the carry", () => {
  const teams = { t1: { total: 900 }, t2: { total: 400 } };
  const seeded = { v: 1, games: 2, crowns: { t1: 2 } };
  const ng = gameNight(seeded, teams, "ROOMCD");
  assert.equal(ng.winner, "t1");
  assert.equal(ng.bumped.crowns.t1, 3);
  assert.equal(ng.champ, "t1");
  assert.deepEqual(ng.carry, defaultNight()); // a champion resets the night
});

test("gameNight: tolerates a malformed/absent night (fresh) and the seeded flip is stable", () => {
  const teams = { t1: { total: 500 }, t2: { total: 500 } }; // a true tie
  const ng1 = gameNight(null, teams, "ROOMEF");
  const ng2 = gameNight(undefined, teams, "ROOMEF");
  assert.equal(ng1.winner, ng2.winner);       // deterministic tie-break
  assert.equal(ng1.bumped.games, 1);
  assert.equal(ng1.bumped.crowns[ng1.winner], 1);
});
