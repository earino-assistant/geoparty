// modifier.js — the shared, pure layer for the location-guess MODIFIER class
// (docs/guess-modifier-design.md). A modifier is an attachment a team puts on
// its pin BEFORE locking in, once per game, hidden from rivals until the
// reveal. Two instances exist: SUPER SURE 🔥 (double-or-nothing, h2h + couch)
// and the Decoy 🎭 (a fake pin for rivals, h2h only).
//
// This module owns only the CLASS-LEVEL decisions — what's available, when the
// pin-drop callout fires, what every surface says, and
// the per-round deploy state. It has NO DOM and NO network, the same discipline
// as game.js. The MECHANICS stay where they live: supersure.js keeps
// resolution/settlement/reveal, decoy.js keeps the plant fold / reveal
// exposure / write-at-plant. modifier.js delegates to their availability
// primitives and their fold and never reimplements them.

import { superSureAvailable } from "./supersure.js";
import { decoyAvailable, decoyInitialState, decoyDeployFold } from "./decoy.js";

/* ================================================================
 * The registry (§3.1)
 * ================================================================ */

// Array order is DISPLAY order only (§A2.2 revoked the SUPER-first priority):
// tease line, sheet sections and action rows all follow this order, but both
// available modifiers are presented co-equally. A third modifier slots in by
// adding an entry — no UI code changes.
export const MODIFIERS = Object.freeze([
  Object.freeze({
    id: "super",
    icon: "🔥",
    modes: Object.freeze(["h2h", "couch"]),
    // (teams, teamId, twistId) → bool. Delegates to the mechanic module.
    isAvailable: (teams, teamId, _twistId) => superSureAvailable(teams, teamId),
  }),
  Object.freeze({
    id: "decoy",
    icon: "🎭",
    modes: Object.freeze(["h2h"]),
    isAvailable: (teams, teamId, twistId) => decoyAvailable(teams, teamId, twistId),
  }),
]);

/* ================================================================
 * Availability (§3.2)
 * ================================================================ */

// Ordered ids of modifiers this team can still play this round. deployState
// folds in round-local facts the team rows can't know: a planted decoy is no
// longer offerable this round even though decoyUsed was already written at
// plant time (belt and braces — a local snapshot may not yet reflect the write).
export function availableModifiers({ mode, teams, teamId, twistId, deployState }) {
  const out = [];
  for (const m of MODIFIERS) {
    if (!m.modes.includes(mode)) continue;
    if (!m.isAvailable(teams, teamId, twistId)) continue;
    if (m.id === "decoy" && deployState && deployState.decoy &&
        deployState.decoy.planted) {
      continue; // planted this round → no longer offerable
    }
    out.push(m.id);
  }
  return out;
}

/* ================================================================
 * The per-round deploy state (§3.3) — one fold, one shape, both screens
 * ================================================================ */

export function modifierInitialState() {
  return { superArmed: false, decoy: decoyInitialState() };
}

// Actions:
//   { type: "arm",    id: "super" | "decoy" }  // arming commits — no disarm (§A2.3)
//   { type: "tap" }                            // a guess-map tap
//   { type: "newRound" }                       // reset everything round-local
// Returns { state, place } where place is "decoy" | "pin" | null. "arm decoy"
// and "tap" delegate to decoyDeployFold and pass its verdict through untouched,
// so decoy.js remains the single owner of plant logic. superArmed survives a
// "tap" (arming is per-pin but taps just move the pin); newRound resets both.
// There is no disarm action (§A2.3: arm is a commitment); a stray
// {type:"disarm"} falls through to the unknown-action row, unchanged.
export function modifierFold(state, action) {
  const s = state || modifierInitialState();
  const a = action || {};
  if (a.type === "arm" && a.id === "super") {
    return { state: { ...s, superArmed: true }, place: null };
  }
  if (a.type === "arm" && a.id === "decoy") {
    const d = decoyDeployFold(s.decoy, "arm");
    return { state: { ...s, decoy: d.state }, place: d.place };
  }
  if (a.type === "tap") {
    const d = decoyDeployFold(s.decoy, "tap");
    return { state: { ...s, decoy: d.state }, place: d.place };
  }
  if (a.type === "newRound") {
    return { state: modifierInitialState(), place: null };
  }
  return { state: s, place: null };
}

