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
  formatElapsed,
  teamIds,
  starterIndex,
  isShowdownRound,
  teamForRound,
  showdownOrder,
  showdownResults,
  defaultTeams,
  initialRoomState,
  standings,
  revealResultLine,
  revealBoardRows,
  boardRowText,
  sanitizePose,
} from "../js/game.js";

/* ---------------- sanitizePose (Firebase NaN pose guard) ---------------- */

test("sanitizePose: a fully finite pose passes through as a fresh copy", () => {
  const src = { bearing: 90, center: [0.4, 0.6], zoom: 1.5 };
  const out = sanitizePose(src);
  assert.deepEqual(out, { bearing: 90, center: [0.4, 0.6], zoom: 1.5 });
  assert.notEqual(out, src, "returns a new object");
  assert.notEqual(out.center, src.center, "center is a fresh array (no aliasing)");
});

test("sanitizePose: a NaN or Infinity center coordinate is rejected", () => {
  assert.equal(sanitizePose({ bearing: 0, center: [NaN, 0.5], zoom: 0 }), null);
  assert.equal(sanitizePose({ bearing: 0, center: [0.5, NaN], zoom: 0 }), null);
  assert.equal(sanitizePose({ bearing: 0, center: [Infinity, 0.5], zoom: 0 }), null);
  assert.equal(sanitizePose({ bearing: 0, center: [0.5, -Infinity], zoom: 0 }), null);
});

test("sanitizePose: a NaN/Infinity bearing or zoom is rejected", () => {
  assert.equal(sanitizePose({ bearing: NaN, center: [0.5, 0.5], zoom: 0 }), null);
  assert.equal(sanitizePose({ bearing: 0, center: [0.5, 0.5], zoom: NaN }), null);
  assert.equal(sanitizePose({ bearing: 0, center: [0.5, 0.5], zoom: Infinity }), null);
});

test("sanitizePose: short, non-array, or missing center is rejected", () => {
  assert.equal(sanitizePose({ bearing: 0, center: [0.5], zoom: 0 }), null);
  assert.equal(sanitizePose({ bearing: 0, center: [0.5, 0.5, 0.5], zoom: 0 }), null);
  assert.equal(sanitizePose({ bearing: 0, center: "0.5,0.5", zoom: 0 }), null);
  assert.equal(sanitizePose({ bearing: 0, zoom: 0 }), null);
  // The bearing-only round-start literal ({bearing:0}) has no center → null.
  assert.equal(sanitizePose({ bearing: 0 }), null);
});

test("sanitizePose: nullish and non-object inputs are rejected, never throw", () => {
  for (const bad of [null, undefined, 0, "", "pose", 42, true, []]) {
    assert.equal(sanitizePose(bad), null, String(bad));
  }
});

test("sanitizePose: no accepted pose ever carries a NaN into a patch", () => {
  // The scan the Firebase-rejection bug demands: across a matrix of poses, any
  // pose sanitizePose accepts must serialize with no NaN/Infinity anywhere.
  const matrix = [
    { bearing: 0, center: [0, 0], zoom: 0 },
    { bearing: 359.9, center: [0.999, 0.001], zoom: 4 },
    { bearing: NaN, center: [0.5, 0.5], zoom: 1 },
    { bearing: 10, center: [NaN, 0.5], zoom: 1 },
    { bearing: 10, center: [0.5, Infinity], zoom: 1 },
    { bearing: 10, center: [0.5, 0.5], zoom: NaN },
    null,
    { center: [0.5, 0.5] },
  ];
  for (const pose of matrix) {
    const out = sanitizePose(pose);
    if (out === null) continue;
    const flat = [out.bearing, out.center[0], out.center[1], out.zoom];
    for (const n of flat) {
      assert.ok(Number.isFinite(n), `accepted pose has non-finite ${n}`);
    }
  }
});

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

