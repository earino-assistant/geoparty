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
  confettiSpec,
  CONFETTI_COLORS,
  CONFETTI_GOLD,
  CONFETTI_TV_COUNT,
  CONFETTI_MAX,
  WIN_LINES,
  winLine,
  celebrationSpec,
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

/* ---------------- #8 confetti ---------------- */

test("confettiSpec: deterministic — same inputs, identical output", () => {
  const a = confettiSpec({ seed: "ROOMAB:t1", tier: "win" });
  const b = confettiSpec({ seed: "ROOMAB:t1", tier: "win" });
  assert.deepEqual(a, b);
  // A numeric seed is accepted too, and is stable.
  assert.deepEqual(confettiSpec({ seed: 42, tier: "win" }),
    confettiSpec({ seed: 42, tier: "win" }));
});

test("confettiSpec: different seeds give different bursts", () => {
  const a = confettiSpec({ seed: "AAA", tier: "win" });
  const b = confettiSpec({ seed: "BBB", tier: "win" });
  assert.notDeepEqual(a, b);
});

test("confettiSpec: reduced motion yields NO confetti", () => {
  assert.deepEqual(confettiSpec({ seed: "X", tier: "champion", reducedMotion: true }), []);
  assert.deepEqual(confettiSpec({ seed: "X", tier: "win", reducedMotion: true }), []);
});

test("confettiSpec: every strip is within bounds", () => {
  for (const tier of ["win", "champion"]) {
    for (const b of confettiSpec({ seed: `seed-${tier}`, tier })) {
      assert.ok(b.left >= 0 && b.left <= 100, "left");
      assert.ok(b.durationS > 0, "durationS positive");
      assert.ok(b.delayS >= 0, "delayS non-negative");
      assert.ok(b.sizeScale > 0, "sizeScale positive");
      assert.ok(b.spinDeg >= 360, "spinDeg at least one turn");
      assert.ok(Number.isFinite(b.driftVw), "driftVw finite");
    }
  }
});

test("confettiSpec: each tier draws only from its own palette", () => {
  for (const b of confettiSpec({ seed: "win-seed", tier: "win" })) {
    assert.ok(CONFETTI_COLORS.includes(b.color), b.color);
  }
  for (const b of confettiSpec({ seed: "champ-seed", tier: "champion" })) {
    assert.ok(CONFETTI_GOLD.includes(b.color), b.color);
  }
});

test("confettiSpec: champion is visibly richer than an ordinary win", () => {
  const win = confettiSpec({ seed: "S", tier: "win", count: 90 });
  const champ = confettiSpec({ seed: "S", tier: "champion", count: 90 });
  assert.equal(win.length, 90, "win uses the given count");
  assert.ok(champ.length > win.length, "champion spawns more strips");
  // Gold-weighting: the champion burst leans on the front (gold) palette
  // entries far more than a uniform draw would.
  const goldFront = champ.filter((b) => b.color === CONFETTI_GOLD[0]).length;
  assert.ok(goldFront > champ.length / CONFETTI_GOLD.length,
    "champion over-samples the gold end of the palette");
});

test("confettiSpec: the default count is the sparse TV loop, capped", () => {
  assert.equal(confettiSpec({ seed: "d", tier: "win" }).length, CONFETTI_TV_COUNT);
  assert.ok(confettiSpec({ seed: "d", tier: "champion", count: 1000 }).length
    <= CONFETTI_MAX, "an absurd count is capped so the loop stays cheap");
});

/* ---------------- "Your Color Takes the Room" ---------------- */

test("confettiSpec: omitting accentColor/spread reproduces the pre-existing baseline", () => {
  const base = confettiSpec({ seed: "R:1", tier: "win", count: 40 });
  const explicit = confettiSpec({
    seed: "R:1", tier: "win", count: 40, accentColor: undefined, spread: undefined,
  });
  assert.deepEqual(explicit, base);
  assert.deepEqual(
    confettiSpec({ seed: "R:1", tier: "champion", count: 40 }),
    confettiSpec({ seed: "R:1", tier: "champion", count: 40, accentColor: null }));
});

test("confettiSpec: accentColor weights roughly 40% of an ordinary win's strips", () => {
  const bits = confettiSpec({
    seed: "accent-seed", tier: "win", count: 160, accentColor: "#123456",
  });
  const accented = bits.filter((b) => b.color === "#123456").length;
  const frac = accented / bits.length;
  assert.ok(frac > 0.3 && frac < 0.5, `accent fraction was ${frac}`);
});

test("confettiSpec: champion tier ignores accentColor — always CONFETTI_GOLD", () => {
  const bits = confettiSpec({
    seed: "champ-accent", tier: "champion", count: 100, accentColor: "#123456",
  });
  for (const b of bits) assert.ok(CONFETTI_GOLD.includes(b.color), b.color);
});

