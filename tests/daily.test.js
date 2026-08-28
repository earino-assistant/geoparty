// Tests for js/daily.js — the Daily Challenge (S2): the date seed, the day
// number, the run fold (same scorer as the party game), and the replay lock.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DAILY_ROUNDS,
  DAILY_ROUND_SECONDS,
  HARD_ROUND_SECONDS,
  DAILY_EPOCH_KEY,
  DAILY_RESULT_KEY,
  DAILY_RESULT_HARD_KEY,
  dailyKey,
  dailySeed,
  dailyNumber,
  dailyKeyFromNumber,
  daysBetweenKeys,
  dailyRoundSeconds,
  dailyMoveAllowed,
  dailyResultKey,
  newDailyRun,
  recordDailyRound,
  dailyRunComplete,
  guessedRounds,
  bestDailyDistance,
  loadDailyResult,
  saveDailyResult,
  DAILY_INFLIGHT_KEY,
  INFLIGHT_VERSION,
  buildInflight,
  parseInflight,
  inflightMatchesPool,
  placesFromCursors,
  resolveInflight,
  loadInflight,
  saveInflight,
  clearInflight,
} from "../js/daily.js";
import { scoreForDistance, timeBonus, bonusWindowMs } from "../js/game.js";
import { shuffledPool } from "../js/pool.js";

// localStorage-shaped in-memory store (same double as analytics.test.js).
function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

// A three-round mid-run save for todayKey "20260819" (two guesses + a forfeit).
// The cursors encode a dead skip between rounds 1 and 2 (1 → 3 → 4).
function inflightRun(key = "20260819", hard = false) {
  let run = newDailyRun(key, hard);
  run = recordDailyRound(run, { distanceKm: 12, elapsedMs: 4000, lat: 35, lng: 135 });
  run = recordDailyRound(run, { distanceKm: 300, elapsedMs: 9000, lat: 1, lng: 2 });
  run = recordDailyRound(run, null);   // a forfeit
  return run;
}

/* ---------------- date key / seed / day number ---------------- */

test("dailyKey: local calendar date, zero-padded", () => {
  // new Date(y, m, d) is a LOCAL date — the daily follows the player's
  // midnight, like Wordle.
  assert.equal(dailyKey(new Date(2026, 7, 19)), "20260819");
  assert.equal(dailyKey(new Date(2026, 0, 5)), "20260105");
  assert.equal(dailyKey(new Date(2030, 11, 31)), "20301231");
});

test("dailySeed: stable per day, distinct across days, non-code-shaped", () => {
  assert.equal(dailySeed("20260819"), dailySeed("20260819"));
  assert.notEqual(dailySeed("20260819"), dailySeed("20260820"));
  // Room codes are 6 uppercase letters; the seed must never collide with
  // one, so a daily order can't be replayed by joining a room.
  assert.doesNotMatch(dailySeed("20260819"), /^[A-HJ-NP-Z]{6}$/);
});

test("daily order: same day -> same shuffled pool order for everyone", () => {
  const pool = Array.from({ length: 12 }, (_, i) => ({ image_id: `im${i}` }));
  const a = shuffledPool(pool, dailySeed("20260819"));
  const b = shuffledPool(pool, dailySeed("20260819"));
  assert.deepEqual(a, b);
  // A different day is a different challenge.
  const c = shuffledPool(pool, dailySeed("20260820"));
  assert.notDeepEqual(a, c);
});

test("dailyNumber: 1-based day counter from the epoch", () => {
  assert.equal(dailyNumber(DAILY_EPOCH_KEY), 1);
  assert.equal(dailyNumber("20260820"), 2);
  // Month and year boundaries are plain day arithmetic (UTC internally,
  // so DST days can't make the counter skip or repeat).
  assert.equal(dailyNumber("20260901"), 14);
  assert.equal(dailyNumber("20270819"), 366); // one plain 365-day year later
});

test("dailyKeyFromNumber: exact inverse of dailyNumber (ghost day seed)", () => {
  for (const key of ["20260819", "20260820", "20260901", "20270819", "20261231"]) {
    assert.equal(dailyKeyFromNumber(dailyNumber(key)), key);
  }
  assert.equal(dailyKeyFromNumber(1), DAILY_EPOCH_KEY);
});

/* ---------------- the run fold ---------------- */

