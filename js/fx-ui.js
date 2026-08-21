// fx-ui.js — browser glue for the S4 sound + motion pass. All decisions
// (defaults, persistence, tick scheduling, timbres, motion math) live in
// fx.js (pure, tested); this module owns the effects only:
//   - a lazy Web Audio synth that plays fx.js's note specs,
//   - the autoplay-policy dance (audio starts only after a user gesture;
//     until then every play is a silent no-op, never an error),
//   - the persistent 🔊/🔇 corner toggle (per-surface default, saved choice),
//   - a short vibration on lock-in (where the hardware supports it),
//   - the transient "LOCKED IN" stamp overlay,
//   - the prefers-reduced-motion probe the JS-driven animations consult.
// Shared by host-ui.js, player-ui.js, screen-ui.js/screen-h2h.js, daily-ui.js.

import {
  getSoundEnabled,
  setSoundEnabled,
  soundSpec,
  soundToggleIcon,
  soundToggleTitle,
  confettiSpec,
} from "./fx.js";
import { track } from "./consent.js";

let surface = "player";
let enabled = false;
let ctx = null;
let toggleBtn = null;

/* ================================================================
 * Audio: lazy context + gesture unlock
 * ================================================================ */

function ensureCtx() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try { ctx = new AC(); } catch { ctx = null; }
  return ctx;
}

// Browsers keep an AudioContext suspended until a user gesture. This runs
// inside every pointer/key gesture (capture phase, so it precedes any
// stopPropagation) and nudges the context awake; once running it's a no-op.
function unlock() {
  if (!enabled) return;
  const c = ensureCtx();
  if (c && c.state === "suspended") c.resume().catch(() => { /* still locked */ });
}

// Play one named cue from fx.js's specs. Silent no-op when muted, when Web
// Audio is missing, or while the context is still gesture-locked (in which
// case it also nudges a resume so the NEXT cue lands).
export function playSound(name) {
  if (!enabled) return;
  const spec = soundSpec(name);
  if (!spec) return;
  const c = ensureCtx();
  if (!c) return;
  if (c.state !== "running") {
    c.resume().catch(() => { /* awaiting a user gesture */ });
    return;
  }
  const t0 = c.currentTime;
  for (const n of spec) {
    try {
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = n.type;
      osc.frequency.value = n.freq;
      // Fast attack, exponential decay to silence — clickless short cues.
      g.gain.setValueAtTime(0.0001, t0 + n.at);
      g.gain.exponentialRampToValueAtTime(n.gain, t0 + n.at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur);
      osc.connect(g).connect(c.destination);
      osc.start(t0 + n.at);
      osc.stop(t0 + n.at + n.dur + 0.05);
    } catch { /* a dying context must never break the game */ }
  }
}

/* ================================================================
 * The 🔊/🔇 toggle: injected like the consent gear, persists via fx.js
 * ================================================================ */

function renderToggle() {
  if (!toggleBtn) return;
  toggleBtn.textContent = soundToggleIcon(enabled);
  toggleBtn.title = soundToggleTitle(enabled);
  toggleBtn.setAttribute("aria-label", soundToggleTitle(enabled));
  toggleBtn.setAttribute("aria-pressed", String(enabled));
}

// Call once per page. `pageSurface`: "host" | "player" | "tv" | "daily" —
// the TV defaults to sound on, phones to muted (spec §2.4).
export function initSound(pageSurface) {
  surface = pageSurface;
  enabled = getSoundEnabled(window.localStorage, surface);
  toggleBtn = document.createElement("button");
  toggleBtn.id = "soundToggle";
  toggleBtn.className = "sound-toggle";
  toggleBtn.type = "button";
  renderToggle();
  toggleBtn.addEventListener("click", () => {
    enabled = !enabled;
    setSoundEnabled(window.localStorage, enabled);
    renderToggle();
    // The tap IS a gesture: unlock and confirm audibly so "on" is believable.
    if (enabled) { unlock(); playSound("tick"); }
    track("sound_toggled", { surface, enabled });
  });
  document.body.appendChild(toggleBtn);
  // Any first gesture (typing the room code on a TV counts) unlocks audio.
  window.addEventListener("pointerdown", unlock, { capture: true, passive: true });
  window.addEventListener("keydown", unlock, { capture: true, passive: true });
}

/* ================================================================
 * Haptics + the stamp flash
 * ================================================================ */

// A short buzz on lock-in. Independent of the sound toggle (it's tactile
// confirmation, not noise) and a silent no-op where unsupported (iOS).
export function buzz(pattern = 35) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch { /* not supported */ }
}

// Transient full-screen stamp ("LOCKED IN") for surfaces with no locked
// screen of their own (couch host, daily). Non-blocking: pointer-events
// none, self-removing, and reduced-motion collapses it via the CSS reset.
export function stampFlash(text) {
  const el = document.createElement("div");
  el.className = "stamp-flash";
  el.textContent = text;
  document.body.appendChild(el);
  const remove = () => el.remove();
  el.addEventListener("animationend", remove);
  setTimeout(remove, 1500); // fallback if the animation never fires
}

/* ================================================================
 * Reduced motion (for JS-driven animation durations; CSS has its own
 * media-query reset in style.css)
 * ================================================================ */

export function prefersReducedMotion() {
  try {
    return window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/* ================================================================
 * Confetti (#8): render fx.js's pure, deterministic strip specs into the
 * existing .confetti loop. `seed` keeps a game's burst stable; `tier`
 * ("champion" | "win") picks the richer gold-weighted set. Reduced motion
 * yields an empty spec (and the CSS hides .confetti anyway) — no strips.
 * ================================================================ */
export function spawnConfetti(wrap, { seed, tier, count, accentColor, spread } = {}) {
  if (!wrap) return 0;
  wrap.innerHTML = "";
  const bits = confettiSpec({
    count, seed, tier, accentColor, spread, reducedMotion: prefersReducedMotion(),
  });
  for (const b of bits) {
    const strip = document.createElement("i");
    strip.style.left = `${b.left}%`;
    strip.style.background = b.color;
    strip.style.width = `${(1.4 * b.sizeScale).toFixed(2)}vh`;
    strip.style.height = `${(2.8 * b.sizeScale).toFixed(2)}vh`;
    strip.style.animationDuration = `${b.durationS}s`;
    strip.style.animationDelay = `${b.delayS}s`;
    strip.style.setProperty("--drift", `${b.driftVw}vw`);
    strip.style.setProperty("--spin", `${b.spinDeg}deg`);
    wrap.appendChild(strip);
  }
  return bits.length;
}
