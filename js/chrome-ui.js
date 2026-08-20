// chrome-ui.js — the browser half of the §4.1 layer rules. Every page's
// showScreen() reports the phase screen it just made visible; this module
// stamps `data-play` on <body> (CSS hides the utility corners while it is
// "1") and notifies subscribers — today just consent.js, which uses it to
// hold the first-run banner until a calm moment (§6.5).
//
// All decisions live in chrome.js (pure, tested); this file owns nothing
// but the attribute and the listener set.

import { utilitiesVisible } from "./chrome.js";

let current = null;
const listeners = new Set();

export function currentScreen() {
  return current;
}

function applyChrome() {
  const body = document.body;
  if (!body) return;
  body.dataset.play = utilitiesVisible(current) ? "0" : "1";
  // Also published so CSS can special-case a screen that has no action bar
  // (the joiner's home panel), which the corner utilities dodge by default.
  if (current) body.dataset.screen = current; else delete body.dataset.screen;
}

// Called from every page module's showScreen(). Idempotent: a re-render
// that shows the same screen again does no work and fires no listener.
export function setActiveScreen(screenId) {
  const id = screenId || null;
  if (id === current) return;
  current = id;
  applyChrome();
  for (const fn of listeners) {
    try { fn(id); } catch (e) { console.warn("chrome listener failed", e); }
  }
}

// Subscribe to screen changes; returns an unsubscribe function.
export function onScreenChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

applyChrome(); // calm until a page says otherwise
