// twist.js — the Twist engine (G2, spec §3.2). No DOM, no Firebase. A party
// round from round 2 on may carry one twist: a one-line rule change announced
// with a card flip. The draw is a pure function of (roomCode, roundNumber,
// settings) and NEVER of standings — that is the mechanical guarantee that
// twists soften blowouts without scripting comebacks (constitution §10.1).
//
// The round starter writes round/twist:{id} into the round-start patch; every
// other device reads it and never re-draws, so version skew can't split a room.

import { hashSeed, mulberry32 } from "./pool.js";
import { scoreForDistance, timeBonus, bonusWindowMs } from "./game.js";

export const TWIST_SETTINGS = ["off", "occasional", "chaos"];
export const TWIST_SETTING_DEFAULT = "occasional";
export const BLITZ_SECONDS = 20;
export const BLITZ_MULTIPLIER = 1.5;
// ~35% of eligible rounds get a twist on "occasional" (owner checklist #9).
export const OCCASIONAL_P = 0.35;

// The launch deck (data-only). `modes` gates by game mode; `hud` rides the
// round label; `revealTag` joins the reveal result line.
export const TWIST_DECK = Object.freeze([
  { id: "blitz", card: "⚡ BLITZ", rule: "20-second clock · round ×1.5", hud: "⚡BLITZ", revealTag: "×1.5 ⚡", modes: ["couch", "h2h"] },
  { id: "frozen", card: "🧊 FROZEN", rule: "No moving — read the frame", hud: "🧊FROZEN", revealTag: "🧊", modes: ["couch", "h2h"] },
  { id: "blind", card: "🔒 BLIND DUEL", rule: "Rival pins are hidden", hud: "🔒BLIND", revealTag: "🔒", modes: ["h2h"] },
  { id: "longhaul", card: "🌍 LONG HAUL", rule: "Gentler curve — go bold", hud: "🌍LONGHAUL", revealTag: "🌍", modes: ["couch", "h2h"] },
]);

export function twistById(id) {
  return TWIST_DECK.find((t) => t.id === id) || null;
}

export function normalizeTwistSetting(value) {
  return TWIST_SETTINGS.includes(value) ? value : "off";
}

// The card copy for the interstitial + the HUD/reveal tags — pure lookups so
// the DOM glue never hard-codes a string.
export function twistCard(id) {
  const t = twistById(id);
  return t ? { card: t.card, rule: t.rule } : null;
}
export function twistHudTag(id) {
  const t = twistById(id);
  return t ? t.hud : "";
}
export function twistRevealTag(id) {
  const t = twistById(id);
  return t ? t.revealTag : "";
}

/* ================================================================
 * Eligibility (spec §3.2). A twist is eligible for a round when its mode
 * matches and its lever is meaningful; the caller passes the room facts.
 * ================================================================ */

export function twistEligible(id, {
  mode, moveAllowed, difficulty, numTeams, poolScored, longHaulExhausted,
}) {
  const t = twistById(id);
  if (!t || !t.modes.includes(mode)) return false;
  if (id === "frozen") return moveAllowed === true;   // can't freeze a frozen room
  if (id === "blind") return mode === "h2h" && (numTeams || 0) > 1;
  if (id === "longhaul") {
    return poolScored === true && difficulty !== "expert" && !longHaulExhausted;
  }
  return true;   // blitz
}

// The eligible ids for a round (before the frequency gate and prev-twist rule).
export function eligibleTwists(opts) {
  return TWIST_DECK
    .map((t) => t.id)
    .filter((id) => id !== opts.prevTwistId && twistEligible(id, opts));
}

/* ================================================================
 * The seeded, fair draw (spec §3.2). Deterministic in (roomCode, roundNumber)
 * so a resumed host redraws identically and no device ever disagrees.
 * ================================================================ */

export function drawTwist(opts) {
  const {
    roomCode, roundNumber, twists, isShowdown,
  } = opts;
  const setting = normalizeTwistSetting(twists);
  if (setting === "off") return null;
  if (roundNumber <= 1) return null;        // easy-first-round guard (pool.js)
  if (isShowdown) return null;              // the Final Showdown keeps its ritual
  const eligible = eligibleTwists(opts);
  if (eligible.length === 0) return null;
  const rand = mulberry32(hashSeed(`${roomCode}:${roundNumber}`));
  const gate = rand();                      // consumed first, always, so the
  const pick = rand();                      // pick stream is stable across modes
  if (setting === "occasional" && gate >= OCCASIONAL_P) return null;
  return eligible[Math.floor(pick * eligible.length)];
}

/* ================================================================
 * Application helpers (pure — spec §3.2). Passing twist === null yields the
 * plain, un-twisted values, so these are drop-in for every scored round.
 * ================================================================ */

export function twistRoundSeconds(settings, twist) {
  if (twist === "blitz") return BLITZ_SECONDS;
  return (settings && settings.roundSeconds) || 0;
}

export function twistMoveAllowed(settings, twist) {
  if (twist === "frozen") return false;
  return !!(settings && settings.moveAllowed);
}

export function twistMultiplier(twist) {
  return twist === "blitz" ? BLITZ_MULTIPLIER : 1;
}

// The gentler Long Haul curve: the existing tested scorer with the distance
// halved (an effective 2,984 km decay). Max stays 5,000 — a bonus hunt, not a
// punishment.
export function longHaulDistancePoints(km) {
  return scoreForDistance(km / 2);
}

// Whether the live rival-pin feed is suppressed this round (Blind Duel).
export function twistHidesRivalPins(twist) {
  return twist === "blind";
}

// One number, banked into the same `total` as always:
// points = round(mult × (distancePoints + timeBonus)). For longhaul the
// distance points use the gentled curve and the time bonus scales off them.
export function twistedRoundScore(twist, km, elapsedMs, settings) {
  const windowMs = bonusWindowMs(twistRoundSeconds(settings, twist));
  const dp = twist === "longhaul" ? longHaulDistancePoints(km) : scoreForDistance(km);
  const tb = timeBonus(dp, Math.max(0, elapsedMs || 0), windowMs);
  const mult = twistMultiplier(twist);
  return { distancePoints: dp, timeBonus: tb, points: Math.round(mult * (dp + tb)) };
}
