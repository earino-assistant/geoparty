// Tests for js/supersure.js — the SUPER SURE pin (M6): once-per-game
// availability, win/lose/burn resolution, ties, the ×2/0 adjustment, and
// the settlement patch the reveal flip carries.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  superSureAvailable,
  resolveSuperSure,
  adjustedPoints,
  superSureSettlement,
  superSureLabel,
} from "../js/supersure.js";

/* ---------------- availability: one bet per game ---------------- */

test("superSureAvailable: fresh team has its bet, spent team does not", () => {
  const teams = {
    t1: { name: "A", total: 0 },
    t2: { name: "B", total: 0, superSureUsed: 3 },
  };
  assert.equal(superSureAvailable(teams, "t1"), true);
  assert.equal(superSureAvailable(teams, "t2"), false);
  assert.equal(superSureAvailable(teams, "t9"), false); // unknown team
  assert.equal(superSureAvailable(null, "t1"), false);
});

test("superSureAvailable: carryTeams-style reset restores the bet", async () => {
  // carryTeams copies only name/total/deviceId/joinedAt — superSureUsed
  // must not survive into the next game.
  const { carryTeams } = await import("../js/h2h.js");
  const next = carryTeams({ t1: { name: "A", total: 900, superSureUsed: 2 } });
  assert.equal(superSureAvailable(next, "t1"), true);
});

/* ---------------- resolution ---------------- */

const pin = (distanceKm, points, superSure) => ({
  guess: { lat: 0, lng: 0 }, distanceKm, points,
  superSure: superSure || null,
});

test("resolveSuperSure: nobody bet → no outcomes", () => {
  assert.deepEqual(resolveSuperSure({ t1: pin(10, 4000), t2: pin(90, 2000) }), {});
  assert.deepEqual(resolveSuperSure({}), {});
  assert.deepEqual(resolveSuperSure(null), {});
});

test("resolveSuperSure: closest bettor wins, out-guessed bettor loses", () => {
  const results = {
    t1: pin(10, 4000, true),
    t2: pin(90, 2000),
  };
  assert.deepEqual(resolveSuperSure(results), { t1: "won" });
  const outgunned = {
    t1: pin(90, 2000, true),
    t2: pin(10, 4000),
  };
  assert.deepEqual(resolveSuperSure(outgunned), { t1: "lost" });
});

test("resolveSuperSure: a lone pin is closest by definition (couch solo)", () => {
  assert.deepEqual(resolveSuperSure({ t1: pin(5000, 200, true) }), { t1: "won" });
});

test("resolveSuperSure: equally-closest super-sure pins ALL win", () => {
  const results = {
    t1: pin(50, 3000, true),
    t2: pin(50, 3100, true),
    t3: pin(900, 1000),
  };
  assert.deepEqual(resolveSuperSure(results), { t1: "won", t2: "won" });
});

test("resolveSuperSure: a tie with a non-bettor is not 'closer' — bet wins", () => {
  const results = {
    t1: pin(50, 3000, true),
    t2: pin(50, 3000),
  };
  assert.deepEqual(resolveSuperSure(results), { t1: "won" });
});

test("resolveSuperSure: armed with no pin at the buzzer burns", () => {
  const results = {
    t1: { guess: null, distanceKm: null, points: 0, forfeited: true, superSure: true },
    t2: pin(400, 1800),
  };
  assert.deepEqual(resolveSuperSure(results), { t1: "burned" });
});

test("resolveSuperSure: burned even when everyone forfeited", () => {
  const results = {
    t1: { guess: null, points: 0, forfeited: true, superSure: true },
    t2: { guess: null, points: 0, forfeited: true },
  };
  assert.deepEqual(resolveSuperSure(results), { t1: "burned" });
});

/* ---------------- adjustment ---------------- */

