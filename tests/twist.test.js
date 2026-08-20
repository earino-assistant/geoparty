// Tests for js/twist.js — the Twist engine (G2, spec §3.2, §6.1). The draw is
// deterministic and never reads standings; eligibility follows the matrix;
// occasional lands ~35% of eligible rounds; the score helpers compose with the
// existing scorer and with SUPER SURE.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TWIST_SETTING_DEFAULT,
  BLITZ_SECONDS,
  BLITZ_MULTIPLIER,
  OCCASIONAL_P,
  normalizeTwistSetting,
  twistEligible,
  eligibleTwists,
  drawTwist,
  twistRoundSeconds,
  twistMoveAllowed,
  twistMultiplier,
  longHaulDistancePoints,
  twistHidesRivalPins,
  twistedRoundScore,
} from "../js/twist.js";
import { scoreForDistance } from "../js/game.js";
import { adjustedPoints } from "../js/supersure.js";

const H2H = {
  mode: "h2h", moveAllowed: true, difficulty: "world", numTeams: 3,
  poolScored: true, longHaulExhausted: false, roundCount: 5,
};

/* ---------------- determinism ---------------- */

test("drawTwist: same inputs → same twist across 500 rooms", () => {
  for (let i = 0; i < 500; i++) {
    const roomCode = `ROOM${i}`;
    for (let rn = 1; rn <= 5; rn++) {
      const opts = { ...H2H, roomCode, roundNumber: rn, twists: "chaos", isShowdown: rn === 5 };
      assert.equal(drawTwist(opts), drawTwist({ ...opts }));
    }
  }
});

test("drawTwist: never reads standings (signature has none) and never round 1 / showdown", () => {
  for (let i = 0; i < 200; i++) {
    const base = { ...H2H, roomCode: `RM${i}`, twists: "chaos" };
    assert.equal(drawTwist({ ...base, roundNumber: 1 }), null);         // round 1
    assert.equal(drawTwist({ ...base, roundNumber: 5, isShowdown: true }), null);  // showdown
  }
});

test("drawTwist: off never draws; chaos always draws when something is eligible", () => {
  for (let i = 0; i < 200; i++) {
    const base = { ...H2H, roomCode: `X${i}`, roundNumber: 3, isShowdown: false };
    assert.equal(drawTwist({ ...base, twists: "off" }), null);
    assert.ok(drawTwist({ ...base, twists: "chaos" }) !== null);
  }
});

/* ---------------- eligibility matrix ---------------- */

test("twistEligible: mode / moveAllowed / difficulty / teams gating", () => {
  // blind: h2h with >1 team only.
  assert.equal(twistEligible("blind", { ...H2H }), true);
  assert.equal(twistEligible("blind", { ...H2H, numTeams: 1 }), false);
  assert.equal(twistEligible("blind", { ...H2H, mode: "couch" }), false);
  // frozen: only when the room allows movement (can't freeze a frozen room).
  assert.equal(twistEligible("frozen", { ...H2H, moveAllowed: true }), true);
  assert.equal(twistEligible("frozen", { ...H2H, moveAllowed: false }), false);
  // longhaul: scored pool, not expert, not exhausted.
  assert.equal(twistEligible("longhaul", { ...H2H }), true);
  assert.equal(twistEligible("longhaul", { ...H2H, difficulty: "expert" }), false);
  assert.equal(twistEligible("longhaul", { ...H2H, poolScored: false }), false);
  assert.equal(twistEligible("longhaul", { ...H2H, longHaulExhausted: true }), false);
  // blitz: any supported mode.
  assert.equal(twistEligible("blitz", { ...H2H, mode: "couch" }), true);
  // couch excludes blind entirely.
  assert.deepEqual(
    eligibleTwists({ ...H2H, mode: "couch", roundNumber: 3, twists: "chaos", prevTwistId: null }).sort(),
    ["blitz", "frozen", "longhaul"]);
});

