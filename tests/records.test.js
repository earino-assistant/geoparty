// Tests for js/records.js — the device's memory (G1 streak, G8 PBs, G4 ACE
// counters). Pure folds + a tolerant versioned localStorage schema (spec §5.1).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RECORDS_KEY,
  RECORDS_VERSION,
  defaultRecords,
  loadRecords,
  saveRecords,
  medalForDistance,
  aceCount,
  foldStreak,
  graceJustUsed,
  foldBestScore,
  foldClosest,
  foldAces,
  monthKeyOf,
  foldDuel,
  applyDailyResult,
  applyDuelResult,
  seedBestFromResult,
} from "../js/records.js";
import { newDailyRun, recordDailyRound } from "../js/daily.js";

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    _map: m,
  };
}

/* ---------------- load / migrate / save posture ---------------- */

test("loadRecords: empty / unparsable / future-v storage → fresh defaults", () => {
  const empty = memStorage();
  assert.deepEqual(loadRecords(empty), defaultRecords());
  const bad = memStorage();
  bad.setItem(RECORDS_KEY, "{not json");
  assert.deepEqual(loadRecords(bad), defaultRecords());
  const future = memStorage();
  future.setItem(RECORDS_KEY, JSON.stringify({ v: RECORDS_VERSION + 9, streak: { count: 99 } }));
  assert.deepEqual(loadRecords(future), defaultRecords());   // never partially trust
  const arr = memStorage();
  arr.setItem(RECORDS_KEY, JSON.stringify([1, 2, 3]));
  assert.deepEqual(loadRecords(arr), defaultRecords());
});

test("loadRecords: a valid v1 record round-trips; missing fields default", () => {
  const s = memStorage();
  const rec = defaultRecords();
  rec.streak = { count: 12, best: 14, lastKey: "20260820", graceKey: "20260817" };
  rec.daily = { bestScore: { score: 22110, day: 29 } };
  saveRecords(s, rec);
  assert.deepEqual(loadRecords(s), rec);
  // A partial (additively-older) object fills the gaps from defaults.
  const partial = memStorage();
  partial.setItem(RECORDS_KEY, JSON.stringify({ v: 1, streak: { count: 3 } }));
  const loaded = loadRecords(partial);
  assert.equal(loaded.streak.count, 3);
  assert.deepEqual(loaded.duels, { played: 0, won: 0 });
  assert.equal(loaded.closest, null);
});

test("saveRecords: throwing storage (private mode) never throws", () => {
  const broken = {
    getItem: () => { throw new Error("private"); },
    setItem: () => { throw new Error("private"); },
  };
  assert.deepEqual(loadRecords(broken), defaultRecords());
  saveRecords(broken, defaultRecords());   // must not throw
});

/* ---------------- G1 streak fold (the four-branch table) ---------------- */

const fresh = { count: 0, best: 0, lastKey: "", graceKey: "" };

test("foldStreak: first-ever completion starts at 1", () => {
  const s = foldStreak(fresh, "20260819");
  assert.equal(s.count, 1);
  assert.equal(s.best, 1);
  assert.equal(s.lastKey, "20260819");
  assert.equal(s.graceKey, "");
});

test("foldStreak: consecutive day (gap 1) increments", () => {
  let s = foldStreak(fresh, "20260819");
  s = foldStreak(s, "20260820");
  assert.equal(s.count, 2);
  assert.equal(s.best, 2);
  assert.equal(s.lastKey, "20260820");
});

test("foldStreak: same-day re-entry (gap 0) and clock rollback (gap < 0) — no change", () => {
  let s = foldStreak(fresh, "20260819");
  s = foldStreak(s, "20260820");    // count 2
  const same = foldStreak(s, "20260820");
  assert.deepEqual(same, { count: 2, best: 2, lastKey: "20260820", graceKey: "" });
  const back = foldStreak(s, "20260818");   // clock rolled backwards
  assert.equal(back.count, 2);
  assert.equal(back.lastKey, "20260820");   // lastKey never regresses
});

test("foldStreak: one missed day (gap 2) is bridged by grace, once per rolling 7", () => {
  let s = foldStreak(fresh, "20260801");    // count 1
  s = foldStreak(s, "20260802");            // count 2
  s = foldStreak(s, "20260804");            // gap 2 → grace, count 3
  assert.equal(s.count, 3);
  assert.equal(s.graceKey, "20260804");
  // Another gap-2 within 7 days of the grace → NOT bridged, streak resets.
  const reset = foldStreak(s, "20260806");  // 2 days after the last completion,
  assert.equal(reset.count, 1);             // but only 2 since grace → no grace
  assert.equal(reset.graceKey, "");
});

