// Tests for js/modifier.js — the class-level layer over the guess modifiers
// (docs/guess-modifier-design.md §6). Availability + chip state, the shared
// deploy fold, the pin-drop callout decision, and the one-home copy rules.
// The MECHANICS (resolution/settlement/plant) stay proven by supersure.test.js
// and decoy.test.js, which this change leaves untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODIFIERS,
  availableModifiers,
  modifierChipState,
  modifierInitialState,
  modifierFold,
  shouldCalloutModifier,
  markCalloutShown,
  calloutSpec,
  MODIFIER_SHEETS,
  sheetActions,
} from "../js/modifier.js";

// A team-rows map with the given spend flags.
const teamRows = (over = {}) => ({
  t1: { name: "A", ...over.t1 },
  t2: { name: "B", ...over.t2 },
});

/* ================================================================
 * availableModifiers / modifierChipState (§6)
 * ================================================================ */

test("availableModifiers: h2h, nothing spent → super then decoy; chip 🔥", () => {
  const teams = teamRows();
  const avail = availableModifiers({
    mode: "h2h", teams, teamId: "t1", twistId: null,
    deployState: modifierInitialState(),
  });
  assert.deepEqual(avail, ["super", "decoy"]);
  const chip = modifierChipState({ available: avail, deployState: modifierInitialState() });
  assert.equal(chip.visible, true);
  assert.equal(chip.icon, "🔥");
  assert.equal(chip.armed, false);
  assert.match(chip.ariaLabel, /SUPER SURE/);
});

test("availableModifiers: couch → super only (decoy is mode-gated); chip 🔥", () => {
  const teams = teamRows();
  const avail = availableModifiers({
    mode: "couch", teams, teamId: "t1", twistId: null,
    deployState: modifierInitialState(),
  });
  assert.deepEqual(avail, ["super"]);
  assert.equal(modifierChipState({ available: avail }).icon, "🔥");
});

test("availableModifiers: h2h, SUPER spent → decoy only; chip icon 🎭", () => {
  const teams = teamRows({ t1: { superSureUsed: 2 } });
  const avail = availableModifiers({
    mode: "h2h", teams, teamId: "t1", twistId: null,
    deployState: modifierInitialState(),
  });
  assert.deepEqual(avail, ["decoy"]);
  const chip = modifierChipState({ available: avail, deployState: modifierInitialState() });
  assert.equal(chip.icon, "🎭");
  assert.match(chip.ariaLabel, /Decoy/);
});

test("availableModifiers: h2h, SUPER spent + Blind twist → []; chip hidden", () => {
  const teams = teamRows({ t1: { superSureUsed: 2 } });
  const avail = availableModifiers({
    mode: "h2h", teams, teamId: "t1", twistId: "blind",
    deployState: modifierInitialState(),
  });
  assert.deepEqual(avail, []);
  assert.equal(modifierChipState({ available: avail }).visible, false);
});

test("availableModifiers: a decoy planted this round is excluded via deployState", () => {
  const teams = teamRows(); // decoyUsed not yet written into this local snapshot
  const deployState = { superArmed: false, decoy: { armed: true, planted: true } };
  const avail = availableModifiers({
    mode: "h2h", teams, teamId: "t1", twistId: null, deployState,
  });
  assert.deepEqual(avail, ["super"]);
});

test("availableModifiers: both spent → []; chip hidden", () => {
  const teams = teamRows({ t1: { superSureUsed: 1, decoyUsed: 1 } });
  const avail = availableModifiers({
    mode: "h2h", teams, teamId: "t1", twistId: null,
    deployState: modifierInitialState(),
  });
  assert.deepEqual(avail, []);
  const chip = modifierChipState({ available: avail, deployState: modifierInitialState() });
  assert.equal(chip.visible, false);
  assert.equal(chip.armed, false);
});