test("recordDailyRound: scores with the party scorer against the fixed 60s window", () => {
  const run = recordDailyRound(newDailyRun("20260819"), {
    distanceKm: 100, elapsedMs: 15_000,
  });
  const distancePoints = scoreForDistance(100);
  const bonus = timeBonus(
    distancePoints, 15_000, bonusWindowMs(DAILY_ROUND_SECONDS));
  assert.equal(run.rounds.length, 1);
  assert.deepEqual(run.rounds[0], {
    distanceKm: 100, distancePoints, timeBonus: bonus,
    points: distancePoints + bonus, guess: null, elapsedMs: 15_000,
  });
  assert.equal(run.score, distancePoints + bonus);
});

test("recordDailyRound: a forfeit (no pin at the buzzer) scores zero", () => {
  const run = recordDailyRound(newDailyRun("20260819"), null);
  assert.deepEqual(run.rounds[0], {
    distanceKm: null, distancePoints: 0, timeBonus: 0, points: 0,
    guess: null, elapsedMs: 0,
  });
  assert.equal(run.score, 0);
});

test("recordDailyRound: accumulates without mutating the input run", () => {
  const r0 = newDailyRun("20260819");
  const r1 = recordDailyRound(r0, { distanceKm: 0, elapsedMs: 0 });
  const r2 = recordDailyRound(r1, { distanceKm: 20000, elapsedMs: 60_000 });
  assert.equal(r0.rounds.length, 0);
  assert.equal(r1.rounds.length, 1);
  assert.equal(r2.rounds.length, 2);
  assert.equal(r2.score, r2.rounds[0].points + r2.rounds[1].points);
});

test("dailyRunComplete: exactly DAILY_ROUNDS rounds end the run", () => {
  let run = newDailyRun("20260819");
  for (let i = 0; i < DAILY_ROUNDS; i++) {
    assert.equal(dailyRunComplete(run), false);
    run = recordDailyRound(run, { distanceKm: 50, elapsedMs: 5000 });
  }
  assert.equal(dailyRunComplete(run), true);
});

test("guessedRounds / bestDailyDistance: forfeits excluded, all-forfeit -> null", () => {
  let run = newDailyRun("20260819");
  run = recordDailyRound(run, { distanceKm: 420.5, elapsedMs: 9000 });
  run = recordDailyRound(run, null);
  run = recordDailyRound(run, { distanceKm: 3.2, elapsedMs: 4000 });
  assert.equal(guessedRounds(run), 2);
  assert.equal(bestDailyDistance(run), 3.2);
  const empty = recordDailyRound(newDailyRun("20260819"), null);
  assert.equal(guessedRounds(empty), 0);
  assert.equal(bestDailyDistance(empty), null);
});

/* ---------------- replay lock ---------------- */

test("saveDailyResult/loadDailyResult: round-trips today's run", () => {
  const s = memStorage();
  let run = newDailyRun("20260819");
  run = recordDailyRound(run, { distanceKm: 12, elapsedMs: 8000 });
  saveDailyResult(s, run);
  assert.deepEqual(loadDailyResult(s, "20260819"), run);
});

test("loadDailyResult: another day's result reads as unplayed", () => {
  const s = memStorage();
  saveDailyResult(s, recordDailyRound(newDailyRun("20260818"), null));
  // Yesterday's run does not lock out today — and is superseded on save.
  assert.equal(loadDailyResult(s, "20260819"), null);
});

test("loadDailyResult: malformed or unreadable storage reads as unplayed", () => {
  const s = memStorage();
  s.setItem(DAILY_RESULT_KEY, "{not json");
  assert.equal(loadDailyResult(s, "20260819"), null);
  s.setItem(DAILY_RESULT_KEY, JSON.stringify({ key: "20260819" })); // no score/rounds
  assert.equal(loadDailyResult(s, "20260819"), null);
  const broken = {
    getItem: () => { throw new Error("private mode"); },
    setItem: () => { throw new Error("private mode"); },
  };
  assert.equal(loadDailyResult(broken, "20260819"), null);
  saveDailyResult(broken, newDailyRun("20260819")); // must not throw
});

/* ---------------- daysBetweenKeys (G1 streak arithmetic, §3.1) ---------- */