test("formatElapsed: m:ss count-up from zero, floored, clamped at zero", () => {
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(65_000), "1:05");
  assert.equal(formatElapsed(59_999), "0:59"); // floor, an elapsed reading counts up
  assert.equal(formatElapsed(60_000), "1:00");
  assert.equal(formatElapsed(125_000), "2:05");
  assert.equal(formatElapsed(-3_000), "0:00"); // clock skew never shows negative
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

test("resultRowText: SUPER SURE rows show the verdict at reveal", () => {
  // Won: ×2 badge and the doubled total.
  const won = resultRowText({
    guess: {}, distanceKm: 12.3, points: 5600,
    elapsedMs: 23_000, timeBonus: 800,
    superSure: true, superSureOutcome: "won",
  });
  assert.ok(won.includes("SUPER SURE ×2"), won);
  assert.ok(won.includes("+11,200") || won.includes("+11200"), won);
  // Lost: the distance stays (they did pin), the points are gone.
  const lost = resultRowText({
    guess: {}, distanceKm: 250, points: 4200,
    superSure: true, superSureOutcome: "lost",
  });
  assert.equal(lost, "250 km · 🔥 SUPER SURE ×0");
  // Burned (bet, no pin) must read differently from a plain forfeit.
  const burned = resultRowText({ guess: null, superSure: true, superSureOutcome: "burned" });
  const forfeit = resultRowText({ guess: null });
  assert.equal(burned, "no pin · SUPER SURE ×0");
  assert.equal(forfeit, "no pin · +0");
  assert.notEqual(burned, forfeit);
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

/* ================================================================
 * The de-cluttered phone reveal (design review §2.8 / §6.4)
 * ================================================================ */

test("revealResultLine: the whole personal result on one line", () => {
  const line = revealResultLine({
    guess: { lat: 1, lng: 2 }, distanceKm: 812, points: 3120,
    distancePoints: 2980, timeBonus: 140, elapsedMs: 23_000,
  });
  assert.equal(line, "+3,120 pts · 812 km · ⚡+140 fast");
});

test("revealResultLine: no speed bonus, no bolt segment", () => {
  const line = revealResultLine({
    guess: { lat: 1, lng: 2 }, distanceKm: 4000, points: 350,
    distancePoints: 350, timeBonus: 0, elapsedMs: 119_000,
  });
  assert.equal(line, "+350 pts · 4,000 km");
  assert.ok(!line.includes("⚡"));
});

test("revealResultLine: a forfeit reads as a forfeit", () => {
  assert.equal(revealResultLine({ guess: null, points: 0, forfeited: true }),
    "+0 pts · no pin");
  assert.equal(revealResultLine(null), "+0 pts · no pin");
});

test("revealResultLine: a won bet shows the doubled total and its verdict", () => {
  const line = revealResultLine({
    guess: { lat: 1, lng: 2 }, distanceKm: 12.4, points: 4800,
    distancePoints: 4300, timeBonus: 500,
    superSure: true, superSureOutcome: "won",
  });
  assert.ok(line.startsWith("+9,600 pts"), line); // adjustedPoints × 2
  assert.ok(line.endsWith("🔥 SUPER SURE ×2"), line);
});

test("revealResultLine: a lost bet scores zero and says so", () => {
  const line = revealResultLine({
    guess: { lat: 1, lng: 2 }, distanceKm: 900, points: 2400,
    distancePoints: 2400, timeBonus: 0,
    superSure: true, superSureOutcome: "lost",
  });
  assert.ok(line.startsWith("+0 pts"), line);
  assert.ok(line.includes("🔥 SUPER SURE ×0"), line);
});

test("revealResultLine: a burned bet is not a plain forfeit", () => {
  const burned = revealResultLine({
    guess: null, points: 0, superSure: true, superSureOutcome: "burned",
  });
  assert.ok(burned.includes("SUPER SURE"), burned);
  assert.notEqual(burned, revealResultLine({ guess: null, points: 0 }));
});

test("revealResultLine: never leaks a coordinate or a place name", () => {
  const line = revealResultLine({
    guess: { lat: 48.85, lng: 2.35 }, distanceKm: 5, points: 4900,
    distancePoints: 4900, timeBonus: 0, name: "Paris, France",
  });
  assert.ok(!line.includes("48.85") && !line.includes("2.35"), line);
  assert.ok(!/Paris/.test(line), line);
});

test("revealBoardRows: one board replaces 'This round' + 'Totals'", () => {
  const teams = {
    t1: { name: "Atlas Cats", total: 9480 },
    t2: { name: "Pin Pals", total: 8910 },
  };
  const results = {
    t1: { guess: {}, distanceKm: 812, points: 3120 },
    t2: { guess: {}, distanceKm: 1500, points: 1870 },
  };
  const rows = revealBoardRows(teams, results);
  assert.deepEqual(rows.map((r) => r.id), ["t1", "t2"]); // standings order
  assert.equal(boardRowText(rows[0]), "+3,120 → 9,480");
  assert.equal(boardRowText(rows[1]), "+1,870 → 8,910");
});

test("revealBoardRows: the crown marks the round's CLOSEST pin", () => {
  // …which is not necessarily the leader — the merged board must keep the
  // one signal the old "This round" list existed to show.
  const teams = {
    t1: { name: "Leader", total: 9000 },
    t2: { name: "Underdog", total: 4000 },
  };
  const results = {
    t1: { guess: {}, distanceKm: 900, points: 1200 },
    t2: { guess: {}, distanceKm: 12, points: 4800 },
  };
  const rows = revealBoardRows(teams, results);
  assert.equal(rows[0].id, "t1");        // standings order unchanged
  assert.equal(rows[0].crown, false);
  assert.equal(rows[1].crown, true);     // the closest pin wears the crown
});

test("revealBoardRows: a forfeit never wins the crown", () => {
  const teams = { t1: { name: "A", total: 100 }, t2: { name: "B", total: 50 } };
  const rows = revealBoardRows(teams, {
    t1: { guess: null, points: 0, distanceKm: null },
    t2: { guess: {}, distanceKm: 4000, points: 50 },
  });
  assert.equal(rows.find((r) => r.id === "t1").crown, false);
  assert.equal(rows.find((r) => r.id === "t2").crown, true);
});

test("revealBoardRows: couch solo rounds — teams with no result carry +0", () => {
  const teams = {
    t1: { name: "A", total: 3200 }, t2: { name: "B", total: 1000 },
  };
  const rows = revealBoardRows(teams, { t1: { guess: {}, distanceKm: 8, points: 3200 } });
  assert.equal(boardRowText(rows.find((r) => r.id === "t2")), "+0 → 1,000");
});

test("revealBoardRows: the delta is the SETTLED score, not the raw one", () => {
  const teams = { t1: { name: "A", total: 6000 } };
  const won = revealBoardRows(teams, {
    t1: { guess: {}, distanceKm: 5, points: 3000,
          superSure: true, superSureOutcome: "won" },
  });
  assert.equal(won[0].delta, 6000);
  const lost = revealBoardRows(teams, {
    t1: { guess: {}, distanceKm: 5, points: 3000,
          superSure: true, superSureOutcome: "lost" },
  });
  assert.equal(lost[0].delta, 0);
});

test("revealBoardRows: an empty round is a board of zero-deltas", () => {
  const teams = { t1: { name: "A", total: 0 }, t2: { name: "B", total: 0 } };
  for (const results of [null, undefined, {}]) {
    const rows = revealBoardRows(teams, results);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.delta === 0 && r.crown === false));
  }
});
