// hints-ui.js — DOM glue for the one-shot education overlays (M5). All the
// decision logic (once-per-device flags, the copy) is in hints.js (pure,
// tested); this module only builds and tears down the card. Shared by
// host-ui.js (couch) and player-ui.js (head-to-head).

import { claimHint, HINT_CARDS } from "./hints.js";

let card = null;
let scrim = null;

// Render a hint card. Bottom sheet by default (never blocks the pano/map
// underneath); `center: true` adds a scrim for interstitials (showdown).
export function showHintCard({ title, lines, center }) {
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
  const btn = document.createElement("button");
  btn.className = "btn-primary hint-dismiss";
  btn.textContent = "Got it";
  btn.addEventListener("click", dismissHintCard);
  card.appendChild(btn);
  document.body.appendChild(card);
}

export function dismissHintCard() {
  if (card) { card.remove(); card = null; }
  if (scrim) { scrim.remove(); scrim = null; }
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