test("adjustedPoints: won doubles, lost and burned zero, plain rows untouched", () => {
  assert.equal(adjustedPoints({ points: 3000 }), 3000);
  assert.equal(adjustedPoints({ points: 3000, superSure: true, superSureOutcome: "won" }), 6000);
  assert.equal(adjustedPoints({ points: 3000, superSure: true, superSureOutcome: "lost" }), 0);
  assert.equal(adjustedPoints({ points: 0, superSure: true, superSureOutcome: "burned" }), 0);
  assert.equal(adjustedPoints(null), 0);
});

test("adjustedPoints: unresolved bet stays raw (pre-settlement safety)", () => {
  assert.equal(adjustedPoints({ points: 3000, superSure: true }), 3000);
});

/* ---------------- settlement ---------------- */

test("settlement: winner's total doubles the round, marker written", () => {
  // t1 banked 1000 + 3000 raw at lock-in; winning the bet adds the raw
  // points again → the round paid 2×.
  const teams = { t1: { total: 4000 }, t2: { total: 2000 } };
  const results = { t1: pin(10, 3000, true), t2: pin(90, 2000) };
  const { outcomes, patch } = superSureSettlement(teams, results);
  assert.deepEqual(outcomes, { t1: "won" });
  assert.deepEqual(patch, {
    "round/results/t1/superSureOutcome": "won",
    "teams/t1/total": 7000,
  });
});

test("settlement: loser's total returns exactly to its pre-round value", () => {
  // "The running total never dips below what they already had": t1 came
  // into the round with 5000, banked 2000 raw, loses the bet → 5000.
  const teams = { t1: { total: 7000 }, t2: { total: 3000 } };
  const results = { t1: pin(900, 2000, true), t2: pin(10, 4500) };
  const { outcomes, patch } = superSureSettlement(teams, results);
  assert.deepEqual(outcomes, { t1: "lost" });
  assert.equal(patch["teams/t1/total"], 5000);
  assert.ok(!("teams/t2/total" in patch), "non-bettors are untouched");
});

test("settlement: burned bet moves no points but still gets its marker", () => {
  const teams = { t1: { total: 5000 }, t2: { total: 3000 } };
  const results = {
    t1: { guess: null, points: 0, forfeited: true, superSure: true },
    t2: pin(10, 4500),
  };
  const { patch } = superSureSettlement(teams, results);
  assert.equal(patch["round/results/t1/superSureOutcome"], "burned");
  assert.equal(patch["teams/t1/total"], 5000);
});

test("settlement: empty patch when nobody bet", () => {
  const { outcomes, patch } = superSureSettlement(
    { t1: { total: 1 } }, { t1: pin(10, 100) });
  assert.deepEqual(outcomes, {});
  assert.deepEqual(patch, {});
});

test("settlement: racing flip writers compute identical patches", () => {
  // The reveal flip can be pushed by several phones (deadlock guard, last
  // lock-in, sweep). All see the same complete atomic state, so all must
  // write byte-identical settlements — that's what makes the race benign.
  const teams = { t1: { total: 4000 }, t2: { total: 2000 } };
  const results = { t1: pin(10, 3000, true), t2: pin(90, 2000, true) };
  const a = superSureSettlement(teams, results);
  const b = superSureSettlement(
    JSON.parse(JSON.stringify(teams)), JSON.parse(JSON.stringify(results)));
  assert.deepEqual(a, b);
});

/* ---------------- reveal labels ---------------- */

test("superSureLabel: the spec's verbatim badges, empty for non-bets", () => {
  assert.equal(
    superSureLabel({ superSure: true, superSureOutcome: "won" }), "SUPER SURE ×2");
  assert.equal(
    superSureLabel({ superSure: true, superSureOutcome: "lost" }), "SUPER SURE — 0");
  assert.equal(
    superSureLabel({ superSure: true, superSureOutcome: "burned" }), "SUPER SURE — 0");
  assert.equal(superSureLabel({ points: 100 }), "");
  assert.equal(superSureLabel(null), "");
});
