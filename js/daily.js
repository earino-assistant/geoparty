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

// G6 Hard Mode (spec §3.6): the same five locations and seed as the day's
// normal daily, under harder fixed rules — no movement, 30 seconds. One
// scored hard run per day in its own storage slot, so the two locks can
// never corrupt each other and the v1 (normal) code path is untouched.
export const HARD_ROUND_SECONDS = 30;
export const DAILY_MOVE_ALLOWED = true;   // normal daily: movement on
export const HARD_MOVE_ALLOWED = false;   // hard daily: read the single frame

// Round seconds / movement for a run, keyed off its own `hard` flag so a
// saved run is self-describing (a ghost can be rebuilt from it, §5.2).
export function dailyRoundSeconds(hard) {
  return hard ? HARD_ROUND_SECONDS : DAILY_ROUND_SECONDS;
}
export function dailyMoveAllowed(hard) {
  return hard ? HARD_MOVE_ALLOWED : DAILY_MOVE_ALLOWED;
}

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

// Whole calendar days from key `a` to key `b` (b − a), parsing both as UTC
// midnights so DST-length local days can't skew the count (the same trick as
// dailyNumber). Exported for the G1 streak fold (spec §3.1): a gap of 1 is
// consecutive days, 2 is one missed day (grace territory), ≤0 is a same-day
// re-entry or a backwards clock. Empty/undefined `a` returns Infinity — the
// "first ever run" sentinel the fold reads as a fresh streak.
export function daysBetweenKeys(a, b) {
  if (!a || !b) return Infinity;
  return Math.round((keyToUtcMs(b) - keyToUtcMs(a)) / 86_400_000);
}

// Day number for a run's key (the value the ghost codec carries, §3.5.1).
export function dailyNumberForKey(key) {
  return dailyNumber(key);
}

