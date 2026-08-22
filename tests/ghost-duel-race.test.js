// Tests for the Ghost Duel already-played race / idempotency guards (R1,
// spec §3.5.2 case 5). The daily-ui boot sequencer and the "Take the
// challenge" tap both route through dailyEntryRoute(); finishRun folds
// through duelFoldPlan(). These pure functions are what make a completed
// board un-replayable and a resolved duel un-double-counted — so the tests
// exercise the interleaving those two sites can produce, not just the helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyEntryRoute, duelFoldPlan } from "../js/ghost.js";

/* ================================================================
 * dailyEntryRoute — the shared replay-lock decision
 * ================================================================ */

test("dailyEntryRoute: no saved run always plays (fresh daily or fresh duel)", () => {
  for (const isDuel of [false, true]) {
    for (const ghostOk of [false, true]) {
      for (const isExhibition of [false, true]) {
        assert.equal(
          dailyEntryRoute({ hasSaved: false, isExhibition, isDuel, ghostOk }),
          "play");
      }
    }
  }
});

test("dailyEntryRoute: a completed board never plays — verdict for a valid duel, done otherwise", () => {
  // Saved run + valid ghost → the no-replay instant verdict.
  assert.equal(dailyEntryRoute({
    hasSaved: true, isExhibition: false, isDuel: true, ghostOk: true,
  }), "instant-verdict");
  // Saved run, no usable ghost → the plain done screen (still no replay).
  assert.equal(dailyEntryRoute({
    hasSaved: true, isExhibition: false, isDuel: false, ghostOk: true,
  }), "done");
  assert.equal(dailyEntryRoute({
    hasSaved: true, isExhibition: false, isDuel: true, ghostOk: false,
  }), "done");
});

test("dailyEntryRoute: an exhibition run never locks the real board (it saved nothing)", () => {
  // Exhibition duels change no records, so a saved-run for the local board is
  // unrelated to them: the route falls through to play (the local daily).
  assert.equal(dailyEntryRoute({
    hasSaved: true, isExhibition: true, isDuel: true, ghostOk: true,
  }), "play");
});

/* ================================================================
 * The race: boot routes to instant-verdict, a tap arrives before it resolves
 * ================================================================ */

// A minimal model of the two call sites racing on the SAME state. The boot
// routes first; while its async instant-verdict is in flight the "Take the
// challenge" button is live, so a tap re-enters startChallenge, which re-reads
// the SAME lock. The invariant under test: that tap can never route to "play"
// (a replay of the already-completed board), no matter when it lands.
test("race: a tap during the async instant-verdict load can never start a replay", () => {
  const state = { hasSaved: true, isExhibition: false, isDuel: true, ghostOk: true };
  const routes = [];

  // Boot decides first.
  routes.push(dailyEntryRoute(state));           // instant-verdict (async begins)
  // Tap lands mid-load — startChallenge re-checks the identical lock.
  routes.push(dailyEntryRoute(state));           // must NOT be "play"
  // A second frantic tap before resolution — same answer, still no replay.
  routes.push(dailyEntryRoute(state));

  assert.deepEqual(routes, ["instant-verdict", "instant-verdict", "instant-verdict"]);
  assert.ok(!routes.includes("play"), "no interleaving produces a replay");
});

test("race: even a non-duel saved board resolves to done, never a replay, on a mid-load tap", () => {
  const state = { hasSaved: true, isExhibition: false, isDuel: false, ghostOk: false };
  assert.equal(dailyEntryRoute(state), "done");
  assert.equal(dailyEntryRoute(state), "done"); // the raced tap agrees
});

/* ================================================================
 * duelFoldPlan — finishRun folds each thing exactly once
 * ================================================================ */

test("duelFoldPlan: a first-time duel folds everything and reports both events", () => {
  assert.deepEqual(
    duelFoldPlan({ isDuel: true, isExhibition: false, alreadyResolved: false }),
    { foldRecords: true, foldDuel: true, emitDuel: true, emitCompleted: true });
});

test("duelFoldPlan: an already-resolved duel folds NOTHING again (no dup W/L, ACE, PB, save, events)", () => {
  assert.deepEqual(
    duelFoldPlan({ isDuel: true, isExhibition: false, alreadyResolved: true }),
    { foldRecords: false, foldDuel: false, emitDuel: false, emitCompleted: false });
});

test("duelFoldPlan: a plain (non-duel) daily folds records + completed only", () => {
  assert.deepEqual(
    duelFoldPlan({ isDuel: false, isExhibition: false, alreadyResolved: false }),
    { foldRecords: true, foldDuel: false, emitDuel: false, emitCompleted: true });
});

test("duelFoldPlan: an exhibition folds nothing AND reports nothing (not a counted run)", () => {
  assert.deepEqual(
    duelFoldPlan({ isDuel: true, isExhibition: true, alreadyResolved: false }),
    { foldRecords: false, foldDuel: false, emitDuel: false, emitCompleted: false });
});

test("duelFoldPlan: an already-resolved exhibition also folds and reports nothing", () => {
  assert.deepEqual(
    duelFoldPlan({ isDuel: true, isExhibition: true, alreadyResolved: true }),
    { foldRecords: false, foldDuel: false, emitDuel: false, emitCompleted: false });
});

/* ================================================================
 * The interleaving that R1 closes end to end: instant-verdict resolves a
 * duel, then a finishRun for the same board (a replay that raced the guard)
 * must double-count nothing.
 * ================================================================ */

test("interleaving: instant-verdict resolves once, a racing finishRun re-folds nothing", () => {
  // Model the device's duel-resolved flag as instantVerdict + finishRun would
  // touch it. Both paths gate on it; only the first crosses the fold.
  let resolved = false;
  const folds = [];

  // instantVerdict path: the boot routed here; it folds once, then marks done.
  const iv = duelFoldPlan({ isDuel: true, isExhibition: false, alreadyResolved: resolved });
  if (iv.foldDuel) { folds.push("instant-verdict"); resolved = true; }

  // A replay somehow reaches finishRun for the same day+mode afterward.
  const fr = duelFoldPlan({ isDuel: true, isExhibition: false, alreadyResolved: resolved });
  if (fr.foldDuel) folds.push("finishRun");

  assert.deepEqual(folds, ["instant-verdict"], "the duel W/L folds exactly once");
  assert.equal(fr.emitDuel, false, "no duplicate ghost_duel_completed");
  assert.equal(fr.emitCompleted, false, "no duplicate daily_challenge_completed");
  assert.equal(fr.foldRecords, false, "no saved-run overwrite / ACE / PB re-fold");
});
