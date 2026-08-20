// chrome.js — pure predicates for WHEN the app's non-game chrome is allowed
// on screen (docs/ui-ux-design-review.md §4.1 "one occupant per layer, per
// state" and §6.5 "the consent moment"). No DOM, no storage in here — the
// browser glue is chrome-ui.js, and consent.js consults these to decide the
// prompt MOMENT (never the prompt's substance: the opt-in gate is untouched,
// nothing loads or fires before an explicit accept).
//
// Two questions, both answerable from a screen id alone:
//   1. Is the player mid-play right now? (utilities hide; §4.1 utility row)
//   2. May the consent banner ask on this surface right now? (§6.5)

/* ================================================================
 * 1. Calm vs play
 * ================================================================ */

// The six phone screens where the game itself is the whole surface: a
// full-bleed panorama or the guess map, with a countdown running. During
// these the only chrome is the game — no 🍪, no 🔊 (§2.5, §2.6, §4.1).
// The TV's own screens are deliberately absent: §8 "the TV surface" is on
// the do-not-touch list, so its corner controls keep today's behavior.
export const PLAY_SCREENS = Object.freeze([
  "p-round", "p-guess",   // head-to-head phone
  "h-round", "h-guess",   // couch host phone
  "d-round", "d-guess",   // Daily Challenge
]);

// Anything that is not an active play screen is a calm state: setup, home,
// lobby, locked/waiting, reveal, game over, landing, daily intro/done — and
// `null`, the pre-boot value, so a page never starts out hiding its chrome.
export function isPlayScreen(screenId) {
  return PLAY_SCREENS.includes(screenId);
}

export function isCalmScreen(screenId) {
  return !isPlayScreen(screenId);
}

// The 🍪 consent control and the 🔊 sound toggle share one rule: calm only.
// Sound state changes are rare and never urgent mid-round; a consent revoke
// has never been urgent at all.
export function utilitiesVisible(screenId) {
  return isCalmScreen(screenId);
}

/* ================================================================
 * 2. May the consent banner ask, here, now? (§6.5)
 * ================================================================ */

/* The gate is unchanged and inviolable: PostHog is not loaded, and nothing
 * is captured, before an explicit accept. What moves is the QUESTION's
 * timing. Today a first visit to `player.html?room=CODE` puts a GDPR dialog
 * over the join form — the first GeoParty experience is a cookie banner.
 *
 * After: the banner never interrupts a join or a round. The landing and the
 * Daily intro stay calm first-contact surfaces (they are the strongest
 * screens in the product and a dialog there costs nothing); on the game
 * pages the ask waits for the first genuinely calm state — the lobby wait,
 * the locked screen, or a reveal. A player who never reaches one is simply
 * never asked, which is the privacy-safe outcome by construction. */
export const CONSENT_PROMPT_SCREENS = Object.freeze({
  // null = any moment on this page is calm enough to ask.
  landing: null,
  daily: Object.freeze(["d-intro", "d-done"]),
  // NOT p-home / p-setup: those are the join + create moments (§3 hotspot 3).
  player: Object.freeze(["p-lobby", "p-locked", "p-reveal", "p-gameover"]),
  // NOT h-setup: the couch host is configuring a party, not idling.
  host: Object.freeze(["h-lobby", "h-reveal", "h-gameover"]),
  // NOT s-entry: typing a room code onto a TV is that surface's join moment.
  tv: Object.freeze([
    "s-lobby", "s-reveal", "s-gameover", "s-h2h-lobby", "s-h2h-reveal",
  ]),
});

// `page` is the surface name consent.js derives from the document path
// ("landing" | "host" | "player" | "daily" | "tv"); `screenId` is the phase
// screen currently shown (null before the page's first showScreen()).
export function mayPromptConsent(page, screenId) {
  if (!Object.prototype.hasOwnProperty.call(CONSENT_PROMPT_SCREENS, page)) {
    return false; // unknown surface: never ask rather than ask badly
  }
  const allowed = CONSENT_PROMPT_SCREENS[page];
  if (allowed === null) return true;
  return allowed.includes(screenId);
}
