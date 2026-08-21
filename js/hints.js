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
  // S7 couch-without-a-TV: the first reveal that lands on the host phone
  // instead of a TV teaches the hold-it-up move, once per device.
  phonescreen: {
    title: "This phone is the big screen",
    lines: Object.freeze([
      "No TV attached — the reveal lands right here.",
      "Hold the phone up so the couch can see.",
    ]),
  },
});

/* #7 movement-aware pano hint. The first-pano card teaches the loop's first
 * move once per device (M5). When street movement is allowed this round, its
 * second beat also points at the on-pano arrows / sequence controls that let
 * you walk the street — the "little movie controls" players found unclear —
 * WITHOUT touching the Mapillary SDK's own DOM/ARIA. Stays within the two-line
 * budget. panoHintCard(false) is the pre-#7 copy, byte-for-byte, so a
 * no-movement round is unchanged. */
export function panoHintCard(moveAllowed) {
  return {
    title: "Where are you?",
    lines: moveAllowed
      ? [
        "Look around 👀 — tap the arrows to walk the street.",
        "Then Make Guess.",
      ]
      : [
        "Look around 👀 — figure out where you are.",
        "Then Make Guess.",
      ],
  };
}

/* #7 SUPER SURE discoverability. A one-shot (per device) nudge that POINTS at
 * the 🔥 chip so the bet is findable without a permanent pill — it never
 * re-explains the mechanic (that lives in exactly one place, SUPER_SURE_SHEET).
 * Shown from round 2 onward (round 1 is deliberately calm), only while the bet
 * is still unspent, and NEVER on the Daily (which has no bet). */
export const SUPER_SURE_HINT_ID = "supersure";
export const SUPER_SURE_HINT = Object.freeze({
  title: "Feeling SUPER SURE?",
  lines: Object.freeze([
    "Tap 🔥 to place your once-a-game bet.",
  ]),
});

export function shouldHintSuperSure({ mode, roundNumber, available }) {
  return (mode === "h2h" || mode === "couch") &&
    typeof roundNumber === "number" && roundNumber >= 2 &&
    available === true;
}

// First guess map (id "guessmap"): the scoring one-liner always, plus the
// rival-pins warning where rivals can actually watch (h2h). The SUPER SURE
// line is deliberately absent — after the de-clutter pass the bet is
// explained in exactly one place, its own sheet (SUPER_SURE_SHEET below;
// review §5, "each rule of the game is explained in exactly one place").
export function guessMapHintLines(mode) {
  const lines = ["Closer = more points. Faster = bonus."];
  if (mode === "h2h") {
    lines.push("Rivals see your pin move — bluff away.");
  }
  return lines;
}

/* The one place SUPER SURE is explained (review §6.1). Opened from the 🔥
 * chip docked to the guess map's action bar — never from a pill, a button
 * label, a toast, or the guess-map hint card, all four of which used to
 * carry a copy of the rule at the same time. */
export const SUPER_SURE_SHEET = Object.freeze({
  title: "SUPER SURE",
  lines: Object.freeze([
    "Double or nothing, once per game. Closest pin this round: your " +
    "points ×2. Anyone closer: you score 0.",
  ]),
  armLabel: "Arm the bet",
  cancelLabel: "Not now",
});

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

/* The primary button's label (review §6.1). The estimate used to float on
 * its own pill above a SECOND pill for SUPER SURE; both pills are gone and
 * the number now rides on the button — exactly where the decision is made,
 * one element instead of three. With the bet armed the label shows its real
 * stakes (×2 or nothing), which is what makes it legible at the moment of
 * decision (§1.4). Each surface passes its own verbs. */
export const LOCK_LABELS = Object.freeze({
  h2h: Object.freeze({ idle: "Lock it in", armed: "Lock in" }),
  couch: Object.freeze({ idle: "Confirm guess", armed: "Confirm" }),
  daily: Object.freeze({ idle: "Lock it in", armed: "Lock in" }),
});

// P0.2: the primary CTA used to show its verb ("Lock it in") even while
// disabled with no pin down, which reads as broken rather than "not yet
// available". Disabled and armed-but-unpinned states are unaffected by this —
// an armed SUPER SURE bet still shows its real stakes either way (below).
export const TAP_MAP_GATE_TEXT = "Tap the map to drop your pin";

/* Returns the button's parts, not a flat string: at 360 px the guess bar
 * carries a 🔥 chip, a ghost secondary AND this primary, and §6.1 calls the
 * estimate a "sublabel" — so the verb and the number stack, and the button
 * only needs to be as wide as its widest LINE. `text` is §6.1's verbatim
 * one-line string, used as the accessible label. */
export function lockButtonLabel(labels, est, superSureArmed) {
  const l = labels || LOCK_LABELS.h2h;
  if (superSureArmed) {
    const main = `🔥 ${l.armed} ×2`;
    return { main, sub: "or 0", text: `${main} — or 0` };
  }
  if (!est) return { main: TAP_MAP_GATE_TEXT, sub: "", text: TAP_MAP_GATE_TEXT };
  const sub = `≈ +${est.points.toLocaleString()}`;
  return { main: l.idle, sub, text: `${l.idle} · ${sub}` };
}
