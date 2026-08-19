// Tests for js/hints.js — one-shot hint flags (M5), the hint copy rules,
// and the live "if you locked in now" estimate (M3).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HINT_PREFIX,
  hintSeen,
  claimHint,
  HINT_CARDS,
  guessMapHintLines,
  lockNowEstimate,
  lockNowLabel,
} from "../js/hints.js";
import { scoreForDistance, timeBonus, bonusWindowMs } from "../js/game.js";

// localStorage-shaped in-memory store.
function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
}

/* ---------------- one-shot flags ---------------- */

test("claimHint: true exactly once per device per hint id", () => {
  const s = memStorage();
  assert.equal(claimHint(s, "pano"), true);
  assert.equal(claimHint(s, "pano"), false);
  assert.equal(hintSeen(s, "pano"), true);
});

test("claimHint: hint ids are independent", () => {
  const s = memStorage();
  claimHint(s, "pano");
  assert.equal(hintSeen(s, "guessmap"), false);
  assert.equal(claimHint(s, "guessmap"), true);
});

test("claimHint: flags are namespaced in storage", () => {
  const s = memStorage();
  claimHint(s, "reveal");
  assert.equal(s.getItem(`${HINT_PREFIX}reveal`), "1");
});

test("claimHint: unreadable storage never shows (and never nags)", () => {
  // Private mode / blocked storage: a hint that can't be marked shown must
  // not reappear on every round, so broken storage reads as "seen".
  const throwing = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  };
  assert.equal(hintSeen(throwing, "pano"), true);
  assert.equal(claimHint(throwing, "pano"), false);
});

test("claimHint: unwritable storage doesn't show either", () => {
  const readOnly = {
    getItem: () => null,
    setItem() { throw new Error("quota"); },
  };
  assert.equal(claimHint(readOnly, "pano"), false);
});

/* ---------------- the copy ---------------- */

test("HINT_CARDS: every card has lines; showdown is the interstitial", () => {
  for (const [id, card] of Object.entries(HINT_CARDS)) {
    assert.ok(Array.isArray(card.lines) && card.lines.length > 0, id);
  }
  assert.equal(HINT_CARDS.showdown.center, true);
});

test("showdown card sells the shared spot, never a comeback (§1.6)", () => {
  // Owner decision: no "last chance to catch up" language anywhere. The
  // SUPER SURE pin owns stakes and comebacks.
  const text = [HINT_CARDS.showdown.title, ...HINT_CARDS.showdown.lines]
    .join(" ").toLowerCase();
  for (const banned of ["comeback", "catch up", "double", "last chance"]) {
    assert.ok(!text.includes(banned), `showdown copy contains "${banned}"`);
  }
  assert.ok(text.includes("everyone guesses the same spot"));
  assert.ok(text.includes("leader goes first"));
});

test("phonescreen card (S7): teaches the hold-it-up move for no-TV couch", () => {
  const text = [HINT_CARDS.phonescreen.title, ...HINT_CARDS.phonescreen.lines]
    .join(" ");
  assert.ok(/big screen/i.test(text));
  assert.ok(/hold/i.test(text));
  // A bottom sheet, not an interstitial — it must not cover the reveal map.
  assert.notEqual(HINT_CARDS.phonescreen.center, true);
});

test("guessMapHintLines: scoring line always; rivals line only in h2h", () => {
  const couch = guessMapHintLines("couch", false);
  const h2h = guessMapHintLines("h2h", false);
  assert.ok(couch[0].includes("Closer = more points"));
  assert.ok(!couch.some((l) => l.includes("Rivals")));
  assert.ok(h2h.some((l) => l.includes("Rivals can see your pin move")));
});

test("guessMapHintLines: SUPER SURE line only while the bet is unspent", () => {
  const withBet = guessMapHintLines("h2h", true);
  const spent = guessMapHintLines("h2h", false);
  assert.ok(withBet.some((l) => l.includes("SUPER SURE")));
  assert.ok(!spent.some((l) => l.includes("SUPER SURE")));
});

/* ---------------- lock-now estimate ---------------- */

test("lockNowEstimate: exactly the real scorer's arithmetic", () => {
  for (const [km, elapsedMs, secs] of [
    [0, 5_000, 120], [812.3, 23_000, 120], [4000, 90_000, 60], [12, 4_000, 0],
  ]) {
    const est = lockNowEstimate(km, elapsedMs, secs);
    const dp = scoreForDistance(km);
    const bonus = timeBonus(dp, elapsedMs, bonusWindowMs(secs));
    assert.equal(est.distancePoints, dp);
    assert.equal(est.bonus, bonus);
    assert.equal(est.points, dp + bonus);
  }
});

test("lockNowEstimate: the bonus decays as time passes", () => {
  const early = lockNowEstimate(50, 5_000, 120);
  const late = lockNowEstimate(50, 110_000, 120);
  const expired = lockNowEstimate(50, 120_000, 120);
  assert.equal(early.distancePoints, late.distancePoints);
  assert.ok(early.bonus > late.bonus);
  assert.equal(expired.bonus, 0); // window over: distance only
});

test("lockNowEstimate: negative elapsed (clock skew) clamps to zero", () => {
  const est = lockNowEstimate(10, -5_000, 120);
  assert.equal(est.bonus, lockNowEstimate(10, 0, 120).bonus);
});

test("lockNowLabel: plain estimate, with the bolt only when bonus > 0", () => {
  const withBonus = lockNowLabel({ points: 5100, distancePoints: 4800, bonus: 300 }, false);
  assert.ok(withBonus.includes("+5,100"));
  assert.ok(withBonus.includes("⚡+300"));
  const noBonus = lockNowLabel({ points: 4800, distancePoints: 4800, bonus: 0 }, false);
  assert.ok(noBonus.includes("+4,800"));
  assert.ok(!noBonus.includes("⚡"));
});

test("lockNowLabel: an armed SUPER SURE shows the real stakes — ×2 or 0", () => {
  const label = lockNowLabel({ points: 3200, distancePoints: 3000, bonus: 200 }, true);
  assert.ok(label.includes("+6,400"), "doubled total");
  assert.ok(label.includes("or 0"), "and the downside");
});
