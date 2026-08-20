// records.js — the device's memory (design review G1/G4/G8). One versioned
// localStorage schema (`geoparty_records`, spec §5.1) that folds the daily
// streak (G1), personal bests (G8), and the ACE counters (G4). No DOM, no
// network — the js/game.js discipline: every decision here is a pure fold,
// unit-tested in tests/records.test.js, and the daily-ui glue reads/writes it.
//
// Posture (mirrors loadDailyResult, js/daily.js): unreadable, unparsable, or a
// `v` we don't know reads as a fresh device — never throw, never partially
// trust. There is no recovery by construction (no accounts); the honest copy
// lives in the UI, and a reset is simply "Day 1", never an accusation.

import { daysBetweenKeys } from "./daily.js";
import { EMOJI_BUCKETS, EMOJI_NO_PIN, EMOJI_ACE, ACE_MAX_KM } from "./share.js";

export const RECORDS_KEY = "geoparty_records";
export const RECORDS_VERSION = 1;

// The grace guard: one missed day can be bridged, at most once per rolling
// window of this many days (spec §3.1 — kindness with a guard against a
// 3-days-a-week habit faking a streak).
export const GRACE_WINDOW_DAYS = 7;

export function defaultRecords() {
  return {
    v: RECORDS_VERSION,
    streak: { count: 0, best: 0, lastKey: "", graceKey: "" },
    daily: { bestScore: null },   // { score, day } | null
    hard: { bestScore: null },    // { score, day } | null
    closest: null,                // { km, context } | null
    aces: { month: "", monthCount: 0, allTime: 0 },
    duels: { played: 0, won: 0 },
  };
}

/* ================================================================
 * Load / migrate / save
 * ================================================================ */

// Fill missing (additively-added) fields from the defaults so a reader never
// trusts a partial object. Additive fields need no version bump — this is what
// lets a future `v:1` writer add a field older `v:1` readers simply default.
function normalizeRecords(parsed) {
  const d = defaultRecords();
  const s = parsed.streak || {};
  const a = parsed.aces || {};
  const du = parsed.duels || {};
  return {
    v: RECORDS_VERSION,
    streak: {
      count: numOr(s.count, 0),
      best: numOr(s.best, 0),
      lastKey: typeof s.lastKey === "string" ? s.lastKey : "",
      graceKey: typeof s.graceKey === "string" ? s.graceKey : "",
    },
    daily: { bestScore: normScore(parsed.daily && parsed.daily.bestScore) },
    hard: { bestScore: normScore(parsed.hard && parsed.hard.bestScore) },
    closest: normClosest(parsed.closest),
    aces: {
      month: typeof a.month === "string" ? a.month : "",
      monthCount: numOr(a.monthCount, 0),
      allTime: numOr(a.allTime, 0),
    },
    duels: { played: numOr(du.played, 0), won: numOr(du.won, 0) },
  };
}

function numOr(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function normScore(bs) {
  return bs && typeof bs.score === "number" ? { score: bs.score, day: numOr(bs.day, 0) } : null;
}
function normClosest(c) {
  return c && typeof c.km === "number"
    ? { km: c.km, context: c.context === "party" ? "party" : "daily" } : null;
}

// The migration seam (spec §5.1): there is no v0, so v1 ships migration-free,
// but the pure function exists so a future incompatible bump has one place to
// land. A known older `v` routes here; unknown/newer routes to defaults.
export function migrateRecords(/* old */) {
  return defaultRecords();
}

export function loadRecords(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(RECORDS_KEY));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (parsed.v === RECORDS_VERSION) return normalizeRecords(parsed);
      if (typeof parsed.v === "number" && parsed.v < RECORDS_VERSION) {
        return migrateRecords(parsed);
      }
    }
  } catch { /* private mode / tampered — a fresh device */ }
  return defaultRecords();
}

export function saveRecords(storage, records) {
  try {
    storage.setItem(RECORDS_KEY, JSON.stringify(records));
  } catch { /* private mode: this session just isn't remembered */ }
}

