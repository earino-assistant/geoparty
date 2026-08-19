// Tests for js/daily.js — the Daily Challenge (S2): the date seed, the day
// number, the run fold (same scorer as the party game), and the replay lock.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DAILY_ROUNDS,
  DAILY_ROUND_SECONDS,
  DAILY_EPOCH_KEY,
  DAILY_RESULT_KEY,
  dailyKey,
  dailySeed,
  dailyNumber,
  newDailyRun,
  recordDailyRound,
  dailyRunComplete,
  guessedRounds,
  bestDailyDistance,
  loadDailyResult,
  saveDailyResult,
} from "../js/daily.js";
import { scoreForDistance, timeBonus, bonusWindowMs } from "../js/game.js";
import { shuffledPool } from "../js/pool.js";

// localStorage-shaped in-memory store (same double as analytics.test.js).
function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
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
    points: distancePoints + bonus,
  });
  assert.equal(run.score, distancePoints + bonus);
});

test("recordDailyRound: a forfeit (no pin at the buzzer) scores zero", () => {
  const run = recordDailyRound(newDailyRun("20260819"), null);
  assert.deepEqual(run.rounds[0], {
    distanceKm: null, distancePoints: 0, timeBonus: 0, points: 0,
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
