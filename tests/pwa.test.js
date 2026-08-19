// Tests for js/pwa.js — pure installed-app (standalone) launch detection
// behind the S5 pwa_launch event.

import test from "node:test";
import assert from "node:assert/strict";

import { isStandaloneDisplay, APP_DISPLAY_MODES } from "../js/pwa.js";

// matchMedia stub: `matching` is the set of display-mode values that report
// matches:true (a real browser matches exactly one display-mode at a time).
function fakeMatchMedia(matching) {
  return (query) => {
    const m = /\(display-mode: ([a-z-]+)\)/.exec(query);
    return { matches: m !== null && matching.includes(m[1]) };
  };
}

test("browser tab: no display-mode matches, no iOS flag", () => {
  assert.equal(
    isStandaloneDisplay({ matchMedia: fakeMatchMedia(["browser"]) }),
    false,
  );
});

test("every installed-app display mode counts as standalone", () => {
  assert.deepEqual(APP_DISPLAY_MODES, ["standalone", "fullscreen", "minimal-ui"]);
  for (const mode of APP_DISPLAY_MODES) {
    assert.equal(
      isStandaloneDisplay({ matchMedia: fakeMatchMedia([mode]) }),
      true,
      mode,
    );
  }
});

test("iOS Safari legacy flag wins even without matchMedia", () => {
  assert.equal(isStandaloneDisplay({ navigatorStandalone: true }), true);
  // ...but only the strict boolean: iOS sets false in a normal tab, and a
  // truthy non-boolean must not count.
  assert.equal(isStandaloneDisplay({ navigatorStandalone: false }), false);
  assert.equal(isStandaloneDisplay({ navigatorStandalone: 1 }), false);
});

test("hostile environments degrade to false, never throw", () => {
  assert.equal(isStandaloneDisplay(), false);
  assert.equal(isStandaloneDisplay({}), false);
  assert.equal(isStandaloneDisplay({ matchMedia: null }), false);
  assert.equal(
    isStandaloneDisplay({ matchMedia: () => { throw new Error("nope"); } }),
    false,
  );
  assert.equal(isStandaloneDisplay({ matchMedia: () => null }), false);
});
