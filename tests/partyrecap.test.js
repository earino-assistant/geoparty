// Tests for js/partyrecap.js — the party game-over recap fold, cards, caption
// and scene (docs/party-recap-spec.md §9.1). The load-bearing suite: every
// per-surface wiring diff (fold call sites, resets, the TV cycle timer) is
// thin *-ui.js glue, so all the decisions live here under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recordPartyRound, partyRecapCards, partyRecapCaption, partyRecapCardScene,
} from "../js/partyrecap.js";
import { phoneRevealScene, dailyRevealScene } from "../js/revealmap.js";
import { formatDistance } from "../js/game.js";

const TEAMS = {
  t1: { name: "Alpha" }, t2: { name: "Beta" },
  t3: { name: "Gamma" }, t4: { name: "Delta" },
};

// A couch solo round: one active team, its guess on round.guess/round.score.
const soloRound = (number, over = {}) => ({
  number,
  truth: { lat: 35.01, lng: 135.77, name: "Kyoto, Japan" },
  guess: { lat: 36, lng: 136 },
  score: { distanceKm: 120, superSure: false, superSureOutcome: null },
  ...over,
});

// A multi-team round (showdown / h2h): everyone's guess on round.results.
const multiRound = (number, over = {}) => ({
  number,
  truth: { lat: 35.01, lng: 135.77, name: "Kyoto, Japan" },
  results: {
    t1: { guess: { lat: 36, lng: 136 }, distanceKm: 120, superSure: false },
    t2: { guess: { lat: 50, lng: 150 }, distanceKm: 1800, superSure: true, superSureOutcome: "lost" },
  },
  ...over,
});

/* ---------------- recordPartyRound ---------------- */

test("recordPartyRound: couch solo → one entry, pin id = activeTeam, truth/name carried", () => {
  const out = recordPartyRound([], soloRound(3), { mode: "couch", activeTeam: "t2" });
  assert.equal(out.length, 1);
  assert.equal(out[0].number, 3);
  assert.equal(out[0].name, "Kyoto, Japan");
  assert.deepEqual(out[0].truth, { lat: 35.01, lng: 135.77 });
  assert.equal(out[0].pins.length, 1);
  assert.equal(out[0].pins[0].id, "t2");
});

test("recordPartyRound: truth without a name records name:null", () => {
  const round = soloRound(1, { truth: { lat: 10, lng: 20 } });
  const out = recordPartyRound([], round, { mode: "couch", activeTeam: "t1" });
  assert.equal(out[0].name, null);
});

test("recordPartyRound: couch showdown → all teams' pins, farthest-first", () => {
  const out = recordPartyRound([], multiRound(2, { showdown: true }),
    { mode: "couch", activeTeam: "t1" });
  // revealPins is farthest-first: t2 (1800km) before t1 (120km).
  assert.deepEqual(out[0].pins.map((p) => p.id), ["t2", "t1"]);
});

test("recordPartyRound: h2h → pins from results; forfeited teams absent", () => {
  const round = multiRound(1, {
    results: {
      t1: { guess: { lat: 36, lng: 136 }, distanceKm: 120, superSure: false },
      t2: {},  // forfeit — no guess
    },
  });
  const out = recordPartyRound([], round, { mode: "h2h" });
  assert.deepEqual(out[0].pins.map((p) => p.id), ["t1"]);
});

test("recordPartyRound: an all-forfeit round records with pins: []", () => {
  const round = multiRound(1, { results: { t1: {}, t2: {} } });
  const out = recordPartyRound([], round, { mode: "h2h" });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].pins, []);
});

test("recordPartyRound: idempotence — same number returns the SAME reference", () => {
  const first = recordPartyRound([], soloRound(1), { mode: "couch", activeTeam: "t1" });
  const again = recordPartyRound(first, soloRound(1), { mode: "couch", activeTeam: "t1" });
  assert.equal(again, first);
});

test("recordPartyRound: rejection paths all return the SAME reference", () => {
  const h = [{ number: 1, truth: { lat: 1, lng: 2 }, pins: [] }];
  assert.equal(recordPartyRound(h, null, { mode: "couch" }), h);
  assert.equal(recordPartyRound(h, {}, { mode: "couch" }), h);          // no number
  assert.equal(recordPartyRound(h, { number: 0, truth: { lat: 1, lng: 2 } }, {}), h);
  assert.equal(recordPartyRound(h, { number: 2 }, { mode: "couch" }), h); // no truth
  assert.equal(recordPartyRound(h, { number: 2, truth: { lat: NaN, lng: 2 } }, {}), h);
  assert.equal(recordPartyRound(h, { number: 2, truth: { lat: 1 } }, {}), h);
});