test("modifierChipState: armed when super armed OR decoy armed/awaiting-plant", () => {
  const superArmed = modifierChipState({
    available: ["super", "decoy"],
    deployState: { superArmed: true, decoy: { armed: false, planted: false } },
  });
  assert.equal(superArmed.armed, true);
  const decoyArmed = modifierChipState({
    available: ["decoy"],
    deployState: { superArmed: false, decoy: { armed: true, planted: false } },
  });
  assert.equal(decoyArmed.armed, true);
});

/* ================================================================
 * modifierFold (§6)
 * ================================================================ */

test("modifierFold: arm/disarm super toggles superArmed", () => {
  let s = modifierInitialState();
  s = modifierFold(s, { type: "arm", id: "super" }).state;
  assert.equal(s.superArmed, true);
  s = modifierFold(s, { type: "disarm", id: "super" }).state;
  assert.equal(s.superArmed, false);
});

test("modifierFold: a tap with super armed → place 'pin', superArmed survives", () => {
  let s = modifierFold(modifierInitialState(), { type: "arm", id: "super" }).state;
  const out = modifierFold(s, { type: "tap" });
  assert.equal(out.place, "pin");
  assert.equal(out.state.superArmed, true);
});

test("modifierFold: arm decoy → first tap plants (place 'decoy'), second is 'pin'", () => {
  // Byte-for-byte the decoyDeployFold passthrough.
  let s = modifierFold(modifierInitialState(), { type: "arm", id: "decoy" }).state;
  assert.deepEqual(s.decoy, { armed: true, planted: false });
  const first = modifierFold(s, { type: "tap" });
  assert.equal(first.place, "decoy");
  assert.deepEqual(first.state.decoy, { armed: true, planted: true });
  const second = modifierFold(first.state, { type: "tap" });
  assert.equal(second.place, "pin");
});

test("modifierFold: newRound resets both; unknown action → unchanged, place null", () => {
  const armed = {
    superArmed: true, decoy: { armed: true, planted: true },
  };
  const reset = modifierFold(armed, { type: "newRound" });
  assert.deepEqual(reset.state, modifierInitialState());
  assert.equal(reset.place, null);
  const noop = modifierFold(armed, { type: "wat" });
  assert.equal(noop.state, armed);       // same object, unchanged
  assert.equal(noop.place, null);
});

/* ================================================================
 * shouldCalloutModifier / markCalloutShown (§6)
 * ================================================================ */

const CALLOUT_BASE = {
  mode: "h2h", roundNumber: 2, available: ["super", "decoy"],
  firstPinOfRound: true, hasResult: false, calloutShown: new Set(), teamId: "t1",
};

test("shouldCalloutModifier: round 1 → null in every configuration", () => {
  for (const mode of ["h2h", "couch"]) {
    for (const available of [["super", "decoy"], ["decoy"], []]) {
      assert.equal(shouldCalloutModifier({
        ...CALLOUT_BASE, mode, roundNumber: 1, available,
      }), null);
    }
  }
});

test("shouldCalloutModifier: round ≥ 2 first pin — super, then decoy, then null", () => {
  assert.equal(shouldCalloutModifier(CALLOUT_BASE), "super");
  assert.equal(shouldCalloutModifier({ ...CALLOUT_BASE, available: ["decoy"] }), "decoy");
  assert.equal(shouldCalloutModifier({ ...CALLOUT_BASE, available: [] }), null);
});

test("shouldCalloutModifier: not-first-pin / has-result / already-shown → null", () => {
  assert.equal(shouldCalloutModifier({ ...CALLOUT_BASE, firstPinOfRound: false }), null);
  assert.equal(shouldCalloutModifier({ ...CALLOUT_BASE, hasResult: true }), null);
  assert.equal(shouldCalloutModifier({
    ...CALLOUT_BASE, calloutShown: new Set(["t1"]),
  }), null);
});

test("markCalloutShown is non-mutating and idempotent", () => {
  const before = new Set();
  const after = markCalloutShown(before, "t1");
  assert.equal(before.has("t1"), false);   // original untouched
  assert.equal(after.has("t1"), true);
  const again = markCalloutShown(after, "t1");
  assert.deepEqual([...again], ["t1"]);     // no duplicate
});

