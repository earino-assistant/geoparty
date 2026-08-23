// Tests for js/hints.js — one-shot hint flags (M5), the hint copy rules,
// and the live "if you locked in now" estimate (M3).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HINT_PREFIX,
  hintSeen,
  claimHint,
  HINT_CARDS,
  LOCK_LABELS,
  guessMapHintLines,
  lockNowEstimate,
  lockButtonLabel,
  panoHintCard,
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
  const couch = guessMapHintLines("couch");
  const h2h = guessMapHintLines("h2h");
  assert.ok(couch[0].includes("Closer = more points"));
  assert.ok(!couch.some((l) => l.includes("Rivals")));
  assert.ok(h2h.some((l) => l.includes("Rivals see your pin move")));
});

test("guessMapHintLines: the guess-map card never explains SUPER SURE", () => {
  // De-clutter §5/§6.1: each rule is explained in exactly one place, and
  // SUPER SURE's place is its own sheet. The card used to carry a third
  // line while a pill, a button label and a toast said the same thing.
  for (const mode of ["h2h", "couch", "daily"]) {
    const text = guessMapHintLines(mode).join(" ");
    assert.ok(!/SUPER SURE/i.test(text), mode);
    assert.ok(!/double or nothing/i.test(text), mode);
  }
  // Extra arguments (the old superSureAvailable flag) can never revive it.
  assert.deepEqual(guessMapHintLines("h2h", true), guessMapHintLines("h2h"));
});

test("guessMapHintLines: at most two lines — a card, not a manual", () => {
  for (const mode of ["h2h", "couch", "daily"]) {
    assert.ok(guessMapHintLines(mode).length <= 2, mode);
  }
});

// The one place SUPER SURE is explained moved to js/modifier.js
// (MODIFIER_SHEETS.super); its byte-for-byte-preserved copy is asserted in
// tests/modifier.test.js. hints.js no longer owns any modifier rule copy.

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

/* ---------------- the primary button's label (§6.1) ---------------- */

test("lockButtonLabel: the estimate rides on the button as a sublabel", () => {
  const parts = lockButtonLabel(
    LOCK_LABELS.h2h, { points: 3240, distancePoints: 3100, bonus: 140 }, false);
  assert.equal(parts.main, "Lock it in");
  assert.equal(parts.sub, "≈ +3,240");
  // §6's verbatim one-liner survives as the accessible label.
  assert.equal(parts.text, "Lock it in · ≈ +3,240");
});

test("lockButtonLabel: each surface keeps its own verb", () => {
  const est = { points: 5100, distancePoints: 4800, bonus: 300 };
  assert.equal(lockButtonLabel(LOCK_LABELS.couch, est, false).main, "Lock it in");
  assert.equal(lockButtonLabel(LOCK_LABELS.daily, est, false).main, "Lock it in");
});

test("lockButtonLabel: no pin yet — the map-gate text (P0.2), no stray separator", () => {
  const parts = lockButtonLabel(LOCK_LABELS.h2h, null, false);
  assert.equal(parts.main, "Tap the map to drop your pin");
  assert.equal(parts.sub, "");
  assert.equal(parts.text, "Tap the map to drop your pin");
  assert.ok(!parts.text.includes("≈"));
});

test("lockButtonLabel: an armed SUPER SURE shows the real stakes — ×2 or 0", () => {
  const parts = lockButtonLabel(
    LOCK_LABELS.h2h, { points: 3200, distancePoints: 3000, bonus: 200 }, true);
  assert.equal(parts.text, "🔥 Lock it in ×2 — or 0"); // §6.1, verbatim
  assert.equal(parts.main, "🔥 Lock it in ×2");
  assert.equal(parts.sub, "or 0");
  // The armed label must not also quote a single-value estimate: the whole
  // point is that the number on screen is the bet's number.
  assert.ok(!parts.text.includes("3,200"));
});

test("lockButtonLabel: armed with no pin still reads as the bet (gate text yields to the bet)", () => {
  assert.equal(lockButtonLabel(LOCK_LABELS.couch, null, true).text,
    "🔥 Lock it in ×2 — or 0");
});

test("lockButtonLabel: defaults to the h2h verbs when none are given", () => {
  assert.equal(lockButtonLabel(null, { points: 10 }, false).main, "Lock it in");
});

test("lockButtonLabel: no pin yet shows the map-gate text regardless of surface", () => {
  assert.equal(lockButtonLabel(LOCK_LABELS.couch, null, false).main,
    "Tap the map to drop your pin");
});

test("lockButtonLabel: the label never restates the SUPER SURE rule", () => {
  // §5: each rule is explained in exactly one place, and that place is the
  // sheet. The button shows stakes, not instructions.
  const armed = lockButtonLabel(LOCK_LABELS.h2h, { points: 100 }, true).text;
  assert.ok(!/once per game/i.test(armed));
  assert.ok(!/double or nothing/i.test(armed));
});

test("lockButtonLabel: thousands separators, so 3,240 never reads as 3240", () => {
  const parts = lockButtonLabel(LOCK_LABELS.h2h, { points: 12345 }, false);
  assert.equal(parts.sub, `≈ +${(12345).toLocaleString()}`);
});

/* ---------------- #7 movement-aware pano hint ---------------- */

test("panoHintCard: movement-allowed copy points at the arrows, two lines", () => {
  const moving = panoHintCard(true);
  assert.equal(moving.lines.length, 2, "stays within the two-line budget");
  assert.match(moving.lines.join(" "), /arrow/i, "teaches the movie/movement arrows");
  assert.match(moving.lines.join(" "), /Guess on the map/);
});

test("panoHintCard(false) is the pre-#7 copy, byte-for-byte", () => {
  assert.deepEqual(panoHintCard(false).lines, [
    "Look around 👀 — figure out where you are.",
    "Then tap Guess on the map.",
  ]);
  // A no-movement round must not tell the player to walk the street.
  assert.ok(!/arrow|walk/i.test(panoHintCard(false).lines.join(" ")));
});

// The #7 SUPER SURE one-shot chip nudge (SUPER_SURE_HINT / shouldHintSuperSure)
// was deleted with the guess-modifier redesign: the pin-drop callout
// (js/modifier.js shouldCalloutModifier + calloutSpec, covered in
// tests/modifier.test.js) is now the single discoverability treatment for the
// whole modifier class. One teaching surface, not two.
