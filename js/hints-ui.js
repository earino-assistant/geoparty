// hints-ui.js — DOM glue for the one-shot education overlays (M5). All the
// decision logic (once-per-device flags, the copy) is in hints.js (pure,
// tested); this module only builds and tears down the card. Shared by
// host-ui.js (couch) and player-ui.js (head-to-head).

import { claimHint, HINT_CARDS } from "./hints.js";

let card = null;
let scrim = null;

// Render a hint card. Bottom sheet by default (never blocks the pano/map
// underneath); `center: true` adds a scrim for interstitials (showdown).
// `actions` overrides the single "Got it" dismiss with named buttons — the
// SUPER SURE sheet's "Arm the bet" / "Not now" (review §6.1). Every action
// dismisses first: the §4.1 rule is at most ONE sheet on screen at a time,
// and showHintCard opening always evicts whatever was there before.
export function showHintCard({ title, lines, center, actions }) {
  dismissHintCard();
  if (center) {
    scrim = document.createElement("div");
    scrim.className = "hint-scrim";
    scrim.addEventListener("click", dismissHintCard);
    document.body.appendChild(scrim);
  }
  card = document.createElement("div");
  card.className = "hint-card" + (center ? " center" : "");
  card.setAttribute("role", "note");
  if (title) {
    const h = document.createElement("div");
    h.className = "hint-title";
    h.textContent = title;
    card.appendChild(h);
  }
  for (const line of lines || []) {
    const p = document.createElement("p");
    p.textContent = line;
    card.appendChild(p);
  }
  const row = document.createElement("div");
  row.className = "hint-actions";
  const specs = (actions && actions.length)
    ? actions
    : [{ label: "Got it", primary: true }];
  for (const a of specs) {
    const btn = document.createElement("button");
    btn.className = "hint-dismiss" + (a.primary === false ? "" : " btn-primary");
    btn.type = "button";
    btn.textContent = a.label;
    btn.addEventListener("click", () => {
      dismissHintCard();
      if (a.onClick) a.onClick();
    });
    row.appendChild(btn);
  }
  card.appendChild(row);
  document.body.appendChild(card);
}

export function dismissHintCard() {
  if (card) { card.remove(); card = null; }
  if (scrim) { scrim.remove(); scrim = null; }
}

// Is a hint/sheet currently on screen? The pin-drop modifier callout uses this
// to stay suppressed while a sheet is open (§4.1: one sheet at a time), and to
// leave itself un-marked-shown so it can fire on a later round's first pin.
export function hintCardOpen() {
  return !!card;
}

// The one call feature code makes: show hint `id` if this device has never
// seen it. `spec` overrides/extends the canned card (dynamic lines, e.g.
// the guess-map hint). Returns whether the card was shown.
export function oneShotHint(id, spec) {
  const def = spec || HINT_CARDS[id];
  if (!def || !claimHint(window.localStorage, id)) return false;
  showHintCard(def);
  return true;
}

/* Paint a two-line primary from hints.lockButtonLabel's parts. Shared by
 * the three guess screens so the markup (and the accessible one-line label
 * §6.1 specifies) is identical everywhere. */
export function paintLockButton(btn, parts) {
  if (!btn) return;
  btn.textContent = "";
  btn.setAttribute("aria-label", parts.text);
  const main = document.createElement("span");
  main.className = "btn-main";
  main.textContent = parts.main;
  btn.appendChild(main);
  if (parts.sub) {
    const sub = document.createElement("span");
    sub.className = "btn-sub";
    sub.textContent = parts.sub;
    btn.appendChild(sub);
  }
}
