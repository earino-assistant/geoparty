// Tests for js/game.js — shared couch-mode logic: scoring, distance,
// time bonus, formatting, phase machine, turn schedule.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PHASES,
  canTransition,
  makeRoomCode,
  isValidRoomCode,
  haversineKm,
  scoreForDistance,
  TIME_BONUS_MAX,
  TIME_GRACE_MS,
  NO_LIMIT_BONUS_WINDOW_MS,
  bonusWindowMs,
  timeBonus,
  formatSeconds,
  resultRowText,
  formatDistance,
  formatCountdown,
  teamIds,
  starterIndex,
  isShowdownRound,
  teamForRound,
  showdownOrder,
  showdownResults,
  defaultTeams,
  initialRoomState,
  standings,
} from "../js/game.js";

/* ---------------- haversine ---------------- */

test("haversine: zero distance at the same point", () => {
  assert.equal(haversineKm(48.8566, 2.3522, 48.8566, 2.3522), 0);
});

test("haversine: Paris to London ≈ 343 km", () => {
  const d = haversineKm(48.8566, 2.3522, 51.5074, -0.1278);
  assert.ok(Math.abs(d - 343.5) < 5, `got ${d}`);
});

test("haversine: antipodal points ≈ half the Earth's circumference", () => {
  const d = haversineKm(0, 0, 0, 180);
  assert.ok(Math.abs(d - Math.PI * 6371) < 1, `got ${d}`);
});

test("haversine: crossing the antimeridian is short, not around-the-world", () => {
  // 1° of longitude apart across the date line, at the equator ≈ 111 km.
  const d = haversineKm(0, 179.5, 0, -179.5);
  assert.ok(Math.abs(d - 111.19) < 1, `got ${d}`);
});

test("haversine: symmetric in its arguments", () => {
  const a = haversineKm(35.68, 139.69, -33.87, 151.21); // Tokyo–Sydney
  const b = haversineKm(-33.87, 151.21, 35.68, 139.69);
  assert.ok(Math.abs(a - b) < 1e-9);
});

/* ---------------- distance scoring ---------------- */

test("scoreForDistance: perfect pin is 5000", () => {
  assert.equal(scoreForDistance(0), 5000);
});

test("scoreForDistance: one decay constant (1492 km) is ~5000/e", () => {
  assert.equal(scoreForDistance(1492), Math.round(5000 / Math.E));
});

test("scoreForDistance: strictly non-increasing with distance", () => {
  let prev = Infinity;
  for (const km of [0, 1, 10, 100, 500, 1500, 5000, 10000, 20000]) {
    const s = scoreForDistance(km);
    assert.ok(s <= prev, `score rose at ${km} km`);
    prev = s;
  }
});

test("scoreForDistance: antipodal is effectively zero", () => {
  assert.equal(scoreForDistance(20015), 0);
});

/* ---------------- time bonus ---------------- */

test("timeBonus: instant perfect pin earns the full bonus", () => {
  assert.equal(timeBonus(5000, 0, 120_000), TIME_BONUS_MAX);
});

test("timeBonus: full bonus holds through the grace period", () => {
  assert.equal(timeBonus(5000, TIME_GRACE_MS, 120_000), TIME_BONUS_MAX);
});

test("timeBonus: zero when the window is used up", () => {
  assert.equal(timeBonus(5000, 120_000, 120_000), 0);
  assert.equal(timeBonus(5000, 500_000, 120_000), 0);
});

test("timeBonus: scales with accuracy — a bad instant pin earns ~nothing", () => {
  assert.equal(timeBonus(0, 0, 120_000), 0);
  assert.equal(timeBonus(2500, 0, 120_000), TIME_BONUS_MAX / 2);
  assert.ok(timeBonus(50, 0, 120_000) <= 10);
});

test("timeBonus: quadratic decay — half the window left is a quarter bonus", () => {
  const windowMs = 120_000;
  const grace = Math.min(TIME_GRACE_MS, windowMs * 0.2);
  const span = windowMs - grace;
  const half = timeBonus(5000, grace + span / 2, windowMs);
  assert.equal(half, Math.round(TIME_BONUS_MAX * 0.25));
});