/* ================================================================
 * G4 — medal grading (spec §3.4)
 * ================================================================ */

// { ace, emoji, caption } for a pin distance. Built on share.js's EMOJI_BUCKETS
// so the grid square and the reveal caption can never disagree. `km` may be
// null (a forfeit) → the no-pin square, no caption.
export function medalForDistance(km) {
  if (typeof km !== "number" || !Number.isFinite(km)) {
    return { ace: false, emoji: EMOJI_NO_PIN, caption: null };
  }
  if (km < ACE_MAX_KM) return { ace: true, emoji: EMOJI_ACE, caption: "ACE!" };
  const b = EMOJI_BUCKETS.find((x) => km <= x.maxKm);
  return { ace: false, emoji: b.emoji, caption: b.caption };
}

// Count of ACE pins in a daily run's rounds (feeds the ceremony + counters).
export function aceCount(rounds) {
  return (rounds || []).filter(
    (r) => typeof r.distanceKm === "number" && r.distanceKm < ACE_MAX_KM).length;
}

/* ================================================================
 * G1 — the streak fold (spec §3.1). Four branches, fully table-testable.
 * Given the current streak and the completed run's local-calendar key.
 * ================================================================ */

export function foldStreak(streak, key) {
  const s = streak || { count: 0, best: 0, lastKey: "", graceKey: "" };
  let { count, best, lastKey, graceKey } = s;
  if (!lastKey) {
    count = 1;                                   // first ever, or post-reset
  } else {
    const gap = daysBetweenKeys(lastKey, key);
    if (gap <= 0) {
      // same-day re-entry, or a clock rolled backwards — never punish a clock,
      // and never advance lastKey past where it already is.
      return { count, best: Math.max(best, count), lastKey, graceKey };
    } else if (gap === 1) {
      count += 1;                                // consecutive day
    } else if (gap === 2 &&
      (!graceKey || daysBetweenKeys(graceKey, key) > GRACE_WINDOW_DAYS)) {
      count += 1;                                // one missed day, bridged
      graceKey = key;                            // grace spent (rolling-7 guard)
    } else {
      count = 1;                                 // streak broke — fresh start,
      graceKey = "";                             // and a fresh grace with it
    }
  }
  return { count, best: Math.max(best, count), lastKey: key, graceKey };
}

// True when this fold spent grace (graceKey advanced to the run's key) — the
// "Missed a day — your streak survived" copy trigger (shown on the next intro).
export function graceJustUsed(before, after, key) {
  return !!after && after.graceKey === key &&
    !(before && before.graceKey === key);
}

/* ================================================================
 * G8 — personal-best folds (spec §3.8). Records only ever improve.
 * ================================================================ */

// { board, improved }: a strictly greater score replaces { score, day }.
export function foldBestScore(board, score, day) {
  const cur = board && board.bestScore;
  if (!cur || score > cur.score) {
    return { board: { bestScore: { score, day } }, improved: true };
  }
  return { board: { bestScore: cur }, improved: false };
}

// { closest, improved }: a strictly smaller km replaces. context distinguishes
// a daily pin from a party (own-phone h2h) pin; couch guesses never call this.
export function foldClosest(closest, km, context) {
  if (typeof km !== "number" || !Number.isFinite(km)) {
    return { closest: closest || null, improved: false };
  }
  if (!closest || km < closest.km) {
    return { closest: { km, context: context === "party" ? "party" : "daily" }, improved: true };
  }
  return { closest, improved: false };
}

// ACE counters: monthCount resets on a month change ("YYYY-MM"), allTime never.
// `n` aces are added at once (a run may earn several). `monthKey` is the run's
// month; passing 0 aces still rolls the month over if it changed.
export function foldAces(aces, n, monthKey) {
  const a = aces || { month: "", monthCount: 0, allTime: 0 };
  const add = Math.max(0, n | 0);
  const sameMonth = a.month === monthKey;
  return {
    month: monthKey,
    monthCount: (sameMonth ? a.monthCount : 0) + add,
    allTime: a.allTime + add,
  };
}

