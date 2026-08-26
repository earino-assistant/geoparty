// frontdoor.js — pure logic for the one front door (design review §1.3/§2.2,
// roadmap M1/M4). The landing never asks a player to pick a page: a room
// code routes itself to the right experience because the room already knows
// its mode, and the "Start a party" chooser names experiences ("Everyone on
// their own phone" / "One phone + the TV"), never pages. No DOM, no network
// in here — the browser glue lives in landing-ui.js.

// Where a device holding only a room code should go. h2h rooms are played
// on phones (the player page). A couch room's only joinable surface is the
// shared display: its lobby QR/URL has always pointed the TV at the screen
// page, so a couch code typed at the front door — most likely on the TV's
// own browser — lands there too. Unknown/missing modes default to the
// phones experience, which recovers gracefully from any mismatch.
export function joinTarget(mode) {
  return mode === "couch" ? "tv.html" : "player.html";
}

export function joinHref(mode, code) {
  return `${joinTarget(mode)}?room=${code}`;
}

// The "Start a party" chooser: experience key -> where that party begins.
// Keys double as the analytics `party_choice.choice` values ("phones" is
// the default, per §1.3). `create=1` tells the player page this visitor is
// starting a party, not joining one.
export const PARTY_CHOICES = Object.freeze({
  phones: "player.html?create=1",
  tv: "host.html",
});

// Mirror of the player page's code-input filter: uppercase, room-code
// alphabet only (6 letters, no I/O — see makeRoomCode in game.js).
export function cleanCodeInput(raw) {
  return String(raw || "")
    .toUpperCase()
    .replace(/[^A-HJ-NP-Z]/g, "")
    .slice(0, 6);
}

// Hero pano candidates for the landing backdrop — hand-picked, instantly
// evocative entries from data/location_pool.json (ids only; the landing
// never fetches the 3.4 MB pool). The landing tries them in sequence until
// one loads, same dead-image skip discipline as the host pages.
export const HERO_PANOS = Object.freeze([
  "1299337402014306", // Kyoto, Japan
  "918955426907939",  // Lisbon, Portugal
  "302640746058754",  // New York City, United States
  "614255973091089",  // Istanbul, Turkey
  "240337254632438",  // Bergen, Norway
  "582919534100192",  // Buenos Aires, Argentina
  "462227536160234",  // Prague, Czechia
  "112293428260798",  // San Francisco, United States
]);

// Rotate the candidate list to start at `startIndex` (any integer), so a
// random pick still falls back through every candidate exactly once.
export function heroSequence(list, startIndex) {
  const n = list.length;
  if (n === 0) return [];
  const s = ((Math.trunc(startIndex) % n) + n) % n;
  return [...list.slice(s), ...list.slice(0, s)];
}
