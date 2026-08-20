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

/* ================================================================
 * Phone reveal, de-cluttered (design review §2.8 / §6.4)
 * ================================================================
 * Before: three stat cards (Location / Distance / Points) plus two injected
 * sub-lines, then TWO lists ("This round" and "Totals"). After: the place
 * name is the headline under the map, ONE result line carries the whole
 * personal outcome, and ONE board merges the two lists so the round delta
 * sits next to the running total instead of the eye having to join them.
 * Both formatters are pure so the copy is testable; the DOM glue lives in
 * player-ui.js / host-ui.js / daily-ui.js. */

// "+3,120 pts · 812 km · ⚡+140 fast" — one line for the whole personal
// result, SUPER SURE verdict appended when the round carried a bet. G2/G4:
// an optional `twistTag` (e.g. "×1.5 ⚡", precomputed via twist.js so game.js
// stays free of a twist.js import cycle) and `medalCaption` ("ACE!" / "Nailed
// it") extend the line — both absent ⇒ the pre-G2 output, byte-for-byte.
export function revealResultLine(result) {
  if (!result || !result.guess) {
    // A burned bet is not a plain forfeit: it spent something.
    return result && result.superSure
      ? "+0 pts · no pin · 🔥 SUPER SURE — 0"
      : "+0 pts · no pin";
  }
  const parts = [`+${adjustedPoints(result).toLocaleString()} pts`];
  if (result.twistTag) parts.push(result.twistTag);
  parts.push(formatDistance(result.distanceKm));
  if (result.medalCaption) parts.push(result.medalCaption);
  if (result.timeBonus > 0) {
    parts.push(`⚡+${result.timeBonus.toLocaleString()} fast`);
  }
  if (result.superSure) {
    parts.push(result.superSureOutcome === "won"
      ? "🔥 SUPER SURE ×2"
      : "🔥 SUPER SURE — 0");
  }
  return parts.join(" · ");
}

/* The merged board: standings order (the running score is the persistent
 * truth), with the crown on the round's CLOSEST pin — so the one row the
 * old "This round" list existed to show survives the merge. Teams with no
 * result this round (couch solo rounds, where only the active team guessed)
 * simply carry a +0 delta. */
export function revealBoardRows(teams, results) {
  const res = results || {};
  let closestId = null;
  let closest = Infinity;
  for (const id of Object.keys(res)) {
    const r = res[id];
    if (r && r.guess && typeof r.distanceKm === "number" &&
        r.distanceKm < closest) {
      closest = r.distanceKm;
      closestId = id;
    }
  }
  return standings(teams).map((t) => ({
    id: t.id,
    name: t.name,
    delta: adjustedPoints(res[t.id]),
    total: t.total,
    crown: t.id === closestId,
  }));
}

// "+3,120 → 9,480": this round's delta, then where it leaves you.
export function boardRowText(row) {
  return `+${(row.delta || 0).toLocaleString()} → ` +
    `${(row.total || 0).toLocaleString()}`;
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

/* A MapillaryJS viewer pose — {bearing, center:[x,y], zoom} — is written into
 * live room state (couch: round/pose; h2h: round/live/<tid>/pose) and mirrored
 * onto the TV. A viewer read mid-navigation can hand back a NaN/Infinity center
 * coordinate or zoom, and Firebase rejects an ENTIRE multi-path update when any
 * value is non-finite ("update failed: values argument contains NaN in property
 * rooms.…round.live.t1.pose.center.0"). One bad center would therefore drop the
 * whole live patch — the pin, the phase flip, everything.
 *
 * sanitizePose validates a pose before it is written OR applied: a fully finite
 * pose passes through as a fresh copy (so a caller can't alias room state), and
 * anything non-finite or structurally wrong (missing/short center, NaN bearing/
 * zoom, nullish) returns null so writers simply omit the pose and TV appliers
 * skip it — the rest of the patch/frame is untouched. Pure — tested in
 * tests/game.test.js. */
export function sanitizePose(pose) {
  if (!pose || typeof pose !== "object") return null;
  const { bearing, center, zoom } = pose;
  if (!Number.isFinite(bearing)) return null;
  if (!Array.isArray(center) || center.length !== 2) return null;
  if (!Number.isFinite(center[0]) || !Number.isFinite(center[1])) return null;
  if (!Number.isFinite(zoom)) return null;
  return { bearing, center: [center[0], center[1]], zoom };
}
