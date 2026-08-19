// hints.js — pure logic for first-time education (design review §2.3,
// roadmap M5) and at-the-decision scoring legibility (§1.4, roadmap M3).
// One-shot overlay bookkeeping (localStorage-flagged, once per device,
// never a tutorial screen), the overlay copy itself, and the live "if you
// locked in now" estimate. No DOM in here — the overlay renderer lives in
// hints-ui.js.

import { scoreForDistance, timeBonus, bonusWindowMs } from "./game.js";

/* ================================================================
 * One-shot flags: each hint shows exactly once per device
 * ================================================================ */

export const HINT_PREFIX = "geoparty_hint_";

// storage is localStorage-shaped ({getItem,setItem}). Unreadable storage
// (private mode, blocked) reads as "seen": better to never hint than to
// nag on every single round.
export function hintSeen(storage, id) {
  try {
    return storage.getItem(HINT_PREFIX + id) === "1";
  } catch {
    return true;
  }
}

// Claim-and-mark in one call: true exactly once per device per hint id,
// false forever after (and false when the flag can't be persisted — a
// hint that can't be marked shown must not become a nag).
export function claimHint(storage, id) {
  if (hintSeen(storage, id)) return false;
  try {
    storage.setItem(HINT_PREFIX + id, "1");
  } catch {
    return false;
  }
  return true;
}

/* ================================================================
 * The overlay copy (§2.3): one thing, at the moment it's needed.
 * The showdown card deliberately carries NO comeback language — the
 * drama is the shared location, not a rescue (§1.6); a test enforces it.
 * ================================================================ */

export const HINT_CARDS = Object.freeze({
  pano: {
    title: "Where are you?",
    lines: Object.freeze([
      "Look around 👀 — figure out where you are.",
      "Then Make Guess.",
    ]),
  },
  reveal: {
    title: "How points work",
    lines: Object.freeze([
      "Your score = distance points + ⚡ speed bonus.",
      "Closer and faster = more, every round.",
    ]),
  },
  showdown: {
    title: "FINAL SHOWDOWN",
    center: true,
    lines: Object.freeze([
      "Everyone guesses the same spot. Leader goes first.",
      "Pass the phone when it's your turn.",
    ]),
  },
});

// First guess map (id "guessmap"): the scoring one-liner always; the
// rival-pins warning only where rivals can actually watch (h2h); the
// SUPER SURE line only while the bet is still unspent.
export function guessMapHintLines(mode, superSureAvailable) {
  const lines = ["🎯 Closer = more points. Fast = bonus."];
  if (mode === "h2h") {
    lines.push("👀 Rivals can see your pin move. Bluff away.");
  }
  if (superSureAvailable) {
    lines.push("🔥 Feeling certain? SUPER SURE: double or nothing, once per game.");
  }
  return lines;
}

/* ================================================================
 * "If you locked in now" (M3): the live point hint while aiming.
 * Same formula as the real scorer (scoreForDistance + timeBonus), so the
 * number on the pill is exactly what a lock-in this instant would bank.
 * ================================================================ */

export function lockNowEstimate(distanceKm, elapsedMs, roundSeconds) {
  const distancePoints = scoreForDistance(distanceKm);
  const bonus = timeBonus(
    distancePoints, Math.max(0, elapsedMs), bonusWindowMs(roundSeconds));
  return { distancePoints, bonus, points: distancePoints + bonus };
}

// Pill label. With SUPER SURE armed the pill shows the bet's real stakes —
// double the round total, or zero — which is what makes the bet legible at
// the moment of decision (§1.4).
export function lockNowLabel(est, superSureArmed) {
  if (superSureArmed) {
    return `🔥 Lock in now ≈ +${(est.points * 2).toLocaleString()} — or 0`;
  }
  const bolt = est.bonus > 0 ? ` (⚡+${est.bonus.toLocaleString()})` : "";
  return `Lock in now ≈ +${est.points.toLocaleString()}${bolt}`;
}
