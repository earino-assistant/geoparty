// fx.js — pure logic for the S4 sound + motion pass (design review §2.4).
// Everything decidable without a browser lives here: the per-surface sound
// default and its persistence, the countdown tick scheduler, the synthesized
// sound specs (timbres as data), and the reduced-motion duration/easing math
// the JS-driven animations share. No DOM, no Web Audio — the browser glue
// (AudioContext, the toggle button, vibration) lives in fx-ui.js.

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
});

export function soundSpec(name) {
  return SOUND_SPECS[name] || null;
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
