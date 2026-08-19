// daily.js — pure Daily Challenge logic (design review S2, "the single most
// important product change"). A date-seeded, solo run of DAILY_ROUNDS
// locations: the seed is derived from the LOCAL calendar date (Wordle's
// rule — your "today" is your midnight, not UTC's), so everyone playing on
// a given day walks the same shuffled pool order and scores are comparable
// and shareable. No DOM, no network in here — the browser glue lives in
// daily-ui.js, and the seeded shuffle itself is pool.js's (already tested).

import { scoreForDistance, timeBonus, bonusWindowMs } from "./game.js";

/* ================================================================
 * The fixed rules. Comparable scores need identical rules for every
 * player, so nothing here is configurable: five rounds, 60 seconds
 * each, movement allowed (the UI wires that part up).
 * ================================================================ */

export const DAILY_ROUNDS = 5;
export const DAILY_ROUND_SECONDS = 60;

// Daily #1. The number is a day counter, not a date — "Daily #37" is what
// the share card brags, exactly like Wordle's puzzle number.
export const DAILY_EPOCH_KEY = "20260819";

/* ================================================================
 * Date key -> seed -> day number
 * ================================================================ */

// Local-date key, e.g. "20260819". Everything daily hangs off this string.
export function dailyKey(date) {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}${m}${d}`;
}

// The PoolSampler seed for a day. Namespaced so a daily order can never
// collide with a real room code's order (codes are 6 letters).
export function dailySeed(key) {
  return `daily-${key}`;
}

// Parse a key as a UTC midnight — calendar-day arithmetic without DST
// surprises (local DST days are 23/25h; UTC days never are).
function keyToUtcMs(key) {
  return Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8));
}

// "Daily #N": days since the epoch, 1-based. Pre-epoch clocks go ≤ 0 —
// harmless (the seed, not the number, picks the locations).
export function dailyNumber(key) {
  return Math.round((keyToUtcMs(key) - keyToUtcMs(DAILY_EPOCH_KEY)) / 86_400_000) + 1;
}

/* ================================================================
 * The run: a fold over rounds. Same scorer as the party game —
 * scoreForDistance + timeBonus against the fixed 60s window — so a
 * daily point means exactly what a party point means.
 * ================================================================ */

export function newDailyRun(key) {
  return { key, score: 0, rounds: [] };
}

// One round locked in. guess is {distanceKm, elapsedMs}, or null when the
// clock ran out with no pin (a forfeit scores zero, like the party game).
// Returns a new run; the input is never mutated.
export function recordDailyRound(run, guess) {
  let entry;
  if (guess && typeof guess.distanceKm === "number") {
    const distancePoints = scoreForDistance(guess.distanceKm);
    const bonus = timeBonus(
      distancePoints,
      Math.max(0, guess.elapsedMs || 0),
      bonusWindowMs(DAILY_ROUND_SECONDS)
    );
    entry = {
      distanceKm: guess.distanceKm,
      distancePoints,
      timeBonus: bonus,
      points: distancePoints + bonus,
    };
  } else {
    entry = { distanceKm: null, distancePoints: 0, timeBonus: 0, points: 0 };
  }
  return {
    ...run,
    score: run.score + entry.points,
    rounds: [...run.rounds, entry],
  };
}

export function dailyRunComplete(run) {
  return run.rounds.length >= DAILY_ROUNDS;
}

// Rounds that actually landed a pin (feeds daily_challenge_completed).
export function guessedRounds(run) {
  return run.rounds.filter((r) => r.distanceKm != null).length;
}

// Closest guess of the run, or null for an all-forfeit run.
export function bestDailyDistance(run) {
  const ds = run.rounds.filter((r) => r.distanceKm != null)
    .map((r) => r.distanceKm);
  return ds.length ? Math.min(...ds) : null;
}

/* ================================================================
 * Replay lock: one scored run per day per device. A single slot —
 * yesterday's result is superseded, so nothing accumulates. (A
 * mid-run refresh restarts the run; the locations are deterministic
 * anyway, and devtools-grade honesty is not a threat model we carry.)
 * ================================================================ */

export const DAILY_RESULT_KEY = "geoparty_daily_result";

// storage is localStorage-shaped ({getItem,setItem}). Anything unreadable,
// malformed, or from another day reads as "not played yet".
export function loadDailyResult(storage, key) {
  try {
    const parsed = JSON.parse(storage.getItem(DAILY_RESULT_KEY));
    if (parsed && parsed.key === key &&
        typeof parsed.score === "number" && Array.isArray(parsed.rounds)) {
      return parsed;
    }
  } catch { /* private mode / tampered — treat as unplayed */ }
  return null;
}

export function saveDailyResult(storage, run) {
  try {
    storage.setItem(DAILY_RESULT_KEY, JSON.stringify(run));
  } catch { /* private mode: today just won't be remembered */ }
}