test("daysBetweenKeys: whole-day gaps, DST/month/year proof", () => {
  assert.equal(daysBetweenKeys("20260819", "20260820"), 1);
  assert.equal(daysBetweenKeys("20260820", "20260819"), -1);  // clock rollback
  assert.equal(daysBetweenKeys("20260819", "20260819"), 0);   // same day
  assert.equal(daysBetweenKeys("20260819", "20260821"), 2);   // one missed day
  // US DST spring-forward (2026-03-08) and fall-back (2026-11-01): the local
  // day is 23h/25h long, but UTC-midnight parsing keeps the count exact.
  assert.equal(daysBetweenKeys("20260307", "20260309"), 2);
  assert.equal(daysBetweenKeys("20261031", "20261102"), 2);
  // Month and year boundaries are plain arithmetic.
  assert.equal(daysBetweenKeys("20260131", "20260201"), 1);
  assert.equal(daysBetweenKeys("20261231", "20270101"), 1);
  // Missing/empty predecessor is the "first ever run" sentinel.
  assert.equal(daysBetweenKeys("", "20260819"), Infinity);
  assert.equal(daysBetweenKeys(undefined, "20260819"), Infinity);
});

/* ---------------- G6 hard mode constants + v2 result ---------------- */

test("hard mode: 30s window, movement off; normal: 60s, movement on", () => {
  assert.equal(dailyRoundSeconds(false), DAILY_ROUND_SECONDS);
  assert.equal(dailyRoundSeconds(true), HARD_ROUND_SECONDS);
  assert.equal(dailyMoveAllowed(false), true);
  assert.equal(dailyMoveAllowed(true), false);
});

test("recordDailyRound: v2 stores the pin and elapsed for a ghost", () => {
  let run = newDailyRun("20260819");
  run = recordDailyRound(run, {
    distanceKm: 12, elapsedMs: 8000, lat: 48.85, lng: 2.35,
  });
  assert.deepEqual(run.rounds[0].guess, { lat: 48.85, lng: 2.35 });
  assert.equal(run.rounds[0].elapsedMs, 8000);
  // A pin with no coordinates (malformed) stores no ghost pin.
  const forfeit = recordDailyRound(newDailyRun("20260819"), {
    distanceKm: 5, elapsedMs: 3000,
  });
  assert.equal(forfeit.rounds[0].guess, null);
});

test("recordDailyRound: a hard run scores on the 30s window", () => {
  const hardRun = recordDailyRound(newDailyRun("20260819", true),
    { distanceKm: 100, elapsedMs: 15_000 });
  const normalRun = recordDailyRound(newDailyRun("20260819", false),
    { distanceKm: 100, elapsedMs: 15_000 });
  const dp = scoreForDistance(100);
  assert.equal(hardRun.rounds[0].timeBonus,
    timeBonus(dp, 15_000, bonusWindowMs(HARD_ROUND_SECONDS)));
  assert.equal(normalRun.rounds[0].timeBonus,
    timeBonus(dp, 15_000, bonusWindowMs(DAILY_ROUND_SECONDS)));
  // 15s into a 30s round earns less bonus than 15s into a 60s round.
  assert.ok(hardRun.rounds[0].timeBonus < normalRun.rounds[0].timeBonus);
  assert.equal(hardRun.hard, true);
});

test("daily result: hard run saves to its own slot; slots are independent", () => {
  const s = memStorage();
  const normal = recordDailyRound(newDailyRun("20260819", false),
    { distanceKm: 10, elapsedMs: 1000 });
  const hard = recordDailyRound(newDailyRun("20260819", true),
    { distanceKm: 20, elapsedMs: 1000 });
  saveDailyResult(s, normal);
  saveDailyResult(s, hard);
  assert.equal(dailyResultKey(false), DAILY_RESULT_KEY);
  assert.equal(dailyResultKey(true), DAILY_RESULT_HARD_KEY);
  assert.deepEqual(loadDailyResult(s, "20260819", DAILY_RESULT_KEY), normal);
  assert.deepEqual(loadDailyResult(s, "20260819", DAILY_RESULT_HARD_KEY), hard);
  // The normal slot is unaffected by the hard save (v1 path untouched).
  assert.equal(loadDailyResult(s, "20260819").hard, false);
});

test("loadDailyResult: a v1 save (no pins/elapsed/hard) still loads", () => {
  const s = memStorage();
  // Exactly the pre-v2 on-disk shape.
  const v1 = { key: "20260819", score: 4200, rounds: [
    { distanceKm: 12, distancePoints: 4200, timeBonus: 0, points: 4200 },
  ] };
  s.setItem(DAILY_RESULT_KEY, JSON.stringify(v1));
  assert.deepEqual(loadDailyResult(s, "20260819"), v1);
});

