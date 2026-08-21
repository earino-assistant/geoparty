// fx.js — pure logic for the S4 sound + motion pass (design review §2.4).
// Everything decidable without a browser lives here: the per-surface sound
// default and its persistence, the countdown tick scheduler, the synthesized
// sound specs (timbres as data), and the reduced-motion duration/easing math
// the JS-driven animations share. No DOM, no Web Audio — the browser glue
// (AudioContext, the toggle button, vibration) lives in fx-ui.js.

import { hashSeed, mulberry32 } from "./pool.js";

/* ================================================================
 * Sound preference. Spec §2.4: muted by default on phones, ON by
 * default on the TV; an explicit choice persists either way.
 * ================================================================ */

export const SOUND_LS_KEY = "geoparty_sound";

// Surfaces: "tv" is the only one that defaults to sound on — a TV at a
// party is expected to make noise; a phone in a pocket is not.
export function soundDefault(surface) {
  return surface === "tv";
}

// storage is localStorage-shaped ({getItem,setItem}). Anything but the two
// exact stored values (missing, tampered, unreadable) reads as "no choice",
// which falls back to the surface default.
export function getSoundEnabled(storage, surface) {
  let raw = null;
  try { raw = storage.getItem(SOUND_LS_KEY); } catch { /* private mode */ }
  if (raw === "on") return true;
  if (raw === "off") return false;
  return soundDefault(surface);
}

export function setSoundEnabled(storage, enabled) {
  try { storage.setItem(SOUND_LS_KEY, enabled ? "on" : "off"); }
  catch { /* private mode: the choice just doesn't persist */ }
}

export function soundToggleIcon(enabled) {
  return enabled ? "\u{1F50A}" : "\u{1F507}"; // 🔊 / 🔇
}

export function soundToggleTitle(enabled) {
  return enabled ? "Sound on — tap to mute" : "Sound off — tap to unmute";
}

/* ================================================================
 * Countdown tick scheduler. The tickers poll every 250 ms; this decides
 * which whole seconds get a tick so a second never ticks twice and a
 * lagged tick loop (background tab) never bursts to catch up.
 * ================================================================ */

export const TICK_WINDOW_S = 10; // ticks begin in the final 10 seconds
export const TICK_URGENT_S = 3;  // ...and sharpen for the final 3

// lastTicked is the second most recently ticked (null/undefined at round
// start). Returns { second, urgent } when a tick is due at msLeft, else
// null. A skipped second (timer jumped 9 → 7) yields ONE tick, not two.
export function countdownTick(lastTicked, msLeft, windowS = TICK_WINDOW_S) {
  if (typeof msLeft !== "number" || !Number.isFinite(msLeft) || msLeft <= 0) {
    return null;
  }
  const second = Math.ceil(msLeft / 1000);
  if (second > windowS) return null;
  if (lastTicked != null && second >= lastTicked) return null;
  return { second, urgent: second <= TICK_URGENT_S };
}

/* ================================================================
 * Sound specs — synthesized timbres as data (no binary assets, no
 * licensing). Each spec is a list of oscillator notes:
 *   at   seconds after trigger the note starts
 *   freq oscillator frequency in Hz
 *   dur  note length in seconds (short: these are cues, not music)
 *   gain peak gain (capped ≤ MAX_GAIN — a polish pass, not a distraction)
 *   type oscillator waveform
 * fx-ui.js plays a spec verbatim; tests guard the invariants.
 * ================================================================ */

export const MAX_GAIN = 0.4;
export const OSC_TYPES = Object.freeze(["sine", "square", "triangle", "sawtooth"]);

