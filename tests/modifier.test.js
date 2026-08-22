// Tests for js/modifier.js — the class-level layer over the guess modifiers
// (docs/guess-modifier-design.md §A2.6). Availability, the shared deploy fold,
// the pin-drop callout decision (stateless, round-1 reachable), and the
// one-home copy rules (co-equal options, arm-is-commit). The MECHANICS
// (resolution/settlement/plant) stay proven by supersure.test.js and
// decoy.test.js, which this change leaves untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODIFIERS,
  availableModifiers,
  modifierInitialState,
  modifierFold,
  shouldCalloutModifier,
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
 * availableModifiers (§A2.6)
 * ================================================================ */

test("availableModifiers: h2h, nothing spent → super then decoy", () => {
  const teams = teamRows();
  const avail = availableModifiers({
    mode: "h2h", teams, teamId: "t1", twistId: null,
    deployState: modifierInitialState(),
  });
  assert.deepEqual(avail, ["super", "decoy"]);
});

test("availableModifiers: couch → super only (decoy is mode-gated)", () => {
  const teams = teamRows();
  const avail = availableModifiers({
    mode: "couch", teams, teamId: "t1", twistId: null,
    deployState: modifierInitialState(),
  });
  assert.deepEqual(avail, ["super"]);
});

test("availableModifiers: h2h, SUPER spent → decoy only", () => {
  const teams = teamRows({ t1: { superSureUsed: 2 } });
  const avail = availableModifiers({
    mode: "h2h", teams, teamId: "t1", twistId: null,
    deployState: modifierInitialState(),
  });
  assert.deepEqual(avail, ["decoy"]);
});

test("availableModifiers: h2h, SUPER spent + Blind twist → []", () => {
  const teams = teamRows({ t1: { superSureUsed: 2 } });
  const avail = availableModifiers({
    mode: "h2h", teams, teamId: "t1", twistId: "blind",
    deployState: modifierInitialState(),
  });
  assert.deepEqual(avail, []);
});

test("availableModifiers: a decoy planted this round is excluded via deployState", () => {
  const teams = teamRows(); // decoyUsed not yet written into this local snapshot
  const deployState = { superArmed: false, decoy: { armed: true, planted: true } };
  const avail = availableModifiers({
    mode: "h2h", teams, teamId: "t1", twistId: null, deployState,
  });
  assert.deepEqual(avail, ["super"]);
});

test("availableModifiers: both spent → []", () => {
  const teams = teamRows({ t1: { superSureUsed: 1, decoyUsed: 1 } });
  const avail = availableModifiers({
    mode: "h2h", teams, teamId: "t1", twistId: null,
    deployState: modifierInitialState(),
  });
  assert.deepEqual(avail, []);
});

/* ================================================================
 * modifierFold (§A2.6) — arm is a commitment; there is no disarm
 * ================================================================ */

test("modifierFold: arm super sets superArmed (no disarm path)", () => {
  let s = modifierInitialState();
  s = modifierFold(s, { type: "arm", id: "super" }).state;
  assert.equal(s.superArmed, true);
});