test("confettiSpec: spread='burst' compresses duration/delay only", () => {
  const rain = confettiSpec({ seed: "S", tier: "win", count: 80 });
  const burst = confettiSpec({ seed: "S", tier: "win", count: 80, spread: "burst" });
  const maxOf = (arr, k) => Math.max(...arr.map((b) => b[k]));
  assert.ok(maxOf(burst, "durationS") < maxOf(rain, "durationS"));
  assert.ok(maxOf(burst, "delayS") < maxOf(rain, "delayS"));
  for (let i = 0; i < rain.length; i++) {
    assert.equal(burst[i].left, rain[i].left, "left untouched");
    assert.equal(burst[i].color, rain[i].color, "color untouched");
    assert.equal(burst[i].driftVw, rain[i].driftVw, "driftVw untouched");
    assert.equal(burst[i].spinDeg, rain[i].spinDeg, "spinDeg untouched");
    assert.equal(burst[i].sizeScale, rain[i].sizeScale, "sizeScale untouched");
  }
});

test("confettiSpec: bounds hold with accentColor + burst spread together", () => {
  const bits = confettiSpec({
    seed: "bounds", tier: "win", accentColor: "#fff", spread: "burst",
  });
  for (const b of bits) {
    assert.ok(b.left >= 0 && b.left <= 100, "left");
    assert.ok(b.durationS > 0, "durationS positive");
    assert.ok(b.delayS >= 0, "delayS non-negative");
  }
  assert.deepEqual(confettiSpec({
    seed: "bounds", tier: "win", accentColor: "#fff", spread: "burst", reducedMotion: true,
  }), []);
});

test("SOUND_SPECS.championFanfare: longer and higher than the ordinary fanfare", () => {
  const totalDur = (notes) => Math.max(...notes.map((n) => n.at + n.dur));
  const peakFreq = (notes) => Math.max(...notes.map((n) => n.freq));
  assert.ok(totalDur(SOUND_SPECS.championFanfare) > totalDur(SOUND_SPECS.fanfare),
    "championFanfare rings longer");
  assert.ok(peakFreq(SOUND_SPECS.championFanfare) > peakFreq(SOUND_SPECS.fanfare),
    "championFanfare climbs higher");
});

test("winLine: deterministic for a given seed + subject", () => {
  assert.equal(winLine("room:1", "Team Blue"), winLine("room:1", "Team Blue"));
});

test("winLine: always contains the subject", () => {
  for (let i = 0; i < 30; i++) {
    assert.ok(winLine(`seed-${i}`, "Team Blue").includes("Team Blue"), `seed-${i}`);
  }
});

test("winLine: covers all five lines across enough seeds", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const text = winLine(`s${i}`, "X");
    for (const line of WIN_LINES) if (text.includes(line)) seen.add(line);
  }
  assert.equal(seen.size, WIN_LINES.length);
});

test("celebrationSpec: won:false (or missing) yields null", () => {
  assert.equal(celebrationSpec({ won: false }), null);
  assert.equal(celebrationSpec(), null);
});

test("celebrationSpec: champion win — gold, no accent, championFanfare", () => {
  const spec = celebrationSpec({
    won: true, champion: true, teamColor: "#4dd6ff", seed: "s", surface: "phone",
  });
  assert.equal(spec.tier, "champion");
  assert.equal(spec.winVar, "gold");
  assert.equal(spec.accentColor, null);
  assert.equal(spec.sound, "championFanfare");
});

test("celebrationSpec: ordinary win with a team color — teamColor/accent/fanfare", () => {
  const spec = celebrationSpec({
    won: true, champion: false, teamColor: "#4dd6ff", seed: "s", surface: "phone",
  });
  assert.equal(spec.tier, "win");
  assert.equal(spec.winVar, "#4dd6ff");
  assert.equal(spec.accentColor, "#4dd6ff");
  assert.equal(spec.sound, "fanfare");
});

test("celebrationSpec: no team color falls back to var(--accent), no accent color", () => {
  const spec = celebrationSpec({
    won: true, champion: false, teamColor: null, seed: "s", surface: "daily",
  });
  assert.equal(spec.winVar, "var(--accent)");
  assert.equal(spec.accentColor, null);
});

test("celebrationSpec: tv gets 'rain'/no fixed count; every other surface gets 'burst'/70", () => {
  const tv = celebrationSpec({
    won: true, champion: false, teamColor: "#fff", seed: "s", surface: "tv",
  });
  assert.equal(tv.spread, "rain");
  assert.equal(tv.count, undefined);
  const phone = celebrationSpec({
    won: true, champion: false, teamColor: "#fff", seed: "s", surface: "phone",
  });
  assert.equal(phone.spread, "burst");
  assert.equal(phone.count, 70);
  const daily = celebrationSpec({
    won: true, champion: false, teamColor: null, seed: "s", surface: "daily",
  });
  assert.equal(daily.spread, "burst");
  assert.equal(daily.count, 70);
});
