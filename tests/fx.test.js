// Tests for js/fx.js — the S4 sound + motion pure layer: per-surface sound
// defaults and persistence, the countdown tick scheduler, the synthesized
// sound specs' invariants, and the reduced-motion duration/easing math.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SOUND_LS_KEY,
  TICK_WINDOW_S,
  TICK_URGENT_S,
  MAX_GAIN,
  OSC_TYPES,
  SOUND_SPECS,
  soundDefault,
  getSoundEnabled,
  setSoundEnabled,
  soundToggleIcon,
  soundToggleTitle,
  countdownTick,
  soundSpec,
  motionDuration,
  animFraction,
} from "../js/fx.js";

// localStorage-shaped in-memory store (same double as analytics.test.js).
function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
}

/* ---------------- sound preference ---------------- */

test("soundDefault: ON only on the TV, muted on every phone surface", () => {
  assert.equal(soundDefault("tv"), true);
  for (const surface of ["player", "host", "daily", "phone", undefined]) {
    assert.equal(soundDefault(surface), false, String(surface));
  }
});

test("getSoundEnabled: no stored choice falls back to the surface default", () => {
  const s = memStorage();
  assert.equal(getSoundEnabled(s, "tv"), true);
  assert.equal(getSoundEnabled(s, "player"), false);
});

test("getSoundEnabled: an explicit choice overrides the default both ways", () => {
  const s = memStorage();
  setSoundEnabled(s, true);
  assert.equal(getSoundEnabled(s, "player"), true, "phone unmuted sticks");
  setSoundEnabled(s, false);
  assert.equal(getSoundEnabled(s, "tv"), false, "TV muted sticks");
});

test("getSoundEnabled: tampered values read as no-choice", () => {
  const s = memStorage();
  s.setItem(SOUND_LS_KEY, "LOUD");
  assert.equal(getSoundEnabled(s, "tv"), true);
  assert.equal(getSoundEnabled(s, "player"), false);
});

test("sound pref: throwing storage degrades to the default, never throws", () => {
  const broken = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  };
  assert.equal(getSoundEnabled(broken, "tv"), true);
  assert.equal(getSoundEnabled(broken, "player"), false);
  assert.doesNotThrow(() => setSoundEnabled(broken, true));
});

test("toggle icon/title track the enabled state", () => {
  assert.notEqual(soundToggleIcon(true), soundToggleIcon(false));
  assert.match(soundToggleTitle(true), /on/i);
  assert.match(soundToggleTitle(false), /off/i);
});

/* ---------------- countdown tick scheduler ---------------- */

test("countdownTick: silent outside the final window", () => {
  assert.equal(countdownTick(null, (TICK_WINDOW_S + 1) * 1000), null);
  assert.equal(countdownTick(null, 60_000), null);
});

test("countdownTick: first tick lands exactly at the window boundary", () => {
  const t = countdownTick(null, TICK_WINDOW_S * 1000);
  assert.deepEqual(t, { second: TICK_WINDOW_S, urgent: false });
});

test("countdownTick: a 250ms poll never ticks the same second twice", () => {
  let last = null;
  const ticked = [];
  // Simulate the real tickers: poll every 250 ms from 10.5 s down to 0.
  for (let ms = 10_500; ms > 0; ms -= 250) {
    const t = countdownTick(last, ms);
    if (t) { last = t.second; ticked.push(t.second); }
  }
  assert.deepEqual(ticked, [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
});

test("countdownTick: a lagged loop skips seconds without bursting", () => {
  // Background-tab throttling: the poll jumps 9s -> 6.2s. One tick, not three.
  const t = countdownTick(9, 6200);
  assert.deepEqual(t, { second: 7, urgent: false });
  assert.equal(countdownTick(7, 6200), null);
});

test("countdownTick: the final seconds are urgent", () => {
  for (let s = 1; s <= TICK_URGENT_S; s++) {
    const t = countdownTick(s + 1, s * 1000);
    assert.equal(t.urgent, true, `second ${s}`);
  }
  assert.equal(countdownTick(5, 4000).urgent, false);
});

test("countdownTick: no-limit rounds and expired clocks stay silent", () => {
  assert.equal(countdownTick(null, null), null);
  assert.equal(countdownTick(null, undefined), null);
  assert.equal(countdownTick(null, 0), null);
  assert.equal(countdownTick(null, -400), null);
  assert.equal(countdownTick(null, NaN), null);
});

test("countdownTick: a shorter window fits the reveal 3-2-1", () => {
  assert.equal(countdownTick(null, 4000, 3), null, "4s is outside a 3s window");
  assert.deepEqual(countdownTick(null, 3000, 3), { second: 3, urgent: true });
  assert.deepEqual(countdownTick(3, 1900, 3), { second: 2, urgent: true });
});

/* ---------------- sound specs ---------------- */

test("soundSpec: known cues resolve, unknown names are null", () => {
  for (const name of ["tick", "tickUrgent", "stamp", "sting", "fanfare"]) {
    assert.ok(Array.isArray(soundSpec(name)), name);
  }
  assert.equal(soundSpec("airhorn"), null);
  assert.equal(soundSpec(""), null);
});

test("sound specs: every note is well-formed, short, and subtle", () => {
  for (const [name, notes] of Object.entries(SOUND_SPECS)) {
    assert.ok(notes.length > 0, `${name} is empty`);
    for (const n of notes) {
      assert.ok(Number.isFinite(n.at) && n.at >= 0, `${name}.at`);
      assert.ok(n.at < 2, `${name} starts too late to be a cue`);
      assert.ok(Number.isFinite(n.freq) && n.freq > 0, `${name}.freq`);
      assert.ok(Number.isFinite(n.dur) && n.dur > 0 && n.dur <= 1,
        `${name}.dur must be a short cue`);
      assert.ok(Number.isFinite(n.gain) && n.gain > 0 && n.gain <= MAX_GAIN,
        `${name}.gain must stay subtle (≤ ${MAX_GAIN})`);
      assert.ok(OSC_TYPES.includes(n.type), `${name}.type`);
    }
  }
});

test("sound specs: ticks are quieter than the beats they punctuate", () => {
  const peak = (notes) => Math.max(...notes.map((n) => n.gain));
  assert.ok(peak(SOUND_SPECS.tick) < peak(SOUND_SPECS.stamp));
  assert.ok(peak(SOUND_SPECS.tickUrgent) < peak(SOUND_SPECS.sting));
});

/* ---------------- motion math ---------------- */

test("motionDuration: collapses to zero under reduced motion", () => {
  assert.equal(motionDuration(1000, true), 0);
  assert.equal(motionDuration(1000, false), 1000);
});

test("animFraction: zero/negative duration reads as already done", () => {
  assert.equal(animFraction(0, 0), 1);
  assert.equal(animFraction(0, -5), 1);
  assert.equal(animFraction(123, 0), 1);
});

test("animFraction: clamped, monotonic ease-out", () => {
  assert.equal(animFraction(-10, 1000), 0);
  assert.equal(animFraction(0, 1000), 0);
  assert.equal(animFraction(1000, 1000), 1);
  assert.equal(animFraction(5000, 1000), 1);
  let prev = 0;
  for (let ms = 100; ms <= 1000; ms += 100) {
    const f = animFraction(ms, 1000);
    assert.ok(f > prev, `monotonic at ${ms}`);
    prev = f;
  }
  // Ease-OUT: the first half covers more ground than the second.
  assert.ok(animFraction(500, 1000) > 0.5);
});