test("foldStreak: grace re-earns after the rolling-7 window (day 8+)", () => {
  let s = foldStreak(fresh, "20260801");
  s = foldStreak(s, "20260803");            // gap 2 → grace at 20260803, count 2
  assert.equal(s.graceKey, "20260803");
  // Keep the streak alive daily until well past the window...
  for (const k of ["20260804", "20260805", "20260806", "20260807",
    "20260808", "20260809", "20260810", "20260811"]) {
    s = foldStreak(s, k);
  }
  assert.equal(s.count, 10);
  // Now a gap 2 whose distance from the OLD graceKey (20260803) is > 7 → grace
  // is available again and bridges the miss.
  const bridged = foldStreak(s, "20260813");  // gap 2 from 20260811
  assert.equal(bridged.count, 11);
  assert.equal(bridged.graceKey, "20260813");
});

test("foldStreak: a big gap (≥3) resets to 1 with a fresh grace", () => {
  let s = foldStreak(fresh, "20260801");
  s = foldStreak(s, "20260802");            // count 2
  const reset = foldStreak(s, "20260810");  // gap 8 → reset
  assert.equal(reset.count, 1);
  assert.equal(reset.graceKey, "");
});

test("foldStreak: best is a monotonic watermark", () => {
  let s = foldStreak(fresh, "20260801");
  s = foldStreak(s, "20260802");
  s = foldStreak(s, "20260803");            // count 3, best 3
  const broke = foldStreak(s, "20260901");  // resets count to 1
  assert.equal(broke.count, 1);
  assert.equal(broke.best, 3);              // best remembers the peak
});

test("graceJustUsed: true only on the fold that spends grace", () => {
  let s = foldStreak(fresh, "20260801");
  s = foldStreak(s, "20260802");
  const before = s;
  const after = foldStreak(before, "20260804");   // grace fold
  assert.equal(graceJustUsed(before, after, "20260804"), true);
  const next = foldStreak(after, "20260805");      // plain increment
  assert.equal(graceJustUsed(after, next, "20260805"), false);
});

/* ---------------- G4 medals + ace counters ---------------- */

test("medalForDistance: ACE under 1 km, tiers, and no-pin", () => {
  assert.deepEqual(medalForDistance(0.4), { ace: true, emoji: "🎯", caption: "ACE!" });
  assert.deepEqual(medalForDistance(1), { ace: false, emoji: "🟩", caption: "Nailed it" });
  assert.deepEqual(medalForDistance(500), { ace: false, emoji: "🟨", caption: "Right region" });
  assert.deepEqual(medalForDistance(2000), { ace: false, emoji: "🟧", caption: "Right continent" });
  assert.deepEqual(medalForDistance(9000), { ace: false, emoji: "🟥", caption: "Lost" });
  assert.deepEqual(medalForDistance(null), { ace: false, emoji: "⬛", caption: null });
});

test("aceCount: counts sub-1km rounds only", () => {
  assert.equal(aceCount([
    { distanceKm: 0.5 }, { distanceKm: 12 }, { distanceKm: null },
    { distanceKm: 0.99 }, { distanceKm: 1 },
  ]), 2);
});

test("foldAces: month rollover resets monthCount, allTime never", () => {
  let a = { month: "", monthCount: 0, allTime: 0 };
  a = foldAces(a, 2, "2026-08");
  assert.deepEqual(a, { month: "2026-08", monthCount: 2, allTime: 2 });
  a = foldAces(a, 1, "2026-08");
  assert.deepEqual(a, { month: "2026-08", monthCount: 3, allTime: 3 });
  a = foldAces(a, 1, "2026-09");   // new month
  assert.deepEqual(a, { month: "2026-09", monthCount: 1, allTime: 4 });
  // A 0-ace run still rolls the month over.
  a = foldAces(a, 0, "2026-10");
  assert.deepEqual(a, { month: "2026-10", monthCount: 0, allTime: 4 });
  assert.equal(monthKeyOf("20260819"), "2026-08");
});

/* ---------------- G8 personal bests ---------------- */