test("shouldCalloutModifier (couch): two teams, one shown → the other fires", () => {
  const shown = markCalloutShown(new Set(), "t1");
  assert.equal(shouldCalloutModifier({
    ...CALLOUT_BASE, mode: "couch", available: ["super"],
    calloutShown: shown, teamId: "t1",
  }), null);
  assert.equal(shouldCalloutModifier({
    ...CALLOUT_BASE, mode: "couch", available: ["super"],
    calloutShown: shown, teamId: "t2",
  }), "super");
});

test("shouldCalloutModifier: daily / unknown mode → null", () => {
  for (const mode of ["daily", "solo", undefined, ""]) {
    assert.equal(shouldCalloutModifier({ ...CALLOUT_BASE, mode }), null);
  }
});

/* ================================================================
 * Copy — the exactly-one-place rule (§6)
 * ================================================================ */

test("calloutSpec: teases carry the stakes hook only, never a rule phrase", () => {
  const sup = calloutSpec("super");
  assert.deepEqual(sup, { title: "Are you SUPER SURE?", line: "Tap for double or nothing 🔥" });
  const dec = calloutSpec("decoy");
  assert.deepEqual(dec, { title: "Feeling sneaky?", line: "Tap to plant a decoy pin 🎭" });
  // No rule phrases from the sheet may leak into the tease.
  for (const spec of [sup, dec]) {
    const text = `${spec.title} ${spec.line}`;
    assert.ok(!/Closest pin/i.test(text));
    assert.ok(!/once per game/i.test(text));
    assert.ok(!/×2|score 0/i.test(text));
  }
  assert.equal(calloutSpec("nope"), null);
});

test("MODIFIER_SHEETS.super.lines is byte-equal to the moved SUPER_SURE_SHEET copy", () => {
  // The rule text must not drift when it moves out of hints.js. This is the
  // verbatim pre-move string (hints.SUPER_SURE_SHEET.lines), now deleted there.
  assert.deepEqual(MODIFIER_SHEETS.super.lines, [
    "Double or nothing, once per game. Closest pin this round: your " +
    "points ×2. Anyone closer: you score 0.",
  ]);
  assert.equal(MODIFIER_SHEETS.super.title, "SUPER SURE");
  assert.equal(MODIFIER_SHEETS.super.armLabel, "Arm the bet");
  assert.equal(MODIFIER_SHEETS.super.cancelLabel, "Not now");
  assert.equal(MODIFIER_SHEETS.decoy.armLabel, "Plant the decoy");
});

test("sheetActions: both available → each sheet ends with the cross-offer", () => {
  const both = ["super", "decoy"];
  const superRows = sheetActions({ id: "super", available: both, deployState: modifierInitialState() });
  assert.equal(superRows[superRows.length - 1].kind, "cross");
  assert.equal(superRows[superRows.length - 1].target, "decoy");
  const decoyRows = sheetActions({ id: "decoy", available: both, deployState: modifierInitialState() });
  assert.equal(decoyRows[decoyRows.length - 1].kind, "cross");
  assert.equal(decoyRows[decoyRows.length - 1].target, "super");
});

test("sheetActions: a single available modifier has no cross row", () => {
  const rows = sheetActions({ id: "super", available: ["super"], deployState: modifierInitialState() });
  assert.ok(!rows.some((r) => r.kind === "cross"));
  assert.deepEqual(rows.map((r) => r.kind), ["cancel", "arm"]);
});

test("sheetActions: an armed super shows the Disarm/Keep pair", () => {
  const rows = sheetActions({
    id: "super", available: ["super"],
    deployState: { superArmed: true, decoy: { armed: false, planted: false } },
  });
  assert.deepEqual(rows.map((r) => r.kind), ["disarm", "keep"]);
  assert.equal(rows[0].label, "Disarm");
  assert.equal(rows[1].label, "Keep it armed");
});

test("MODIFIERS: priority order is super then decoy (the hero teases first)", () => {
  assert.deepEqual(MODIFIERS.map((m) => m.id), ["super", "decoy"]);
});