/* ---------------- mid-run persistence (docs/daily-persistence-spec.md) ------ */

test("inflight: buildInflight/parseInflight round-trip a mid-run save", () => {
  const run = inflightRun();
  const cursors = [1, 3, 4];
  const payload = buildInflight(run, cursors, 0xab3f);
  assert.equal(payload.v, INFLIGHT_VERSION);
  assert.equal(payload.poolCheck, 0xab3f);
  assert.deepEqual(payload.cursors, cursors);
  // buildInflight copies the cursors array (no aliasing the caller's).
  cursors.push(9);
  assert.deepEqual(payload.cursors, [1, 3, 4]);
  // The run — pins included — survives verbatim.
  assert.deepEqual(payload.run, run);

  const parsed = parseInflight(JSON.stringify(payload), "20260819");
  assert.deepEqual(parsed.run, run);
  assert.deepEqual(parsed.cursors, [1, 3, 4]);
  assert.equal(parsed.poolCheck, 0xab3f);
  assert.equal(parsed.complete, false);   // 3 of DAILY_ROUNDS
});

test("inflight: another day's save is discarded and removed", () => {
  const payload = buildInflight(inflightRun("20260818"), [1, 2, 3], 1);
  // A save whose run.key isn't today reads as absent.
  assert.equal(parseInflight(JSON.stringify(payload), "20260819"), null);
  // loadInflight also removes the stale item so it can't linger.
  const s = memStorage();
  s.setItem(DAILY_INFLIGHT_KEY, JSON.stringify(payload));
  assert.equal(loadInflight(s, "20260819"), null);
  assert.equal(s.getItem(DAILY_INFLIGHT_KEY), null);
});

test("inflight: a version mismatch is discarded", () => {
  const payload = buildInflight(inflightRun(), [1, 2, 3], 1);
  payload.v = INFLIGHT_VERSION + 1;
  assert.equal(parseInflight(JSON.stringify(payload), "20260819"), null);
});

test("inflight: corrupted JSON reads as absent", () => {
  assert.equal(parseInflight("{not json", "20260819"), null);
  assert.equal(parseInflight(null, "20260819"), null);
  assert.equal(parseInflight("null", "20260819"), null);
  assert.equal(parseInflight("42", "20260819"), null);
});

test("inflight: cursors must be strictly increasing and match rounds length", () => {
  const run = inflightRun();   // 3 rounds
  // Too few cursors.
  assert.equal(parseInflight(
    JSON.stringify(buildInflight(run, [1, 2], 1)), "20260819"), null);
  // Not strictly increasing.
  assert.equal(parseInflight(
    JSON.stringify(buildInflight(run, [1, 3, 3], 1)), "20260819"), null);
  // A zero / non-positive cursor.
  assert.equal(parseInflight(
    JSON.stringify(buildInflight(run, [0, 1, 2], 1)), "20260819"), null);
  // A non-integer cursor.
  assert.equal(parseInflight(
    JSON.stringify(buildInflight(run, [1, 2.5, 3], 1)), "20260819"), null);
  // The honest one parses.
  assert.ok(parseInflight(
    JSON.stringify(buildInflight(run, [1, 3, 4], 1)), "20260819"));
});

test("inflight: rounds beyond DAILY_ROUNDS are discarded", () => {
  let run = newDailyRun("20260819");
  const cursors = [];
  for (let i = 0; i < DAILY_ROUNDS + 1; i++) {
    run = recordDailyRound(run, { distanceKm: 1, elapsedMs: 100, lat: 0, lng: 0 });
    cursors.push(i + 1);
  }
  assert.equal(run.rounds.length, DAILY_ROUNDS + 1);
  assert.equal(parseInflight(
    JSON.stringify(buildInflight(run, cursors, 1)), "20260819"), null);
  // A zero-round save is likewise rejected (nothing to resume).
  assert.equal(parseInflight(
    JSON.stringify(buildInflight(newDailyRun("20260819"), [], 1)), "20260819"), null);
});