export const SOUND_SPECS = Object.freeze({
  // The countdown tick: a soft woodblock-ish blip once per second.
  tick: Object.freeze([
    Object.freeze({ at: 0, freq: 1100, dur: 0.05, gain: 0.08, type: "square" }),
  ]),
  // The final-3-seconds tick: brighter and a touch louder.
  tickUrgent: Object.freeze([
    Object.freeze({ at: 0, freq: 1560, dur: 0.06, gain: 0.12, type: "square" }),
  ]),
  // The lock-in stamp: a short low thump — felt more than heard.
  stamp: Object.freeze([
    Object.freeze({ at: 0, freq: 220, dur: 0.08, gain: 0.22, type: "triangle" }),
    Object.freeze({ at: 0.02, freq: 110, dur: 0.14, gain: 0.28, type: "sine" }),
  ]),
  // The reveal sting: a bright ascending major arpeggio (A–C#–E), the
  // last note ringing — the "Yakutsk!!!" beat.
  sting: Object.freeze([
    Object.freeze({ at: 0, freq: 440, dur: 0.16, gain: 0.16, type: "triangle" }),
    Object.freeze({ at: 0.09, freq: 554.37, dur: 0.16, gain: 0.16, type: "triangle" }),
    Object.freeze({ at: 0.18, freq: 659.25, dur: 0.5, gain: 0.2, type: "triangle" }),
    Object.freeze({ at: 0.18, freq: 1318.5, dur: 0.4, gain: 0.06, type: "sine" }),
  ]),
  // Game over: a four-note fanfare (C–E–G–C) under the podium/confetti.
  fanfare: Object.freeze([
    Object.freeze({ at: 0, freq: 523.25, dur: 0.14, gain: 0.16, type: "triangle" }),
    Object.freeze({ at: 0.12, freq: 659.25, dur: 0.14, gain: 0.16, type: "triangle" }),
    Object.freeze({ at: 0.24, freq: 783.99, dur: 0.14, gain: 0.16, type: "triangle" }),
    Object.freeze({ at: 0.36, freq: 1046.5, dur: 0.55, gain: 0.2, type: "triangle" }),
    Object.freeze({ at: 0.36, freq: 523.25, dur: 0.55, gain: 0.1, type: "sine" }),
  ]),
  // The champion fanfare: a Crown Night win goes bigger than an ordinary
  // game-over — a ringing C5-C6-E6 triad, a C7 shimmer riding the ring, and
  // a low C5 bass landing after (longer and higher than `fanfare`).
  championFanfare: Object.freeze([
    Object.freeze({ at: 0, freq: 523.25, dur: 0.14, gain: 0.16, type: "triangle" }),
    Object.freeze({ at: 0.12, freq: 1046.5, dur: 0.14, gain: 0.16, type: "triangle" }),
    Object.freeze({ at: 0.24, freq: 1318.51, dur: 0.5, gain: 0.2, type: "triangle" }),
    Object.freeze({ at: 0.24, freq: 2093, dur: 0.4, gain: 0.08, type: "sine" }),
    Object.freeze({ at: 0.7, freq: 523.25, dur: 0.5, gain: 0.12, type: "sine" }),
  ]),
});

export function soundSpec(name) {
  return SOUND_SPECS[name] || null;
}

/* ================================================================
 * "Your Color Takes the Room" win celebration — the headline copy. Five
 * plural-verb lines (a team name reads as a plural subject: "Team Awesome
 * take the room") plus one that already names the room. A seeded pick
 * keeps a given game's headline stable across re-renders without needing
 * Math.random. Champion nights get their own fixed "🏆 You won!" headline
 * instead (celebrationSpec below) — winLine is only ever the ordinary-win
 * copy.
 * ================================================================ */

export const WIN_LINES = Object.freeze([
  "take the room",
  "run the table",
  "The room belongs to",
  "own the map",
  "that's the game",
]);

export function winLine(seed, subject) {
  const idx = hashSeed(String(seed == null ? "" : seed)) % WIN_LINES.length;
  const line = WIN_LINES[idx];
  if (idx === 2) return `${line} ${subject}`;      // "The room belongs to X"
  if (idx === 4) return `${subject} — ${line}`;    // "X — that's the game"
  return `${subject} ${line}`;                     // "X take the room" etc.
}

/* ================================================================
 * Motion math shared by the JS-driven animations (reveal line draws,
 * the TV score count-up). CSS animations respect prefers-reduced-motion
 * via the media query in style.css; these two keep the JS side honest.
 * ================================================================ */

// A base duration collapses to 0 under reduced motion — the draw/count
// loops then complete on their first frame (everything lands instantly).
export function motionDuration(baseMs, reducedMotion) {
  return reducedMotion ? 0 : baseMs;
}

// Cubic ease-out fraction for elapsed/duration, clamped to [0, 1].
// A non-positive duration reads as "already done" (never NaN from 0/0).
export function animFraction(elapsedMs, durationMs) {
  if (!(durationMs > 0)) return 1;
  const f = Math.min(1, Math.max(0, elapsedMs / durationMs));
  return 1 - Math.pow(1 - f, 3);
}

/* ================================================================
 * Confetti (overnight bundle #8). The TV game-over confetti was a fixed 90
 * strips on a 137.5°-modulo layout with no sway and one linear fall — it read
 * flat. confettiSpec is a PURE, deterministic generator (seeded, no
 * Math.random) that fx-ui.js renders into the existing .confetti loop: varied
 * per-strip fall duration/delay, a horizontal drift (sway) and a randomized
 * spin, so the loop stays conservative and sparse but no longer marches in
 * lockstep. A champion (Crown Night first-to-3) gets a visibly richer,
 * gold-weighted burst; an ordinary win gets the colorful palette. Reduced
 * motion yields NO confetti at all. Tested in tests/fx.test.js.
 * ================================================================ */

// The colorful ordinary-win palette (unchanged hues) and the champion's
// gold-weighted set. Both frozen so the render layer can't mutate them.
export const CONFETTI_COLORS = Object.freeze(
  ["#ffcf3f", "#4dd6ff", "#ff6ec7", "#7dff8a", "#f4f4f6"]);
export const CONFETTI_GOLD = Object.freeze(
  ["#ffd700", "#ffcf3f", "#ffe89a", "#f6b73c", "#fff4c2"]);