/* ================================================================
 * The callout decision (§3.4)
 * ================================================================ */

// The ordered available modifiers to tease at this pin drop, or null. Stateless
// — fires on EVERY qualifying round's first real-pin drop while at least one
// modifier is unspent, from round 1 (§A2.1: no calm-round gate, no per-game
// memory). `firstPinOfRound` is itself the once-per-round latch. Returns the
// full `available` array (feeding the co-equal both-sheet, §A2.2), never a
// single priority pick.
export function shouldCalloutModifier({
  mode, roundNumber, available, firstPinOfRound, hasResult,
}) {
  if (mode !== "h2h" && mode !== "couch") return null;   // never on the Daily
  if (typeof roundNumber !== "number" || roundNumber < 1) return null; // defensive
  if (!firstPinOfRound) return null;    // only the tap that CREATED the real pin
  if (hasResult) return null;           // already locked in
  if (!available || !available.length) return null; // spent → self-extinguishes
  return available;
}

/* ================================================================
 * Copy — every modifier surface, one home (§3.5)
 * ================================================================ */

// The tease (context pill). Takes the ordered available array. ≤ 2 short lines,
// stakes-headline HOOK only — the full rule lives in the sheet and nowhere else
// (§4.5). No rule phrases. When both modifiers are available the both-tease
// presents them co-equally (§A2.2); one tap opens the one two-section sheet.
export function calloutSpec(available) {
  const avail = available || [];
  if (avail.length > 1) {
    return {
      title: "Raise the stakes?",
      line: "🔥 Double or nothing · 🎭 Decoy pin",
    };
  }
  const id = avail[0];
  if (id === "super") {
    return { title: "Are you SUPER SURE?", line: "Tap for double or nothing 🔥" };
  }
  if (id === "decoy") {
    return { title: "Feeling sneaky?", line: "Tap to plant a decoy pin 🎭" };
  }
  return null;
}

// The sheet (the ONE place each rule is explained — review §6.1). super.lines
// is byte-equal to the previous SUPER_SURE_SHEET.lines (moved verbatim, not
// reworded); decoy.lines is the previous inline copy from player-ui.js.
export const MODIFIER_SHEETS = Object.freeze({
  super: Object.freeze({
    title: "SUPER SURE",
    lines: Object.freeze([
      "Double or nothing, once per game. Closest pin this round: your " +
      "points ×2. Anyone closer: you score 0.",
      // §A2.3: arming commits — the one place that rule is stated.
      "Once armed, the bet is on — no backing out this round.",
    ]),
    armLabel: "Arm the bet",
    cancelLabel: "Not now",
  }),
  decoy: Object.freeze({
    title: "🎭 Decoy",
    lines: Object.freeze([
      "Plant a fake pin for rivals to see. Your real pin goes dark.",
      "Once per game.",
    ]),
    armLabel: "Plant the decoy",
    cancelLabel: "Not now",
  }),
});

// The combined sheet's action rows: one co-equal "arm" row per available
// modifier in registry order, each carrying its own id and primary label, then
// one shared cancel (§A2.2). There are NO cross rows (both live options are
// already on the one sheet) and NO disarm/keep rows (arming commits, §A2.3).
// Rows: { kind: "arm", id, label } and { kind: "cancel", label }.
export function sheetActions({ available, deployState: _deployState }) {
  const avail = available || [];
  const rows = [];
  for (const m of MODIFIERS) {
    if (!avail.includes(m.id)) continue;
    rows.push({ kind: "arm", id: m.id, label: MODIFIER_SHEETS[m.id].armLabel });
  }
  if (!rows.length) return [];
  rows.push({ kind: "cancel", label: "Not now" });
  return rows;
}