// The inverse of dailyNumber: the "YYYYMMDD" key for a given Daily #N, built in
// UTC so it round-trips exactly (dailyNumber(dailyKeyFromNumber(n)) === n). A
// Ghost Duel recipient uses this to play the LINK's day-seed (§3.5.2) even when
// it isn't their own local today.
export function dailyKeyFromNumber(n) {
  const ms = keyToUtcMs(DAILY_EPOCH_KEY) + (n - 1) * 86_400_000;
  const d = new Date(ms);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}${mm}${dd}`;
}

/* ================================================================
 * The run: a fold over rounds. Same scorer as the party game —
 * scoreForDistance + timeBonus against the fixed 60s window — so a
 * daily point means exactly what a party point means.
 * ================================================================ */

// A run carries its own `hard` flag (G6) so the scorer, the storage slot, and
// any ghost rebuilt from a saved run all agree on the ruleset without a second
// lookup. Absent/false ⇒ the normal daily (the v1 shape, unchanged on disk).
export function newDailyRun(key, hard = false) {
  return { key, score: 0, rounds: [], hard: !!hard };
}

// One round locked in. guess is {distanceKm, elapsedMs, lat, lng}, or null when
// the clock ran out with no pin (a forfeit scores zero, like the party game).
// v2 (spec §5.2): the round entry additionally stores the pin `guess {lat,lng}`
// and `elapsedMs` so a saved run can later become a Ghost Duel challenge. These
// fields are additive — the v1 loader validates only key/score/rounds, so old
// code reads v2 saves fine and new code treats a missing pin as "no ghost from
// this round". Returns a new run; the input is never mutated.
export function recordDailyRound(run, guess) {
  const seconds = dailyRoundSeconds(run.hard);
  const elapsedMs = guess ? Math.max(0, guess.elapsedMs || 0) : 0;
  const pin = guess && typeof guess.lat === "number" &&
    typeof guess.lng === "number" ? { lat: guess.lat, lng: guess.lng } : null;
  let entry;
  if (guess && typeof guess.distanceKm === "number") {
    const distancePoints = scoreForDistance(guess.distanceKm);
    const bonus = timeBonus(distancePoints, elapsedMs, bonusWindowMs(seconds));
    entry = {
      distanceKm: guess.distanceKm,
      distancePoints,
      timeBonus: bonus,
      points: distancePoints + bonus,
      guess: pin,
      elapsedMs,
    };
  } else {
    entry = {
      distanceKm: null, distancePoints: 0, timeBonus: 0, points: 0,
      guess: null, elapsedMs,
    };
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
 * yesterday's result is superseded, so nothing accumulates. (A mid-run
 * refresh RESUMES the run from the last locked-in round, via the inflight
 * slot below; the locations are deterministic anyway, and devtools-grade
 * honesty — reloading for a fresh clock on a scouted round — is not a
 * threat model we carry, docs/daily-persistence-spec.md §4.)
 * ================================================================ */

export const DAILY_RESULT_KEY = "geoparty_daily_result";
// G6: the hard run's separate slot. A distinct key means the normal and hard
// locks can never corrupt each other, and the v1 (normal) code path is
// untouched by hard mode entirely (spec §3.6, §5.2).
export const DAILY_RESULT_HARD_KEY = "geoparty_daily_result_hard";

// The storage key for a run's board — normal vs. hard.
export function dailyResultKey(hard) {
  return hard ? DAILY_RESULT_HARD_KEY : DAILY_RESULT_KEY;
}

// storage is localStorage-shaped ({getItem,setItem}). Anything unreadable,
// malformed, or from another day reads as "not played yet". `storageKey`
// selects the normal (default) or hard slot; the validation is v1's, which
// v2 objects satisfy (only key/score/rounds are checked, §5.2).
export function loadDailyResult(storage, key, storageKey = DAILY_RESULT_KEY) {
  try {
    const parsed = JSON.parse(storage.getItem(storageKey));
    if (parsed && parsed.key === key &&
        typeof parsed.score === "number" && Array.isArray(parsed.rounds)) {
      return parsed;
    }
  } catch { /* private mode / tampered — treat as unplayed */ }
  return null;
}

export function saveDailyResult(storage, run, storageKey) {
  const target = storageKey || dailyResultKey(run && run.hard);
  try {
    storage.setItem(target, JSON.stringify(run));
  } catch { /* private mode: today just won't be remembered */ }
}

/* ================================================================
 * Mid-run persistence — resume at round N after a reload
 * (docs/daily-persistence-spec.md). One localStorage slot holds the
 * in-flight solo run so a reload / tab-kill / phone-lock resumes at the
 * last locked-in round instead of restarting from round 1. All decision
 * logic here is pure (§3); the browser glue lives in daily-ui.js. Nothing
 * in this slot is ever transmitted — it exists only to rebuild local
 * state on the same device.
 * ================================================================ */

export const DAILY_INFLIGHT_KEY = "geoparty_daily_inflight";
// Bump on ANY shape change — a mismatched version is discarded, never
// migrated (a mid-run save is worth at most DAILY_ROUNDS - 1 rounds, §8).
export const INFLIGHT_VERSION = 1;

// The persisted payload (§2). `run` is the recordDailyRound object verbatim
// (same bytes that land in geoparty_daily_result at completion, pins
// included); `cursors[i]` is the sampler cursor AFTER round i advanced, which
// encodes both the resume position (last element) and — via order[cursors[i]
// - 1] — the exact truth each round showed; `poolCheck` is ghost.js's 16-bit
// fold over the day's first DAILY_ROUNDS skip-free ids (a hash, never an id),
// the drift guard applied at resume time (§5.3).
export function buildInflight(run, cursors, poolCheck) {
  return {
    v: INFLIGHT_VERSION,
    poolCheck,
    cursors: cursors.slice(),
    run,
  };
}

// Total validator: raw JSON string -> { run, cursors, poolCheck, complete }
// or null. Never throws. Discards anything stale, tampered, or from another
// day so broken persistence can only ever degrade to a fresh run (§8).
export function parseInflight(raw, todayKey) {
  try {
    const p = JSON.parse(raw);
    if (!p || p.v !== INFLIGHT_VERSION) return null;
    const run = p.run;
    // The loadDailyResult structural checks, plus day-scope: yesterday's
    // half-run indexed yesterday's seed order and must never restore.
    if (!run || run.key !== todayKey ||
        typeof run.score !== "number" || !Array.isArray(run.rounds)) return null;
    const n = run.rounds.length;
    if (n < 1 || n > DAILY_ROUNDS) return null;
    // Score integrity: every round carries the numeric aggregates the recap
    // and the completed-event read.
    for (const r of run.rounds) {
      if (!r || typeof r.points !== "number" ||
          typeof r.distancePoints !== "number" ||
          typeof r.timeBonus !== "number") return null;
    }
    // cursors: strictly increasing positive ints, one per played round.
    const cursors = p.cursors;
    if (!Array.isArray(cursors) || cursors.length !== n) return null;
    let prev = 0;
    for (const c of cursors) {
      if (!Number.isInteger(c) || c <= prev) return null;
      prev = c;
    }
    return { run, cursors, poolCheck: p.poolCheck, complete: n >= DAILY_ROUNDS };
  } catch { return null; }
}

// Pool-drift guard (§5.3), applied once the day's ids are loaded at resume
// time: if the pool file redeployed mid-day the seeded order reshuffles and
// the persisted cursors point at different entries. poolCheckNow is ghost.js
// poolCheck over the re-derived day ids.
export function inflightMatchesPool(inflight, poolCheckNow) {
  return !!inflight && inflight.poolCheck === poolCheckNow;
}

// Rebuild playedPlaces (the truths actually shown, skip-adjusted) from the
// seeded `order` array + the persisted cursors: entry i is order[cursors[i]
// - 1]. Returns null if any cursor exceeds the order (pool shrank; the caller
// discards — the poolCheck guard normally catches this first). Only name +
// coords are read; no image id or user text is touched.
export function placesFromCursors(order, cursors) {
  const places = [];
  for (const c of cursors) {
    const e = order[c - 1];
    if (!e) return null;
    places.push({ name: e.name, lat: e.lat, lng: e.lng });
  }
  return places;
}

// Boot arbitration for the inflight SLOT against a completed saved result for
// the same day+mode (§5.1 rule 2, §6). A saved result discards the inflight —
// the double-fold guard that makes the finalize fold un-repeatable: a crash
// after saveDailyResult but before clearInflight must not re-fold the streak.
export function resolveInflight({ inflight, hasSavedResult }) {
  if (!inflight) return "discard";
  if (hasSavedResult) return "discard";
  return inflight.complete ? "finalize" : "resume";
}

// Thin storage glue (house style: try/catch, degrade to null/no-op). A stale
// or corrupt slot is removed on read so it can't linger (§4/§8); a save that
// hits quota / private mode is swallowed (the run continues un-persisted).
export function loadInflight(storage, todayKey) {
  try {
    const parsed = parseInflight(storage.getItem(DAILY_INFLIGHT_KEY), todayKey);
    if (!parsed) {
      try { storage.removeItem(DAILY_INFLIGHT_KEY); } catch { /* ignore */ }
      return null;
    }
    return parsed;
  } catch { return null; }
}

export function saveInflight(storage, payload) {
  try {
    storage.setItem(DAILY_INFLIGHT_KEY, JSON.stringify(payload));
  } catch { /* quota / private mode: run continues un-persisted */ }
}

export function clearInflight(storage) {
  try { storage.removeItem(DAILY_INFLIGHT_KEY); } catch { /* swallow */ }
}