export const CONFETTI_TV_COUNT = 90;   // the sparse-but-full TV loop default
export const CONFETTI_MAX = 160;       // hard cap (champion, still cheap)

// "Your Color Takes the Room": an ordinary win weights ~40% of the strips to
// the winner's own team color instead of the fixed palette. Champion bursts
// ignore this — gold is the whole point of a Crown Night.
export const ACCENT_WEIGHT = 0.4;

function confettiSeedInt(seed) {
  if (typeof seed === "number" && Number.isFinite(seed)) return seed >>> 0;
  return hashSeed(String(seed == null ? "confetti" : seed));
}

// { count, seed, tier, reducedMotion, accentColor, spread } → an array of
// strip specs. Same inputs always yield the same array (deterministic for
// tests and for a stable loop per game). Each strip:
//   left      0..100  (% of width)
//   color     one of the tier's palette, or the accent color (see below)
//   durationS positive fall duration (s)
//   delayS    >= 0 start delay (s)
//   driftVw   horizontal sway at the bottom (vw, signed)
//   spinDeg   total rotation over the fall (deg, >= 360)
//   sizeScale > 0 strip-size multiplier
//
// accentColor: a CSS color string (the winner's team color). Reuses the
// existing rColor draw below ACCENT_WEIGHT instead of the palette pick — no
// new rand() call, so a caller that omits it gets a byte-identical baseline
// burst. Ignored for a champion tier (gold only).
// spread: "burst" compresses the duration/delay arithmetic only (a phone-
// sized confetti burst reads better tighter and faster than the TV's lazy
// "rain"); every other axis (drift/spin/size) is untouched.
export function confettiSpec({
  count, seed, tier, reducedMotion, accentColor, spread,
} = {}) {
  if (reducedMotion === true) return [];   // reduced motion → no confetti
  const champion = tier === "champion";
  const base = Number.isFinite(count) && count > 0
    ? Math.floor(count) : CONFETTI_TV_COUNT;
  const n = Math.min(CONFETTI_MAX, champion ? Math.round(base * 1.4) : base);
  const palette = champion ? CONFETTI_GOLD : CONFETTI_COLORS;
  const useAccent = !champion && typeof accentColor === "string" && !!accentColor;
  const burst = spread === "burst";
  const rand = mulberry32(confettiSeedInt(seed));
  const round1 = (x) => Math.round(x * 10) / 10;
  const round2 = (x) => Math.round(x * 100) / 100;
  const bits = [];
  for (let i = 0; i < n; i++) {
    const rColor = rand();
    const rLeft = rand();
    const rDur = rand();
    const rDelay = rand();
    const rDrift = rand();
    const rSpin = rand();
    const rSize = rand();
    // Champion biases toward the gold end of the palette (squared → front-loaded).
    const pick = champion ? rColor * rColor : rColor;
    const idx = Math.min(palette.length - 1, Math.floor(pick * palette.length));
    const color = useAccent && rColor < ACCENT_WEIGHT ? accentColor : palette[idx];
    bits.push({
      left: round1(rLeft * 100),
      color,
      durationS: round2((2.6 + rDur * (champion ? 2.6 : 3.4)) * (burst ? 0.55 : 1)),
      delayS: round2(rDelay * (champion ? 2.5 : 3.8) * (burst ? 0.4 : 1)),
      driftVw: round1((rDrift * 2 - 1) * (champion ? 10 : 7)),
      spinDeg: 360 + Math.floor(rSpin * 720),
      sizeScale: round2(champion ? 1.1 + rSize * 0.7 : 0.85 + rSize * 0.6),
    });
  }
  return bits;
}

/* ================================================================
 * celebrationSpec: the single decision point for "did this surface just
 * win, and what should that look like" — host-ui/player-ui/daily-ui all
 * render from the same shape instead of re-deriving it. null when there is
 * nothing to celebrate (a loss renders the plain game-over screen).
 * ================================================================ */

// { won, champion, teamColor, seed, surface } → null, or:
//   tier        "champion" | "win" — confettiSpec's palette selector
//   winVar      the --win custom property value (gold beats any team color)
//   accentColor confettiSpec's accent — null for a champion (gold only) or
//               a plain win with no team color to lean on
//   sound       the fx.js SOUND_SPECS name to play, once
//   seed        passed straight through (confetti + winLine share it)
//   spread      "rain" on the TV (the existing lazy loop), "burst" everywhere
//               else (phone-sized surfaces read better tight and fast)
//   count       70 off the TV; undefined on the TV (confettiSpec's own
//               sparse default)
export function celebrationSpec({ won, champion, teamColor, seed, surface } = {}) {
  if (!won) return null;
  const tv = surface === "tv";
  return {
    tier: champion ? "champion" : "win",
    winVar: champion ? "gold" : (teamColor || "var(--accent)"),
    accentColor: champion ? null : (teamColor || null),
    sound: champion ? "championFanfare" : "fanfare",
    seed,
    spread: tv ? "rain" : "burst",
    count: tv ? undefined : 70,
  };
}