test("timeBonus: monotonically non-increasing in elapsed time", () => {
  let prev = Infinity;
  for (let t = 0; t <= 130_000; t += 5_000) {
    const b = timeBonus(5000, t, 120_000);
    assert.ok(b <= prev, `bonus rose at ${t} ms`);
    prev = b;
  }
});

test("timeBonus: grace is capped at a fifth of a short round", () => {
  // 30s window: grace = 6s, not the flat 10s.
  assert.equal(timeBonus(5000, 6_000, 30_000), TIME_BONUS_MAX);
  assert.ok(timeBonus(5000, 8_000, 30_000) < TIME_BONUS_MAX);
});

test("bonusWindowMs: configured round length, with a no-limit fallback", () => {
  assert.equal(bonusWindowMs(120), 120_000);
  assert.equal(bonusWindowMs(60), 60_000);
  assert.equal(bonusWindowMs(0), NO_LIMIT_BONUS_WINDOW_MS);
});

/* ---------------- room codes ---------------- */

test("room codes: 6 letters, never I or O, always self-valid", () => {
  for (let i = 0; i < 500; i++) {
    const code = makeRoomCode();
    assert.match(code, /^[A-HJ-NP-Z]{6}$/);
    assert.ok(isValidRoomCode(code));
  }
});

test("isValidRoomCode rejects bad shapes", () => {
  for (const bad of ["", "ABCDE", "ABCD", "ABCDEFG", "abcdef", "AB1DEF", "ABIOEF", "A CDEF", null, undefined]) {
    assert.equal(isValidRoomCode(bad), false, `accepted ${bad}`);
  }
});

/* ---------------- phase machine ---------------- */

test("phase machine: the legal loop", () => {
  assert.ok(canTransition("lobby", "roundActive"));
  assert.ok(canTransition("roundActive", "guessing"));
  assert.ok(canTransition("guessing", "reveal"));
  assert.ok(canTransition("reveal", "roundActive"));
  assert.ok(canTransition("reveal", "gameOver"));
  assert.ok(canTransition("gameOver", "lobby"));
});

test("phase machine: illegal jumps are rejected", () => {
  assert.equal(canTransition("lobby", "reveal"), false);
  assert.equal(canTransition("roundActive", "roundActive"), false);
  assert.equal(canTransition("guessing", "lobby"), false);
  assert.equal(canTransition("nonsense", "lobby"), false);
  assert.equal(canTransition(undefined, "lobby"), false);
});

test("PHASES lists every phase the transitions mention", () => {
  assert.deepEqual(
    [...PHASES].sort(),
    ["gameOver", "guessing", "lobby", "reveal", "roundActive"].sort()
  );
});

/* ---------------- formatting ---------------- */

test("formatSeconds: seconds under a minute, m/s form above", () => {
  assert.equal(formatSeconds(23_000), "23s");
  assert.equal(formatSeconds(0), "0s");
  assert.equal(formatSeconds(64_000), "1m 04s");
  assert.equal(formatSeconds(60_000), "1m 00s");
  assert.equal(formatSeconds(-5_000), "0s"); // clock skew never shows negative
});

test("formatDistance: one decimal under 100 km, integers above", () => {
  assert.equal(formatDistance(0), "0.0 km");
  assert.equal(formatDistance(99.94), "99.9 km");
  assert.equal(formatDistance(100), "100 km");
  assert.equal(formatDistance(642.7), "643 km");
});

test("formatCountdown: m:ss, clamped at zero", () => {
  assert.equal(formatCountdown(65_000), "1:05");
  assert.equal(formatCountdown(59_999), "1:00"); // ceil, matches the timer feel
  assert.equal(formatCountdown(1), "0:01");
  assert.equal(formatCountdown(0), "0:00");
  assert.equal(formatCountdown(-3_000), "0:00");
});