test("inflight: a complete (5-round) save parses with complete=true", () => {
  let run = newDailyRun("20260819");
  const cursors = [];
  for (let i = 0; i < DAILY_ROUNDS; i++) {
    run = recordDailyRound(run, { distanceKm: 2, elapsedMs: 500, lat: 10, lng: 20 });
    cursors.push(i + 1);
  }
  const parsed = parseInflight(
    JSON.stringify(buildInflight(run, cursors, 7)), "20260819");
  assert.ok(parsed);
  assert.equal(parsed.complete, true);
});

test("resolveInflight: a saved result for the same board discards the inflight (no double fold)", () => {
  const inflight = parseInflight(
    JSON.stringify(buildInflight(inflightRun(), [1, 3, 4], 1)), "20260819");
  assert.equal(resolveInflight({ inflight, hasSavedResult: true }), "discard");
  // A null inflight is always a discard (nothing to do).
  assert.equal(resolveInflight({ inflight: null, hasSavedResult: false }), "discard");
});

test("resolveInflight: complete → finalize, partial → resume", () => {
  const partial = parseInflight(
    JSON.stringify(buildInflight(inflightRun(), [1, 3, 4], 1)), "20260819");
  assert.equal(resolveInflight({ inflight: partial, hasSavedResult: false }), "resume");
  let full = newDailyRun("20260819");
  const cursors = [];
  for (let i = 0; i < DAILY_ROUNDS; i++) {
    full = recordDailyRound(full, { distanceKm: 3, elapsedMs: 300, lat: 5, lng: 6 });
    cursors.push(i + 1);
  }
  const complete = parseInflight(
    JSON.stringify(buildInflight(full, cursors, 1)), "20260819");
  assert.equal(resolveInflight({ inflight: complete, hasSavedResult: false }), "finalize");
});

test("inflightMatchesPool: pool drift discards the save", () => {
  const inflight = parseInflight(
    JSON.stringify(buildInflight(inflightRun(), [1, 3, 4], 0xab3f)), "20260819");
  assert.equal(inflightMatchesPool(inflight, 0xab3f), true);
  assert.equal(inflightMatchesPool(inflight, 0x0001), false);
  assert.equal(inflightMatchesPool(null, 0xab3f), false);
});

test("placesFromCursors: reconstructs the skip-adjusted play order exactly", () => {
  // A stand-in seeded order; entry i shown for a run is order[cursors[i] - 1].
  const order = [
    { name: "A", lat: 1, lng: 1, image_id: "a" },
    { name: "B", lat: 2, lng: 2, image_id: "b" },   // dead-skipped (gap 1→3)
    { name: "C", lat: 3, lng: 3, image_id: "c" },
    { name: "D", lat: 4, lng: 4, image_id: "d" },
  ];
  // cursors [1,3,4] ⇒ order[0]=A, order[2]=C, order[3]=D.
  assert.deepEqual(placesFromCursors(order, [1, 3, 4]), [
    { name: "A", lat: 1, lng: 1 },
    { name: "C", lat: 3, lng: 3 },
    { name: "D", lat: 4, lng: 4 },
  ]);
  // Only name + coords are read — no image id leaks into the reconstruction.
  assert.ok(!("image_id" in placesFromCursors(order, [1])[0]));
});

test("placesFromCursors: a cursor beyond the order returns null", () => {
  const order = [
    { name: "A", lat: 1, lng: 1 },
    { name: "B", lat: 2, lng: 2 },
  ];
  assert.equal(placesFromCursors(order, [1, 3]), null);   // 3 → order[2] absent
});

test("saveInflight/clearInflight: storage errors are swallowed", () => {
  const broken = {
    getItem: () => { throw new Error("private mode"); },
    setItem: () => { throw new Error("quota"); },
    removeItem: () => { throw new Error("locked"); },
  };
  // None of these may throw — broken persistence must never break the game.
  assert.doesNotThrow(() => saveInflight(broken, buildInflight(inflightRun(), [1, 3, 4], 1)));
  assert.doesNotThrow(() => clearInflight(broken));
  assert.doesNotThrow(() => loadInflight(broken, "20260819"));
  assert.equal(loadInflight(broken, "20260819"), null);
  // The happy path still writes, reads back, and clears.
  const s = memStorage();
  saveInflight(s, buildInflight(inflightRun(), [1, 3, 4], 1));
  assert.ok(loadInflight(s, "20260819"));
  clearInflight(s);
  assert.equal(s.getItem(DAILY_INFLIGHT_KEY), null);
});