// The "YYYY-MM" month key for a daily key "YYYYMMDD".
export function monthKeyOf(dayKey) {
  return `${String(dayKey).slice(0, 4)}-${String(dayKey).slice(4, 6)}`;
}

// Ghost duel counters (G8): { played, won }.
export function foldDuel(duels, won) {
  const d = duels || { played: 0, won: 0 };
  return { played: d.played + 1, won: d.won + (won ? 1 : 0) };
}

/* ================================================================
 * Orchestration — one fold the daily completion path calls (spec §3.8).
 * Pure: takes the loaded records + the finished run, returns the new records
 * and the flags the done screen needs (streak count, grace copy, PB banner,
 * ace count). Hard runs never touch the streak (§3.6) and write the hard PB
 * row; normal runs feed the streak and the normal PB row. `closest` counts
 * daily pins in both modes.
 * ================================================================ */

export function applyDailyResult(records, run, { day, key }) {
  const out = { ...defaultRecords(), ...records };
  const hard = !!(run && run.hard);
  const rounds = (run && run.rounds) || [];
  const score = (run && run.score) || 0;
  const aces = aceCount(rounds);

  let streakCount = out.streak.count;
  let graceUsed = false;
  if (!hard) {
    const before = out.streak;
    const after = foldStreak(before, key);
    graceUsed = graceJustUsed(before, after, key);
    streakCount = after.count;
    out.streak = after;
  }

  const board = foldBestScore(hard ? out.hard : out.daily, score, day);
  if (hard) out.hard = board.board; else out.daily = board.board;

  // Closest daily pin this run (both modes count; couch is excluded elsewhere).
  const closestKm = rounds.reduce(
    (m, r) => (typeof r.distanceKm === "number" && r.distanceKm < m ? r.distanceKm : m),
    Infinity);
  if (Number.isFinite(closestKm)) {
    out.closest = foldClosest(out.closest, closestKm, "daily").closest;
  }

  if (aces > 0) out.aces = foldAces(out.aces, aces, monthKeyOf(key));
  else out.aces = foldAces(out.aces, 0, monthKeyOf(key)); // month rollover only

  return {
    records: out,
    streak: streakCount,
    graceUsed,
    pb: board.improved,
    aces,
  };
}

// Fold a completed ghost duel's outcome into the duels counter (spec §3.8).
export function applyDuelResult(records, won) {
  const out = { ...defaultRecords(), ...records };
  out.duels = foldDuel(out.duels, won);
  return { records: out };
}

// Fold an OWN-PHONE party (h2h) guess into the device records (spec §3.8, R7):
// the closest-ever pin (context "party") and the ACE counters. Couch guesses
// must NEVER call this — the host phone is a shared device, so "your closest
// ever" would be the couch's, not yours (§3.8); the h2h guessing phone is
// personal, so its pins count. Records only improve. `distanceKm` null/NaN (a
// forfeit) folds nothing. Returns { records, closestImproved, ace }.
export function applyPartyGuess(records, distanceKm, monthKey) {
  const out = { ...defaultRecords(), ...records };
  const c = foldClosest(out.closest, distanceKm, "party");
  out.closest = c.closest;
  const ace = typeof distanceKm === "number" && Number.isFinite(distanceKm) &&
    distanceKm < ACE_MAX_KM;
  if (ace) out.aces = foldAces(out.aces, 1, monthKey);
  return { records: out, closestImproved: c.improved, ace };
}

// Seed the daily PB from an existing same-device result on first load, so
// yesterday's players don't see "no best" the day the feature ships (§3.8 —
// the one cheap exception to no-backfill). Idempotent: only fills a null row.
export function seedBestFromResult(records, result, day, hard = false) {
  if (!result || typeof result.score !== "number") return records;
  const out = { ...defaultRecords(), ...records };
  const row = hard ? out.hard : out.daily;
  if (row.bestScore) return out;
  const seeded = { bestScore: { score: result.score, day } };
  if (hard) out.hard = seeded; else out.daily = seeded;
  return out;
}