test("recordPartyRound: purity — input array never mutated, append returns a new array", () => {
  const h = [];
  const out = recordPartyRound(h, soloRound(1), { mode: "couch", activeTeam: "t1" });
  assert.equal(h.length, 0);
  assert.notEqual(out, h);
});

test("recordPartyRound: privacy shape — pins carry only slot-id keys, id ∈ t1..t4", () => {
  const out = recordPartyRound([], multiRound(1, { showdown: true }),
    { mode: "couch", activeTeam: "t1" });
  for (const p of out[0].pins) {
    assert.deepEqual(
      Object.keys(p).sort(),
      ["distanceKm", "id", "lat", "lng", "superSure", "superSureOutcome"]);
    assert.match(p.id, /^t[1-4]$/);
  }
});

/* ---------------- partyRecapCards ---------------- */

test("partyRecapCards: sorted ascending, totalRounds = max round number", () => {
  const h = [
    { number: 3, truth: { lat: 1, lng: 2 }, pins: [] },
    { number: 1, truth: { lat: 1, lng: 2 }, pins: [] },
  ];
  const cards = partyRecapCards(h);
  assert.deepEqual(cards.map((c) => c.round), [1, 3]);
  // gap case: rounds 1 and 3 → two cards, totalRounds 3.
  assert.equal(cards.length, 2);
  assert.ok(cards.every((c) => c.totalRounds === 3));
});

test("partyRecapCards: empty/nullish → [], malformed entries dropped", () => {
  assert.deepEqual(partyRecapCards([]), []);
  assert.deepEqual(partyRecapCards(null), []);
  assert.deepEqual(partyRecapCards(undefined), []);
  assert.deepEqual(partyRecapCards([
    { number: 0, truth: { lat: 1, lng: 2 }, pins: [] },      // bad number
    { number: 2, truth: { lat: NaN, lng: 2 }, pins: [] },    // bad truth
    { number: 3, truth: { lat: 1, lng: 2 } },                // no pins array
  ]), []);
});

/* ---------------- partyRecapCaption ---------------- */

test("partyRecapCaption: multi-pin → closest + formatDistance of the min", () => {
  const [card] = partyRecapCards(
    recordPartyRound([], multiRound(2, { showdown: true }), { mode: "couch", activeTeam: "t1" }));
  card.totalRounds = 7;
  assert.equal(partyRecapCaption(card),
    `Round 2 of 7 · Kyoto, Japan · closest ${formatDistance(120)}`);
});

test("partyRecapCaption: single pin → plain distance (no 'closest')", () => {
  const [card] = partyRecapCards(
    recordPartyRound([], soloRound(2), { mode: "couch", activeTeam: "t1" }));
  card.totalRounds = 7;
  assert.equal(partyRecapCaption(card),
    `Round 2 of 7 · Kyoto, Japan · ${formatDistance(120)}`);
});

test("partyRecapCaption: no pins → 'no pins'; name fallback", () => {
  const card = { round: 4, totalRounds: 5, name: null, truth: { lat: 1, lng: 2 }, pins: [] };
  assert.equal(partyRecapCaption(card), "Round 4 of 5 · Somewhere mysterious · no pins");
});

/* ---------------- partyRecapCardScene ---------------- */

test("partyRecapCardScene: pins present → phoneRevealScene of stripped pins, halo absent", () => {
  const [card] = partyRecapCards(
    recordPartyRound([], multiRound(2, { showdown: true }), { mode: "couch", activeTeam: "t1" }));
  const scene = partyRecapCardScene(card, TEAMS);
  assert.deepEqual(scene, phoneRevealScene({
    truth: card.truth,
    pins: card.pins.map((p) => ({ id: p.id, lat: p.lat, lng: p.lng })),
    decoys: [], teams: TEAMS,
  }));
  // t2's superSure pin drew no halo (the halo op carries a permanent tooltip).
  assert.ok(!scene.ops.some((o) => o.tooltip && o.tooltip.permanent));
});

test("partyRecapCardScene: zero pins → dailyRevealScene no-guess framing (zoom-4)", () => {
  const card = { round: 1, totalRounds: 1, name: null, truth: { lat: 60, lng: 30 }, pins: [] };
  const scene = partyRecapCardScene(card, TEAMS);
  assert.deepEqual(scene, dailyRevealScene({
    truth: card.truth, guess: null, ghost: null, reducedMotion: false,
  }));
  assert.ok(scene.ops.some((o) => o.op === "view" && o.zoom === 4));
});