test("foldBestScore: strictly greater replaces; ties don't", () => {
  let r = foldBestScore({ bestScore: null }, 100, 5);
  assert.deepEqual(r, { board: { bestScore: { score: 100, day: 5 } }, improved: true });
  r = foldBestScore(r.board, 100, 6);   // tie
  assert.equal(r.improved, false);
  assert.equal(r.board.bestScore.day, 5);
  r = foldBestScore(r.board, 101, 6);   // beat
  assert.equal(r.improved, true);
  assert.equal(r.board.bestScore.day, 6);
});

test("foldClosest: strictly smaller replaces; context sticks", () => {
  let r = foldClosest(null, 12, "daily");
  assert.deepEqual(r.closest, { km: 12, context: "daily" });
  r = foldClosest(r.closest, 3.1, "party");
  assert.deepEqual(r.closest, { km: 3.1, context: "party" });
  r = foldClosest(r.closest, 50, "daily");   // farther — no change
  assert.equal(r.improved, false);
  assert.deepEqual(r.closest, { km: 3.1, context: "party" });
  // Non-numeric km is ignored.
  assert.equal(foldClosest({ km: 5, context: "daily" }, null, "daily").improved, false);
});

test("foldDuel: counts played and won", () => {
  let d = foldDuel(undefined, true);
  assert.deepEqual(d, { played: 1, won: 1 });
  d = foldDuel(d, false);
  assert.deepEqual(d, { played: 2, won: 1 });
});

/* ---------------- orchestration ---------------- */

test("applyDailyResult: a normal run feeds streak + normal PB + closest + aces", () => {
  let run = newDailyRun("20260819", false);
  run = recordDailyRound(run, { distanceKm: 0.4, elapsedMs: 3000, lat: 1, lng: 2 });
  run = recordDailyRound(run, { distanceKm: 800, elapsedMs: 9000, lat: 3, lng: 4 });
  const out = applyDailyResult(defaultRecords(), run, { day: 1, key: "20260819" });
  assert.equal(out.streak, 1);
  assert.equal(out.pb, true);
  assert.equal(out.aces, 1);
  assert.deepEqual(out.records.daily.bestScore, { score: run.score, day: 1 });
  assert.deepEqual(out.records.closest, { km: 0.4, context: "daily" });
  assert.equal(out.records.aces.monthCount, 1);
  assert.equal(out.records.hard.bestScore, null);   // hard row untouched
});

test("applyDailyResult: a hard run writes the hard row and NEVER the streak", () => {
  const seed = applyDailyResult(defaultRecords(),
    recordDailyRound(newDailyRun("20260819", false), { distanceKm: 5, elapsedMs: 1000 }),
    { day: 1, key: "20260819" });
  assert.equal(seed.records.streak.count, 1);
  let hardRun = newDailyRun("20260819", true);
  hardRun = recordDailyRound(hardRun, { distanceKm: 3, elapsedMs: 1000, lat: 9, lng: 9 });
  const out = applyDailyResult(seed.records, hardRun, { day: 1, key: "20260819" });
  assert.equal(out.records.streak.count, 1);        // unchanged by hard
  assert.equal(out.records.hard.bestScore.score, hardRun.score);
  assert.equal(out.records.daily.bestScore.score, seed.records.daily.bestScore.score);
});

test("applyDuelResult: bumps the duel counters", () => {
  const out = applyDuelResult(defaultRecords(), true);
  assert.deepEqual(out.records.duels, { played: 1, won: 1 });
});

test("seedBestFromResult: fills a null PB row once, idempotently", () => {
  const seeded = seedBestFromResult(defaultRecords(),
    { key: "20260819", score: 15000, rounds: [] }, 1);
  assert.deepEqual(seeded.daily.bestScore, { score: 15000, day: 1 });
  // A second seed with a bigger score does NOT overwrite (seed only fills null).
  const again = seedBestFromResult(seeded, { key: "20260819", score: 99999, rounds: [] }, 1);
  assert.equal(again.daily.bestScore.score, 15000);
  // Hard row is independent.
  const hardSeed = seedBestFromResult(defaultRecords(),
    { key: "20260819", score: 8000, rounds: [] }, 1, true);
  assert.deepEqual(hardSeed.hard.bestScore, { score: 8000, day: 1 });
  assert.equal(hardSeed.daily.bestScore, null);
});