test("drawTwist: never repeats the previous round's twist", () => {
  for (let i = 0; i < 300; i++) {
    const opts = { ...H2H, roomCode: `P${i}`, roundNumber: 3, twists: "chaos", isShowdown: false, prevTwistId: "blitz" };
    assert.notEqual(drawTwist(opts), "blitz");
  }
});

/* ---------------- occasional frequency ---------------- */

test("occasional lands ~35% of eligible rounds (within tolerance)", () => {
  let twisted = 0;
  let total = 0;
  for (let i = 0; i < 4000; i++) {
    const t = drawTwist({ ...H2H, roomCode: `F${i}`, roundNumber: 3, twists: "occasional", isShowdown: false });
    total++;
    if (t) twisted++;
  }
  const rate = twisted / total;
  assert.ok(Math.abs(rate - OCCASIONAL_P) < 0.04, `rate ${rate}`);
});

/* ---------------- application helpers ---------------- */

test("twistRoundSeconds / twistMoveAllowed / twistMultiplier", () => {
  const settings = { roundSeconds: 60, moveAllowed: true };
  assert.equal(twistRoundSeconds(settings, "blitz"), BLITZ_SECONDS);
  assert.equal(twistRoundSeconds(settings, null), 60);
  assert.equal(twistRoundSeconds(settings, "frozen"), 60);
  assert.equal(twistMoveAllowed(settings, "frozen"), false);
  assert.equal(twistMoveAllowed(settings, null), true);
  assert.equal(twistMoveAllowed({ roundSeconds: 60, moveAllowed: false }, null), false);
  assert.equal(twistMultiplier("blitz"), BLITZ_MULTIPLIER);
  assert.equal(twistMultiplier(null), 1);
  assert.equal(twistHidesRivalPins("blind"), true);
  assert.equal(twistHidesRivalPins("blitz"), false);
});

test("longHaulDistancePoints: halved distance, monotonic, 5000 cap", () => {
  assert.equal(longHaulDistancePoints(0), 5000);              // cap holds
  // A 2,000 km miss on Long Haul scores like a 1,000 km miss normally.
  assert.equal(longHaulDistancePoints(2000), scoreForDistance(1000));
  // Monotonic non-increasing in distance.
  let prev = Infinity;
  for (let km = 0; km <= 20000; km += 500) {
    const p = longHaulDistancePoints(km);
    assert.ok(p <= prev);
    assert.ok(p <= 5000 && p >= 0);
    prev = p;
  }
});

test("twistedRoundScore: null twist == plain scoring; blitz ×1.5; longhaul gentler", () => {
  const settings = { roundSeconds: 60, moveAllowed: true };
  const plain = twistedRoundScore(null, 800, 15000, settings);
  assert.equal(plain.distancePoints, scoreForDistance(800));
  // Blitz: 20s window and ×1.5 on the total.
  const blitz = twistedRoundScore("blitz", 800, 15000, settings);
  assert.equal(blitz.distancePoints, scoreForDistance(800));
  assert.equal(blitz.points, Math.round(BLITZ_MULTIPLIER * (blitz.distancePoints + blitz.timeBonus)));
  // Long Haul: gentler distance points, ×1 multiplier.
  const lh = twistedRoundScore("longhaul", 2000, 15000, settings);
  assert.equal(lh.distancePoints, scoreForDistance(1000));
  assert.equal(lh.points, lh.distancePoints + lh.timeBonus);
});

test("SUPER SURE doubles the TWISTED round total (a blitz+SS round can ×3)", () => {
  const settings = { roundSeconds: 60, moveAllowed: true };
  const blitz = twistedRoundScore("blitz", 50, 5000, settings);
  const result = { points: blitz.points, superSure: true, superSureOutcome: "won" };
  assert.equal(adjustedPoints(result), blitz.points * 2);
  // vs. the same round without the twist: the swing is strictly larger.
  const plain = twistedRoundScore(null, 50, 5000, settings);
  assert.ok(blitz.points * 2 > plain.points * 2);
});
