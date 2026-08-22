// modifier-ui.js — DOM glue for the pin-drop modifier callout (the guess
// modifier's one discoverability moment; docs/guess-modifier-design.md §4).
// Every decision — which modifier to tease, when, and once-per-game — lives
// upstream in modifier.js (pure, tested). This module only builds the transient
// pill, animates it, routes its tap, and pulses the chip. Pattern: hints-ui.js
// — thin, unit-untested, all decisions upstream.

import { prefersReducedMotion } from "./fx-ui.js";

let callout = null;
let calloutTimer = null;

// §4.1: an 8 s timeout dismisses the callout silently if it's ignored.
const CALLOUT_MS = 8000;

/* Show the pin-drop callout pill in the context-pill slot (z 600, above the
 * action bar, never over the primary button). `spec` is modifier.calloutSpec(id)
 * — { title, line }. `onTap` is the conversion path: it fires once when the
 * whole pill is tapped (the module dismisses first, then calls it — typically
 * to open the modifier's sheet). Any OTHER dismissal (a map tap, lock-in, a
 * round/phase change) is the caller invoking dismissModifierCallout() directly.
 * The pill is one 44px+ tap target — no ✕. */
export function showModifierCallout(spec, onTap) {
  dismissModifierCallout();
  if (!spec) return null;
  const reduce = prefersReducedMotion();
  callout = document.createElement("div");
  callout.className = "mod-callout" + (reduce ? "" : " animate-in");
  callout.setAttribute("role", "button");
  callout.setAttribute("tabindex", "0");
  // Static copy only — no team name, room code, or place name — so no
  // data-ph-mask is needed (docs/replay-mask-checklist.md).
  callout.setAttribute("aria-label", `${spec.title} ${spec.line}`);

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = spec.title;
  const line = document.createElement("div");
  line.className = "line";
  line.textContent = spec.line;
  callout.append(title, line);

  const fire = () => {
    dismissModifierCallout();
    if (typeof onTap === "function") onTap();
  };
  callout.addEventListener("click", fire);
  callout.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fire(); }
  });

  document.body.appendChild(callout);
  calloutTimer = setTimeout(dismissModifierCallout, CALLOUT_MS);
  return callout;
}

// Remove the callout (idempotent). Under normal motion it exits with a short
// fade+drift; reduced motion removes it immediately. The module reference is
// cleared synchronously so a fresh show() never conflicts with a lingering
// exit animation.
export function dismissModifierCallout() {
  if (calloutTimer) { clearTimeout(calloutTimer); calloutTimer = null; }
  const el = callout;
  callout = null;
  if (!el) return;
  if (prefersReducedMotion()) { el.remove(); return; }
  el.classList.remove("animate-in");
  el.classList.add("animate-out");
  el.addEventListener("animationend", () => el.remove(), { once: true });
  // Safety net if animationend never fires (element detached mid-animation).
  setTimeout(() => el.remove(), 250);
}

// The chip's ONE soft pulse tying the pill to its permanent home (§4.3), so the
// player learns where the power lives after the pill is gone. Reduced motion →
// no-op (the callout itself already collapsed to plain show/hide).
export function pulseModifierChip(btn) {
  if (!btn || prefersReducedMotion()) return;
  btn.classList.remove("mod-pulse");
  void btn.offsetWidth; // reflow so re-adding the class restarts the animation
  btn.classList.add("mod-pulse");
  btn.addEventListener(
    "animationend", () => btn.classList.remove("mod-pulse"), { once: true });
}
