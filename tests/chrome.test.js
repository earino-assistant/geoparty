// Tests for js/chrome.js — the §4.1 layer rules and the §6.5 consent
// moment, both expressed as pure predicates over a phase-screen id.
// (docs/ui-ux-design-review.md)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PLAY_SCREENS,
  CONSENT_PROMPT_SCREENS,
  isPlayScreen,
  isCalmScreen,
  utilitiesVisible,
  mayPromptConsent,
  consentBannerAction,
} from "../js/chrome.js";

/* ---------------- calm vs play ---------------- */

test("utilities hide on every phone play screen (§2.5/§2.6/§4.1)", () => {
  for (const id of ["p-round", "p-guess", "h-round", "h-guess",
                    "d-round", "d-guess"]) {
    assert.equal(isPlayScreen(id), true, id);
    assert.equal(utilitiesVisible(id), false, id);
  }
});

test("utilities show in every calm state", () => {
  // §4.1's list: setup, lobby, reveal, game over, landing, daily intro/done
  // — plus the locked/waiting screen, which §6.5 names as calm too.
  for (const id of [
    "p-home", "p-setup", "p-lobby", "p-locked", "p-reveal", "p-gameover",
    "h-setup", "h-lobby", "h-reveal", "h-gameover",
    "d-intro", "d-done",
  ]) {
    assert.equal(isCalmScreen(id), true, id);
    assert.equal(utilitiesVisible(id), true, id);
  }
});

test("the TV's own screens are untouched (§8 do-not-change list)", () => {
  // Nothing on screen.html may start hiding chrome as a side effect of a
  // phone rule: the corners-only TV HUD is on the protected list.
  for (const id of ["s-entry", "s-lobby", "s-round", "s-guess", "s-reveal",
                    "s-h2h-lobby", "s-h2h-live", "s-h2h-reveal",
                    "s-gameover"]) {
    assert.equal(isPlayScreen(id), false, id);
    assert.equal(utilitiesVisible(id), true, id);
  }
});

test("an unknown or pre-boot screen is calm — a page never starts hidden", () => {
  for (const id of [null, undefined, "", "who-knows"]) {
    assert.equal(utilitiesVisible(id), true, String(id));
  }
});

test("PLAY_SCREENS is exactly the six phone play screens, frozen", () => {
  assert.equal(PLAY_SCREENS.length, 6);
  assert.ok(Object.isFrozen(PLAY_SCREENS));
  // A regression guard: nothing calm may drift into the play list, or the
  // 🍪 revoke control would vanish from a screen a user idles on.
  for (const id of PLAY_SCREENS) {
    assert.ok(/^(p|h|d)-(round|guess)$/.test(id), id);
  }
});

/* ---------------- the consent moment (§6.5) ---------------- */

test("the landing may always ask — it is the calm first-contact surface", () => {
  assert.equal(mayPromptConsent("landing", null), true);
  assert.equal(mayPromptConsent("landing", "anything"), true);
});

test("the daily asks on the intro and the done screen, never mid-run", () => {
  assert.equal(mayPromptConsent("daily", "d-intro"), true);
  assert.equal(mayPromptConsent("daily", "d-done"), true);
  assert.equal(mayPromptConsent("daily", "d-round"), false);
  assert.equal(mayPromptConsent("daily", "d-guess"), false);
  assert.equal(mayPromptConsent("daily", "d-reveal"), false);
});

test("the banner never interrupts a join (§3 hotspot 3)", () => {
  // The whole point: a first-visit player.html?room=CODE used to open with
  // a GDPR dialog over the join form.
  assert.equal(mayPromptConsent("player", "p-home"), false);
  assert.equal(mayPromptConsent("player", "p-setup"), false);
  assert.equal(mayPromptConsent("player", null), false);
  // …nor a TV's code entry, which is that surface's join moment.
  assert.equal(mayPromptConsent("tv", "s-entry"), false);
});

test("the banner never interrupts a round", () => {
  for (const [page, id] of [
    ["player", "p-round"], ["player", "p-guess"],
    ["host", "h-round"], ["host", "h-guess"],
    ["daily", "d-round"], ["daily", "d-guess"],
  ]) {
    assert.equal(mayPromptConsent(page, id), false, `${page}/${id}`);
  }
});

test("game pages ask at the first calm state: lobby, locked, reveal", () => {
  assert.equal(mayPromptConsent("player", "p-lobby"), true);
  assert.equal(mayPromptConsent("player", "p-locked"), true);
  assert.equal(mayPromptConsent("player", "p-reveal"), true);
  assert.equal(mayPromptConsent("player", "p-gameover"), true);
  assert.equal(mayPromptConsent("host", "h-lobby"), true);
  assert.equal(mayPromptConsent("host", "h-reveal"), true);
  assert.equal(mayPromptConsent("host", "h-gameover"), true);
});

test("the couch setup screen is not a prompt moment either", () => {
  // §6.5 enumerates lobby / locked / reveal for game pages; the host is
  // configuring a party on h-setup, not idling.
  assert.equal(mayPromptConsent("host", "h-setup"), false);
});

test("an unknown surface never asks rather than asking badly", () => {
  assert.equal(mayPromptConsent("bogus", "p-lobby"), false);
  assert.equal(mayPromptConsent("", null), false);
  // Prototype keys must not resolve as configured pages.
  assert.equal(mayPromptConsent("constructor", "p-lobby"), false);
  assert.equal(mayPromptConsent("toString", "p-lobby"), false);
});

test("every prompt screen is a calm screen — the two rules never disagree", () => {
  for (const [page, screens] of Object.entries(CONSENT_PROMPT_SCREENS)) {
    if (screens === null) continue;
    for (const id of screens) {
      assert.equal(isCalmScreen(id), true, `${page}/${id}`);
    }
  }
});

/* ---------------- #6 undecided-banner retract on play ---------------- */

test("consentBannerAction: retracts the moment a play screen shows", () => {
  // The whole fix: an undecided banner may not float over the round.
  for (const [page, id] of [
    ["player", "p-round"], ["player", "p-guess"],
    ["host", "h-round"], ["host", "h-guess"],
    ["daily", "d-round"], ["daily", "d-guess"],
  ]) {
    assert.equal(consentBannerAction(page, id), "retract", `${page}/${id}`);
  }
});

test("consentBannerAction: prompts on the calm promptable screens", () => {
  assert.equal(consentBannerAction("player", "p-lobby"), "prompt");
  assert.equal(consentBannerAction("player", "p-reveal"), "prompt");
  assert.equal(consentBannerAction("host", "h-gameover"), "prompt");
  assert.equal(consentBannerAction("landing", null), "prompt");
  assert.equal(consentBannerAction("daily", "d-intro"), "prompt");
});

test("consentBannerAction: holds on a calm-but-not-promptable join/setup form", () => {
  // p-home / p-setup / h-setup / s-entry were never prompt moments; the banner
  // is only forcibly cleared on play, not on these.
  assert.equal(consentBannerAction("player", "p-home"), "hold");
  assert.equal(consentBannerAction("player", "p-setup"), "hold");
  assert.equal(consentBannerAction("host", "h-setup"), "hold");
  assert.equal(consentBannerAction("tv", "s-entry"), "hold");
});

test("consentBannerAction: an unknown surface never prompts (holds)", () => {
  assert.equal(consentBannerAction("bogus", "whatever"), "hold");
  // …but a play screen still retracts regardless of surface — a fail-safe.
  assert.equal(consentBannerAction("bogus", "p-round"), "retract");
});