test("resultRowText: forfeit, legacy, and speed-bonus row forms", () => {
  assert.equal(resultRowText({ guess: null }), "no pin · +0");
  // Legacy result written before the time bonus existed.
  const legacy = resultRowText({ guess: {}, distanceKm: 250, points: 4200 });
  assert.ok(legacy.includes("250 km"));
  assert.ok(legacy.includes("+4,200") || legacy.includes("+4200")); // locale-safe
  assert.ok(!legacy.includes("⚡"));
  // Modern result shows the speed beat.
  const modern = resultRowText({
    guess: {}, distanceKm: 12.3, points: 5600,
    elapsedMs: 23_000, timeBonus: 800,
  });
  assert.ok(modern.includes("⚡23s"));
  assert.ok(modern.includes("12.3 km"));
});

/* ---------------- teams, turn schedule, standings ---------------- */

const teams3 = {
  t1: { name: "A", total: 100 },
  t2: { name: "B", total: 300 },
  t3: { name: "C", total: 200 },
};

test("teamIds: stable sorted order, safe on null", () => {
  assert.deepEqual(teamIds(teams3), ["t1", "t2", "t3"]);
  assert.deepEqual(teamIds(null), []);
  assert.deepEqual(teamIds(undefined), []);
});

test("starterIndex: deterministic and in range", () => {
  for (const code of ["AAAA", "KWPF", "ZZZZ", ""]) {
    for (const n of [1, 2, 3, 4]) {
      const i = starterIndex(code, n);
      assert.equal(i, starterIndex(code, n)); // deterministic
      assert.ok(i >= 0 && i < n, `${code}/${n} -> ${i}`);
    }
  }
  assert.equal(starterIndex("ABCD", 0), 0); // no teams: safe fallback
});

test("teamForRound: rotation visits every team once per cycle", () => {
  const ids = teamIds(teams3);
  const seen = new Set();
  for (let r = 1; r <= 3; r++) seen.add(teamForRound(teams3, r, "KWPF"));
  assert.deepEqual([...seen].sort(), ids);
});

test("teamForRound: solo guess counts stay within one of even", () => {
  // 3 teams, a 10-round game = 9 solo rounds before the showdown.
  const counts = { t1: 0, t2: 0, t3: 0 };
  for (let r = 1; r <= 9; r++) counts[teamForRound(teams3, r, "QXJM")]++;
  const values = Object.values(counts);
  assert.ok(Math.max(...values) - Math.min(...values) <= 1, JSON.stringify(counts));
});

test("teamForRound: null when there are no teams", () => {
  assert.equal(teamForRound({}, 1, "AAAA"), null);
});

test("isShowdownRound: last round of a multi-team game only", () => {
  const settings = { roundCount: 5 };
  assert.equal(isShowdownRound(teams3, settings, 5), true);
  assert.equal(isShowdownRound(teams3, settings, 4), false);
  assert.equal(isShowdownRound({ t1: { total: 0 } }, settings, 5), false); // solo game
  assert.equal(isShowdownRound(teams3, null, 5), false);
});

test("showdownOrder: leader guesses first, underdog last", () => {
  assert.deepEqual(showdownOrder(teams3), ["t2", "t3", "t1"]);
});

test("showdownResults: closest first for the reveal", () => {
  const round = {
    results: {
      t1: { distanceKm: 900 },
      t2: { distanceKm: 12 },
      t3: { distanceKm: 400 },
    },
  };
  assert.deepEqual(showdownResults(round).map((r) => r.id), ["t2", "t3", "t1"]);
  assert.deepEqual(showdownResults(null), []);
});

test("standings: best first", () => {
  assert.deepEqual(standings(teams3).map((t) => t.id), ["t2", "t3", "t1"]);
});

test("initialRoomState: lobby, cursor zero, active team assigned", () => {
  const teams = defaultTeams();
  const state = initialRoomState({ roundCount: 5, roundSeconds: 120 }, teams, "KWPF");
  assert.equal(state.phase, "lobby");
  assert.equal(state.poolCursor, 0);
  assert.equal(state.round, null);
  assert.equal(state.activeTeam, "t1");
  assert.ok(typeof state.createdAt === "number");
});
