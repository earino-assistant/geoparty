// Tests for js/frontdoor.js — the one front door (M1/M4): join routing by
// room mode, code-input hygiene, and the hero pano fallback sequence.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  joinTarget,
  joinHref,
  PARTY_CHOICES,
  cleanCodeInput,
  HERO_PANOS,
  heroSequence,
} from "../js/frontdoor.js";
import { isValidRoomCode } from "../js/game.js";

/* ---------------- joinTarget / joinHref ---------------- */

test("joinTarget: h2h rooms route to the phones page", () => {
  assert.equal(joinTarget("h2h"), "player.html");
});

test("joinTarget: couch rooms route to the shared display", () => {
  // A couch room's only joinable surface is the TV — its lobby QR has
  // always pointed there, and a couch code typed at the front door is most
  // likely being typed on the TV's own browser.
  assert.equal(joinTarget("couch"), "tv.html");
});

test("joinTarget: unknown/missing modes default to the phones page", () => {
  // player.html recovers gracefully from any mismatch (own error copy),
  // which makes it the safe offline/unreachable fallback.
  for (const mode of [undefined, null, "", "h2h2", 42]) {
    assert.equal(joinTarget(mode), "player.html");
  }
});

test("joinHref: carries the room code through", () => {
  assert.equal(joinHref("h2h", "KWPFRT"), "player.html?room=KWPFRT");
  assert.equal(joinHref("couch", "ABCDEF"), "tv.html?room=ABCDEF");
});

test("PARTY_CHOICES: both experiences start somewhere real", () => {
  // "phones" (the default) and "tv" are the only two choices; their keys
  // double as the analytics party_choice values.
  assert.deepEqual(Object.keys(PARTY_CHOICES).sort(), ["phones", "tv"]);
  assert.match(PARTY_CHOICES.phones, /^player\.html/);
  assert.match(PARTY_CHOICES.tv, /^host\.html/);
});

/* ---------------- cleanCodeInput ---------------- */

test("cleanCodeInput: uppercases and strips non-alphabet characters", () => {
  assert.equal(cleanCodeInput("kwpfrt"), "KWPFRT");
  assert.equal(cleanCodeInput(" kw-pf rt! "), "KWPFRT");
  // I and O are not in the room-code alphabet (makeRoomCode).
  assert.equal(cleanCodeInput("KIOWPF"), "KWPF");
});

test("cleanCodeInput: caps at 6 letters and survives junk input", () => {
  assert.equal(cleanCodeInput("ABCDEFGH"), "ABCDEF");
  assert.equal(cleanCodeInput(null), "");
  assert.equal(cleanCodeInput(undefined), "");
  assert.equal(cleanCodeInput(123456), "");
});

test("cleanCodeInput: a cleaned full-length code is a valid room code", () => {
  assert.ok(isValidRoomCode(cleanCodeInput("kwpfrt")));
});

/* ---------------- hero sequence ---------------- */

test("HERO_PANOS: non-empty list of Mapillary image-id strings", () => {
  assert.ok(HERO_PANOS.length > 0);
  for (const id of HERO_PANOS) assert.match(id, /^\d+$/);
});

test("heroSequence: rotates but keeps every candidate exactly once", () => {
  const list = ["a", "b", "c", "d"];
  assert.deepEqual(heroSequence(list, 0), ["a", "b", "c", "d"]);
  assert.deepEqual(heroSequence(list, 2), ["c", "d", "a", "b"]);
  // Out-of-range and negative starts still cover the whole list.
  assert.deepEqual(heroSequence(list, 6), ["c", "d", "a", "b"]);
  assert.deepEqual(heroSequence(list, -1), ["d", "a", "b", "c"]);
  assert.deepEqual(heroSequence([], 3), []);
});
