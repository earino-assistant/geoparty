// Tests for js/autoadvance.js — the S6 soft auto-advance: the shared
// deadline stamp, the hold, who fires the advance, the resume/lapse guard,
// and the final-reveal landing (scoreboard, never a forced new game).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_ADVANCE_MS,
  AUTO_ADVANCE_LAPSE_MS,
  autoAdvancePatch,
  holdAdvancePatch,
  autoAdvanceStatus,
  shouldAutoAdvance,
  advanceTarget,
  advanceSecondsLeft,
  countdownText,
} from "../js/autoadvance.js";

const T = 1_700_000_000_000; // any fixed "now"

/* ---------------- the shared stamp & the hold ---------------- */

test("autoAdvancePatch: deadline is reveal-visible time + the default", () => {
  assert.deepEqual(autoAdvancePatch(T), {
    "round/autoAdvanceAt": T + AUTO_ADVANCE_MS,
  });
});

test("holdAdvancePatch: nulls the deadline (the soft part)", () => {
  assert.deepEqual(holdAdvancePatch(), { "round/autoAdvanceAt": null });
});

test("default countdown is long enough to read, short enough for tempo", () => {
  // Guard rail, not a tautology: the reveal animation alone runs ~1s per
  // team (up to 4), so anything under ~8s would advance mid-animation;
  // anything over 30s recreates the dead air the feature exists to kill.
  assert.ok(AUTO_ADVANCE_MS >= 8_000 && AUTO_ADVANCE_MS <= 30_000);
});

/* ---------------- countdown state machine ---------------- */

test("autoAdvanceStatus: counting while the deadline is ahead", () => {
  const s = autoAdvanceStatus(T + 9_000, T);
  assert.equal(s.state, "counting");
  assert.equal(s.msLeft, 9_000);
});

test("autoAdvanceStatus: due at and just past the deadline", () => {
  assert.equal(autoAdvanceStatus(T, T).state, "due");
  assert.equal(
    autoAdvanceStatus(T - AUTO_ADVANCE_LAPSE_MS, T).state, "due");
});

test("autoAdvanceStatus: lapsed beyond the lapse window (resume safety)", () => {
  assert.equal(
    autoAdvanceStatus(T - AUTO_ADVANCE_LAPSE_MS - 1, T).state, "lapsed");
  // A host resuming minutes later must never be yanked into a round.
  assert.equal(autoAdvanceStatus(T - 300_000, T).state, "lapsed");
});

test("autoAdvanceStatus: held on null / missing / junk stamps", () => {
  // null = the host held it; undefined = pre-S6 room mid-game; junk =
  // a griefed room row. All behave identically: no countdown, no fire.
  for (const stamp of [null, undefined, "soon", NaN, {}]) {
    assert.equal(autoAdvanceStatus(stamp, T).state, "held");
  }
});

/* ---------------- who fires, and when ---------------- */

test("shouldAutoAdvance: host device at a due deadline in reveal", () => {
  assert.equal(shouldAutoAdvance({
    phase: "reveal", autoAdvanceAt: T - 100, isHost: true, now: T,
  }), true);
});

test("shouldAutoAdvance: never for non-host devices", () => {
  // Advance authority stays exactly where manual advance lives — the
  // couch host phone / the h2h hostTeam phone. Everyone else just renders.
  assert.equal(shouldAutoAdvance({
    phase: "reveal", autoAdvanceAt: T - 100, isHost: false, now: T,
  }), false);
});

test("shouldAutoAdvance: only in the reveal phase", () => {
  for (const phase of ["lobby", "roundActive", "guessing", "gameOver"]) {
    assert.equal(shouldAutoAdvance({
      phase, autoAdvanceAt: T - 100, isHost: true, now: T,
    }), false);
  }
});

test("shouldAutoAdvance: not while counting, not when held or lapsed", () => {
  const base = { phase: "reveal", isHost: true, now: T };
  assert.equal(shouldAutoAdvance({ ...base, autoAdvanceAt: T + 5_000 }), false);
  assert.equal(shouldAutoAdvance({ ...base, autoAdvanceAt: null }), false);
  assert.equal(shouldAutoAdvance({ ...base, autoAdvanceAt: T - 60_000 }), false);
});

/* ---------------- the final reveal lands on the scoreboard ---------------- */

test("advanceTarget: mid-game rounds advance to the next round", () => {
  assert.equal(advanceTarget(1, 5), "round");
  assert.equal(advanceTarget(4, 5), "round");
});

test("advanceTarget: the final reveal (and overshoot) lands on gameOver", () => {
  assert.equal(advanceTarget(5, 5), "gameOver");
  assert.equal(advanceTarget(6, 5), "gameOver"); // pool-skip overshoot
  assert.equal(advanceTarget(1, 1), "gameOver"); // one-round game
});

/* ---------------- countdown copy ---------------- */

test("advanceSecondsLeft: ceils and clamps at zero", () => {
  assert.equal(advanceSecondsLeft(15_000), 15);
  assert.equal(advanceSecondsLeft(14_001), 15);
  assert.equal(advanceSecondsLeft(400), 1);
  assert.equal(advanceSecondsLeft(0), 0);
  assert.equal(advanceSecondsLeft(-2_000), 0);
});

test("countdownText: counting copy names the destination", () => {
  const counting = { state: "counting", msLeft: 9_000 };
  assert.equal(countdownText(counting, "round"), "Next round in 9…");
  assert.equal(countdownText(counting, "gameOver"), "Final scores in 9…");
});

test("countdownText: due shows the starting beat, held/lapsed show nothing", () => {
  const due = { state: "due", msLeft: 0 };
  assert.equal(countdownText(due, "round"), "Starting the next round…");
  assert.equal(countdownText(due, "gameOver"), "Final scores…");
  assert.equal(countdownText({ state: "held", msLeft: 0 }, "round"), null);
  assert.equal(countdownText({ state: "lapsed", msLeft: 0 }, "round"), null);
});
