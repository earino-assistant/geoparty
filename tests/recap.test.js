// Tests for js/recap.js — the pure derivation behind the Daily "Your five
// places" recap. Covers the card matrix (guessed / forfeit / pre-v2 / duel),
// the skew guard, the overview pins, the caption, and the scene passthrough.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RECAP_SKEW_TOLERANCE_KM,
  recapCards,
  recapCardScene,
  overviewPins,
  recapCaption,
} from "../js/recap.js";
import { haversineKm, formatDistance } from "../js/game.js";
import { dailyRevealScene } from "../js/revealmap.js";

// Three truths with names; a guess placed a known distance from truth #1.
const PLACES = [
  { name: "Kyoto, Japan", lat: 35.01, lng: 135.77 },
  { name: "Radomierz, Poland", lat: 50.9, lng: 15.9 },
  { name: "Lima, Peru", lat: -12.05, lng: -77.04 },
];

// A guess near Kyoto (so haversine ≈ the stored distanceKm within tolerance).
const G1 = { lat: 34.7, lng: 135.5 };
const D1 = haversineKm(PLACES[0].lat, PLACES[0].lng, G1.lat, G1.lng);

function round(distanceKm, guess, points) {
  return { distanceKm, points, guess: guess || null, elapsedMs: 1000 };
}

/* ---------------- recapCards: the core matrix ---------------- */

test("recapCards: a guessed round carries truth, pin, points, distance", () => {
  const cards = recapCards({
    places: [PLACES[0]],
    rounds: [round(D1, G1, 4820)],
    ghostRounds: [],
  });
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0], {
    round: 1,
    name: "Kyoto, Japan",
    truth: { lat: 35.01, lng: 135.77 },
    guess: { lat: 34.7, lng: 135.5 },
    points: 4820,
    distanceKm: D1,
    ghost: null,
  });
});

test("recapCards: a forfeit (no pin) still yields a truth-only card, 0 points", () => {
  const cards = recapCards({
    places: [PLACES[0]],
    rounds: [round(null, null, 0)],
    ghostRounds: [],
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].guess, null);
  assert.equal(cards[0].distanceKm, null);
  assert.equal(cards[0].points, 0);
  assert.deepEqual(cards[0].truth, { lat: 35.01, lng: 135.77 });
});

test("recapCards: a pre-v2 save (distance but no `guess` field) renders truth-only", () => {
  // The v1 round shape had no `guess` — the skew guard is skipped and the
  // card shows the truth + distance/points without a pin.
  const cards = recapCards({
    places: [PLACES[0]],
    rounds: [{ distanceKm: D1, points: 4820 }],
    ghostRounds: [],
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].guess, null);
  assert.equal(cards[0].distanceKm, D1);
});

test("recapCards: the skew guard drops a mispaired card", () => {
  // Same pin, but a recorded distance that disagrees with the recomputed
  // truth by > tolerance — a changed pool / wrong-day pairing.
  const cards = recapCards({
    places: [PLACES[0]],
    rounds: [round(D1 + RECAP_SKEW_TOLERANCE_KM + 1, G1, 4820)],
    ghostRounds: [],
  });
  assert.deepEqual(cards, []);
});

test("recapCards: a within-tolerance skew is kept (boundary)", () => {
  const cards = recapCards({
    places: [PLACES[0]],
    rounds: [round(D1 + RECAP_SKEW_TOLERANCE_KM, G1, 4820)],
    ghostRounds: [],
  });
  assert.equal(cards.length, 1);
});

test("recapCards: a duel round attaches the ghost pin + distance", () => {
  const cards = recapCards({
    places: [PLACES[0]],
    rounds: [round(D1, G1, 4820)],
    ghostRounds: [{ points: 3000, distanceKm: 500, pin: { lat: 36, lng: 136 } }],
  });
  assert.deepEqual(cards[0].ghost, {
    pin: { lat: 36, lng: 136 }, distanceKm: 500,
  });
});

test("recapCards: a ghost round with no pin (forfeit) attaches no ghost", () => {
  const cards = recapCards({
    places: [PLACES[0]],
    rounds: [round(D1, G1, 4820)],
    ghostRounds: [{ points: 0, distanceKm: null, pin: null }],
  });
  assert.equal(cards[0].ghost, null);
});

test("recapCards: empty in → empty out; nullish input is safe", () => {
  assert.deepEqual(recapCards({ places: [], rounds: [], ghostRounds: [] }), []);
  assert.deepEqual(recapCards({}), []);
  assert.deepEqual(recapCards(), []);
});

test("recapCards: card count is min(places, rounds); round numbers are positional", () => {
  const cards = recapCards({
    places: PLACES,                              // 3 places
    rounds: [round(D1, G1, 100), round(null, null, 0)], // 2 rounds
    ghostRounds: [],
  });
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map((c) => c.round), [1, 2]);
});

test("recapCards: a place missing coordinates is skipped", () => {
  const cards = recapCards({
    places: [{ name: "Nowhere" }],
    rounds: [round(D1, G1, 100)],
    ghostRounds: [],
  });
  assert.deepEqual(cards, []);
});

/* ---------------- overviewPins ---------------- */

test("overviewPins: one numbered pin per card at its truth", () => {
  const cards = recapCards({
    places: PLACES.slice(0, 2),
    rounds: [round(D1, G1, 1), round(null, null, 0)],
    ghostRounds: [],
  });
  assert.deepEqual(overviewPins(cards), [
    { n: 1, lat: 35.01, lng: 135.77 },
    { n: 2, lat: 50.9, lng: 15.9 },
  ]);
});

/* ---------------- recapCaption ---------------- */

test("recapCaption: a guessed round shows round · city · distance · points", () => {
  const [card] = recapCards({
    places: [PLACES[0]], rounds: [round(D1, G1, 4820)], ghostRounds: [],
  });
  assert.equal(
    recapCaption(card),
    `Round 1 · Kyoto, Japan · ${formatDistance(D1)} · ${(4820).toLocaleString()} pts`);
});

test("recapCaption: a forfeit reads 'no guess'", () => {
  const [card] = recapCards({
    places: [PLACES[0]], rounds: [round(null, null, 0)], ghostRounds: [],
  });
  assert.equal(recapCaption(card), "Round 1 · Kyoto, Japan · no guess");
});

test("recapCaption: a missing name falls back to an em-dash placeholder", () => {
  const [card] = recapCards({
    places: [{ lat: 1, lng: 2 }], rounds: [round(null, null, 0)], ghostRounds: [],
  });
  assert.equal(recapCaption(card), "Round 1 · — · no guess");
});

/* ---------------- recapCardScene ---------------- */

test("recapCardScene: passthrough to dailyRevealScene with the card's fields", () => {
  const [card] = recapCards({
    places: [PLACES[0]],
    rounds: [round(D1, G1, 100)],
    ghostRounds: [{ points: 1, distanceKm: 9, pin: { lat: 36, lng: 136 } }],
  });
  assert.deepEqual(
    recapCardScene(card, false),
    dailyRevealScene({
      truth: card.truth, guess: card.guess, ghost: card.ghost, reducedMotion: false,
    }));
});