test("modifierFold: a stray {type:'disarm'} falls through — state unchanged, place null", () => {
  const armed = modifierFold(modifierInitialState(), { type: "arm", id: "super" }).state;
  const out = modifierFold(armed, { type: "disarm", id: "super" });
  assert.equal(out.state, armed);       // same object, unchanged (still armed)
  assert.equal(out.state.superArmed, true);
  assert.equal(out.place, null);
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
 * shouldCalloutModifier (§A2.6) — stateless, round-1 reachable, array return
 * ================================================================ */

const CALLOUT_BASE = {
  mode: "h2h", roundNumber: 1, available: ["super", "decoy"],
  firstPinOfRound: true, hasResult: false,
};

test("shouldCalloutModifier: fires on rounds 1, 2 and 5 alike — no memory, no calm gate", () => {
  for (const roundNumber of [1, 2, 5]) {
    assert.deepEqual(
      shouldCalloutModifier({ ...CALLOUT_BASE, roundNumber }),
      ["super", "decoy"],
    );
  }
});

test("shouldCalloutModifier: returns the full ordered available array", () => {
  assert.deepEqual(shouldCalloutModifier(CALLOUT_BASE), ["super", "decoy"]);
  assert.deepEqual(
    shouldCalloutModifier({ ...CALLOUT_BASE, available: ["decoy"] }),
    ["decoy"],
  );
});

test("shouldCalloutModifier: non-numeric round / not-first-pin / has-result / empty → null", () => {
  assert.equal(shouldCalloutModifier({ ...CALLOUT_BASE, roundNumber: "1" }), null);
  assert.equal(shouldCalloutModifier({ ...CALLOUT_BASE, roundNumber: 0 }), null);
  assert.equal(shouldCalloutModifier({ ...CALLOUT_BASE, firstPinOfRound: false }), null);
  assert.equal(shouldCalloutModifier({ ...CALLOUT_BASE, hasResult: true }), null);
  assert.equal(shouldCalloutModifier({ ...CALLOUT_BASE, available: [] }), null);
});

test("shouldCalloutModifier: daily / unknown mode → null", () => {
  for (const mode of ["daily", "solo", undefined, ""]) {
    assert.equal(shouldCalloutModifier({ ...CALLOUT_BASE, mode }), null);
  }
});

test("shouldCalloutModifier (couch): both teams' turns fire in the same round, incl. round 1", () => {
  // No per-team memory: whichever team holds the phone, the first pin fires.
  for (const roundNumber of [1, 3]) {
    assert.deepEqual(shouldCalloutModifier({
      ...CALLOUT_BASE, mode: "couch", roundNumber, available: ["super"],
    }), ["super"]);
  }
});

/* ================================================================
 * Copy — the exactly-one-place rule (§A2.6)
 * ================================================================ */

test("calloutSpec: all three tease variants, exact, with no rule phrase leaking in", () => {
  const both = calloutSpec(["super", "decoy"]);
  assert.deepEqual(both, {
    title: "Raise the stakes?", line: "🔥 Double or nothing · 🎭 Decoy pin",
  });
  const sup = calloutSpec(["super"]);
  assert.deepEqual(sup, { title: "Are you SUPER SURE?", line: "Tap for double or nothing 🔥" });
  const dec = calloutSpec(["decoy"]);
  assert.deepEqual(dec, { title: "Feeling sneaky?", line: "Tap to plant a decoy pin 🎭" });
  // No rule phrases from the sheet may leak into any tease (§4.5, both-tease too).
  for (const spec of [both, sup, dec]) {
    const text = `${spec.title} ${spec.line}`;
    assert.ok(!/Closest pin/i.test(text));
    assert.ok(!/once per game/i.test(text));
    assert.ok(!/×2|score 0/i.test(text));
    assert.ok(!/no backing out/i.test(text));
  }
  assert.equal(calloutSpec([]), null);
  assert.equal(calloutSpec(["nope"]), null);
});

test("MODIFIER_SHEETS.super.lines is the moved copy verbatim + the §A2.3 commitment line", () => {
  // The original rule text (previously hints.SUPER_SURE_SHEET.lines) must not
  // drift; A2.3 appends exactly one commitment line, and nothing else.
  assert.deepEqual(MODIFIER_SHEETS.super.lines, [
    "Double or nothing, once per game. Closest pin this round: your " +
    "points ×2. Anyone closer: you score 0.",
    "Once armed, the bet is on — no backing out this round.",
  ]);
  assert.equal(MODIFIER_SHEETS.super.title, "SUPER SURE");
  assert.equal(MODIFIER_SHEETS.super.armLabel, "Arm the bet");
  assert.equal(MODIFIER_SHEETS.super.cancelLabel, "Not now");
  assert.equal(MODIFIER_SHEETS.decoy.armLabel, "Plant the decoy");
});

test("sheetActions: both available → two co-equal arm rows (registry order) + one cancel", () => {
  const rows = sheetActions({
    available: ["super", "decoy"], deployState: modifierInitialState(),
  });
  assert.deepEqual(rows, [
    { kind: "arm", id: "super", label: "Arm the bet" },
    { kind: "arm", id: "decoy", label: "Plant the decoy" },
    { kind: "cancel", label: "Not now" },
  ]);
});

test("sheetActions: a single available modifier → one arm row + cancel, nothing else", () => {
  const rows = sheetActions({ available: ["decoy"], deployState: modifierInitialState() });
  assert.deepEqual(rows, [
    { kind: "arm", id: "decoy", label: "Plant the decoy" },
    { kind: "cancel", label: "Not now" },
  ]);
});

test("sheetActions: NO cross rows and NO disarm/keep rows in any configuration", () => {
  const configs = [
    { available: ["super", "decoy"], deployState: modifierInitialState() },
    { available: ["super"], deployState: { superArmed: true, decoy: { armed: false, planted: false } } },
    { available: ["decoy"], deployState: modifierInitialState() },
    { available: [], deployState: modifierInitialState() },
  ];
  for (const cfg of configs) {
    const rows = sheetActions(cfg);
    assert.ok(!rows.some((r) => r.kind === "cross"));
    assert.ok(!rows.some((r) => r.kind === "disarm"));
    assert.ok(!rows.some((r) => r.kind === "keep"));
  }
  assert.deepEqual(sheetActions({ available: [] }), []); // nothing available → no rows
});

test("MODIFIERS: display order is super then decoy", () => {
  assert.deepEqual(MODIFIERS.map((m) => m.id), ["super", "decoy"]);
});
