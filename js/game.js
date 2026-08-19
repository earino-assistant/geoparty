// game.js — shared game logic: state machine, scoring, round math.
// Used by both host-ui.js and screen-ui.js. No DOM, no Firebase in here.

import { adjustedPoints } from "./supersure.js";

export const PHASES = ["lobby", "roundActive", "guessing", "reveal", "gameOver"];

// Legal transitions, driven exclusively by host writes (spec §7).
const TRANSITIONS = {
  lobby: ["roundActive"],
  roundActive: ["guessing"],
  guessing: ["reveal"],
  reveal: ["roundActive", "gameOver"],
  gameOver: ["lobby"],
};

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

// Room codes: 6 uppercase letters, no I or O (spec §4).
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";

export function makeRoomCode() {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

export function isValidRoomCode(code) {
  return /^[A-HJ-NP-Z]{6}$/.test(code);
}

// Great-circle distance in km, haversine (spec §8).
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// GeoGuessr-style exponential decay: 5000 at zero, ~1800 at 1500km.
export function scoreForDistance(km) {
  return Math.round(5000 * Math.exp(-km / 1492));
}

/* Time bonus: speed is a skill. Every guess earns a bonus on top of its
 * distance score, scaled by BOTH speed and accuracy — up to +20% of the
 * distance score (+1000 on a perfect pin). Accuracy-scaling matters:
 * instantly slamming a random pin earns ~nothing, instantly recognizing
 * the place earns the full bonus, and in head-to-head copying a rival's
 * visible pin costs the time they already spent placing it.
 * The clock is the ROUND's clock: what matters is where in the configured
 * round length (settings.roundSeconds) the pin was locked, so "fast" means
 * the same thing whether the host picked 60s or 180s. Full bonus through a
 * short grace (time to look around and physically drop a pin — never more
 * than a fifth of the round), then the remaining-time fraction SQUARED, so
 * the bonus is meaningfully large only in the front half of the round,
 * near-zero by the last quarter, and exactly zero when time runs out.
 * No-limit rounds have no configured window, so they fall back to a fixed
 * 90s one: speed still pays, a leisurely answer just scores on distance
 * alone. The fallback is used ONLY when roundSeconds is 0. */
export const TIME_BONUS_MAX = 1000;
export const TIME_GRACE_MS = 10_000;
export const NO_LIMIT_BONUS_WINDOW_MS = 90_000;

export function bonusWindowMs(roundSeconds) {
  return roundSeconds > 0 ? roundSeconds * 1000 : NO_LIMIT_BONUS_WINDOW_MS;
}

export function timeBonus(distancePoints, elapsedMs, windowMs) {
  const grace = Math.min(TIME_GRACE_MS, windowMs * 0.2);
  const span = Math.max(1000, windowMs - grace);
  const late = Math.max(0, elapsedMs - grace);
  const speed = Math.max(0, 1 - late / span) ** 2;
  return Math.round(TIME_BONUS_MAX * (distancePoints / 5000) * speed);
}

// "23s" under a minute, "1m 04s" above — the reveal's speed lines.
export function formatSeconds(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

// One per-team reveal row: distance · speed · total. Results written
// before the time bonus existed (no elapsedMs) fall back to the old form.
// SUPER SURE bets show their fate here: a burned bet reads differently
// from a plain forfeit, a loss shows the zero, a win shows the ×2.
export function resultRowText(r) {
  if (!r.guess) return r.superSure ? "SUPER SURE — no pin · 0" : "no pin · +0";
  const dist = formatDistance(r.distanceKm);
  if (r.superSure && r.superSureOutcome === "lost") {
    return `${dist} · SUPER SURE — 0`;
  }
  const won = r.superSure && r.superSureOutcome === "won";
  const total = `+${adjustedPoints(r).toLocaleString()}`;
  const tail = won ? `SUPER SURE ×2 · ${total}` : total;
  if (typeof r.elapsedMs === "number" && typeof r.timeBonus === "number") {
    return `${dist} · ⚡${formatSeconds(r.elapsedMs)}` +
      ` +${r.timeBonus.toLocaleString()} · ${tail}`;
  }
  return `${dist} · ${tail}`;
}

// One decimal under 100km, integer km above (spec §8).
export function formatDistance(km) {
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString()} km`;
}

export function formatCountdown(msLeft) {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

// Teams are stored as {t1: {...}, t2: {...}}; stable ordering by key.
export function teamIds(teams) {
  return Object.keys(teams || {}).sort();
}

/* Turn schedule.
 * Rounds 1..R-1 are solo rounds rotating from a per-game starter derived
 * from the (random) room code, so who opens the game — and who lands any
 * extra solo guess when rounds don't divide evenly — varies game to game.
 * Round R is the Final Showdown: every team guesses the same location,
 * current leader first, so trailing teams get the last word. Solo rotation
 * keeps guess counts within one of even; the shared final adds one guess
 * to everyone, so the whole game stays within one of even too. */

export function starterIndex(roomCode, numTeams) {
  if (!numTeams) return 0;
  let h = 0;
  const code = roomCode || "";
  for (let i = 0; i < code.length; i++) {
    h = (h * 31 + code.charCodeAt(i)) >>> 0;
  }
  return h % numTeams;
}

// The last round of a multi-team game is the shared all-play round.
export function isShowdownRound(teams, settings, roundNumber) {
  return teamIds(teams).length > 1 &&
    !!settings && roundNumber >= settings.roundCount;
}

// Active team for a solo round: rotation offset by the seeded starter.
export function teamForRound(teams, roundNumber, roomCode) {
  const ids = teamIds(teams);
  if (ids.length === 0) return null;
  const start = starterIndex(roomCode, ids.length);
  return ids[(start + roundNumber - 1) % ids.length];
}

// Showdown guess order: leader guesses blind, the underdog reacts last.
export function showdownOrder(teams) {
  return standings(teams).map((t) => t.id);
}

// Showdown results sorted closest-first for the reveal.
export function showdownResults(round) {
  const results = (round && round.results) || {};
  return Object.keys(results)
    .map((id) => ({ id, ...results[id] }))
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

export function defaultTeams() {
  return { t1: { name: "Everyone", total: 0 } };
}

export function initialRoomState(settings, teams, roomCode) {
  return {
    createdAt: Date.now(),
    phase: "lobby",
    settings,
    round: null,
    teams,
    activeTeam: teamForRound(teams, 1, roomCode),
    poolCursor: 0,
    screenHeartbeat: null,
  };
}

// Standings sorted best-first for reveal scoreboard / podium.
export function standings(teams) {
  return teamIds(teams).map((id) => ({ id, ...teams[id] }))
    .sort((a, b) => b.total - a.total);
}
