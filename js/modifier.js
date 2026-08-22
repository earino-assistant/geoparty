// modifier.js — the shared, pure layer for the location-guess MODIFIER class
// (docs/guess-modifier-design.md). A modifier is an attachment a team puts on
// its pin BEFORE locking in, once per game, hidden from rivals until the
// reveal. Two instances exist: SUPER SURE 🔥 (double-or-nothing, h2h + couch)
// and the Decoy 🎭 (a fake pin for rivals, h2h only).
//
// This module owns only the CLASS-LEVEL decisions — what's available, what the
// one chip shows, when the pin-drop callout fires, what every surface says, and
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

// Priority order IS array order: SUPER SURE is the hero tease; the decoy
// teases only when SUPER is spent. A third modifier slots in by adding an
// entry — no UI code changes. `ariaLabel` lives here so the chip's a11y name
// tracks the icon it renders.
export const MODIFIERS = Object.freeze([
  Object.freeze({
    id: "super",
    icon: "🔥",
    modes: Object.freeze(["h2h", "couch"]),
    ariaLabel: "SUPER SURE — once-per-game plays",
    // (teams, teamId, twistId) → bool. Delegates to the mechanic module.
    isAvailable: (teams, teamId, _twistId) => superSureAvailable(teams, teamId),
  }),
  Object.freeze({
    id: "decoy",
    icon: "🎭",
    modes: Object.freeze(["h2h"]),
    ariaLabel: "Decoy — once-per-game plays",
    isAvailable: (teams, teamId, twistId) => decoyAvailable(teams, teamId, twistId),
  }),
]);

const byId = (id) => MODIFIERS.find((m) => m.id === id) || null;

/* ================================================================
 * Availability + chip state (§3.2)
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

// True when any AVAILABLE modifier is currently armed: super armed, or the
// decoy armed and awaiting its plant tap.
function anyArmed(available, deployState) {
  if (!deployState) return false;
  if (available.includes("super") && deployState.superArmed) return true;
  const d = deployState.decoy;
  if (available.includes("decoy") && d && d.armed && !d.planted) return true;
  return false;
}

// What the one chip renders. icon is the FIRST available modifier's icon;
// armed is true when ANY modifier is armed. visible=false ⇒ chip hidden
// (spent = gone, §2.6).
export function modifierChipState({ available, deployState }) {
  const avail = available || [];
  if (!avail.length) {
    return { visible: false, icon: "", armed: false, ariaLabel: "" };
  }
  const first = byId(avail[0]);
  return {
    visible: true,
    icon: first ? first.icon : "",
    armed: anyArmed(avail, deployState),
    ariaLabel: first ? first.ariaLabel : "",
  };
}

/* ================================================================
 * The per-round deploy state (§3.3) — one fold, one shape, both screens
 * ================================================================ */

export function modifierInitialState() {
  return { superArmed: false, decoy: decoyInitialState() };
}

// Actions:
//   { type: "arm",    id: "super" | "decoy" }
//   { type: "disarm", id: "super" }            // decoy has no disarm (§3.7)
//   { type: "tap" }                            // a guess-map tap
//   { type: "newRound" }                       // reset everything round-local
// Returns { state, place } where place is "decoy" | "pin" | null. "arm decoy"
// and "tap" delegate to decoyDeployFold and pass its verdict through untouched,
// so decoy.js remains the single owner of plant logic. superArmed survives a
// "tap" (arming is per-pin but taps just move the pin); newRound resets both.
export function modifierFold(state, action) {
  const s = state || modifierInitialState();
  const a = action || {};
  if (a.type === "arm" && a.id === "super") {
    return { state: { ...s, superArmed: true }, place: null };
  }
  if (a.type === "disarm" && a.id === "super") {
    return { state: { ...s, superArmed: false }, place: null };
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

// Which modifier to tease at this pin drop, or null. Priority = registry order.
export function shouldCalloutModifier({
  mode, roundNumber, available, firstPinOfRound, hasResult, calloutShown, teamId,
}) {
  if (mode !== "h2h" && mode !== "couch") return null;   // never on the Daily
  if (typeof roundNumber !== "number" || roundNumber < 2) return null; // r1 calm
  if (!firstPinOfRound) return null;    // only the tap that CREATED the real pin
  if (hasResult) return null;           // already locked in
  if (!available || !available.length) return null;
  if (calloutShown && calloutShown.has(teamId)) return null; // once per game/team
  return available[0];
}

// The per-game memory. Pure Set-in/Set-out so couch (per active team) and h2h
// (single team) share one shape. Non-mutating and idempotent.
export function markCalloutShown(calloutShown, teamId) {
  const next = new Set(calloutShown || []);
  next.add(teamId);
  return next;
}

/* ================================================================
 * Copy — every modifier surface, one home (§3.5)
 * ================================================================ */

// The tease (context pill). ≤ 2 short lines, stakes-headline HOOK only — the
// full rule lives in the sheet and nowhere else (§4.5). No rule phrases.
export function calloutSpec(id) {
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

// The sheet's action rows, including the symmetric cross-offer: when BOTH are
// available, each sheet ends with a secondary action opening the other. An
// armed SUPER shows Disarm/Keep instead of Cancel/Arm; the decoy has no disarm.
// Rows: { kind: "arm"|"disarm"|"keep"|"cancel"|"cross", label, target? }.
export function sheetActions({ id, available, deployState }) {
  const sheet = MODIFIER_SHEETS[id];
  if (!sheet) return [];
  const avail = available || [];
  const rows = [];
  if (id === "super" && deployState && deployState.superArmed) {
    rows.push({ kind: "disarm", label: "Disarm" });
    rows.push({ kind: "keep", label: "Keep it armed" });
  } else {
    rows.push({ kind: "cancel", label: sheet.cancelLabel });
    rows.push({ kind: "arm", label: sheet.armLabel });
  }
  const other = id === "super" ? "decoy" : "super";
  if (avail.includes(id) && avail.includes(other)) {
    rows.push({
      kind: "cross",
      label: other === "decoy"
        ? "🎭 Plant a decoy instead"
        : "🔥 Arm SUPER SURE instead",
      target: other,
    });
  }
  return rows;
}
