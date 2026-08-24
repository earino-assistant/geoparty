// partyrecap.js — pure logic for the party game-over "Where were the places"
// recap (design: docs/party-recap-spec.md; owner's trigger: the party
// game-over screens should have the per-round mini-map recall aid the Daily
// done screen already has). No DOM, no Firebase, no network — same discipline
// as game.js / recap.js / revealmap.js.
//
// The party flow keeps only the CURRENT room.round (every earlier round is
// overwritten in place, and there is no history node in the RTDB schema), so
// each surface folds a memory-only per-device accumulator at each reveal.
// This module is that fold plus the card/caption/scene derivation; the
// *-ui.js modules are the thin glue that draw the cards via the shared
// revealmap renderer (js/recap-ui.js).

import { revealPins } from "./h2h.js";
import { couchRevealPins } from "./couchscreen.js";
import { formatDistance } from "./game.js";
import { phoneRevealScene, dailyRevealScene } from "./revealmap.js";

// Is this a real number we can trust as a coordinate?
const finite = (n) => typeof n === "number" && Number.isFinite(n);

// The fold: record one revealed round into the memory-only history and return
// the (new) accumulator. Called from the render paths, which re-run on every
// Firebase echo — so it is IDEMPOTENT (a round.number already present is a
// no-op) and PURE (never mutates `history`; on append it returns a NEW array;
// on a no-op it returns the SAME reference so glue can cheaply detect it).
//
// `mode` is passed explicitly by the glue (each call site knows its mode
// statically): "h2h" → revealPins(round); otherwise → couchRevealPins(round,
// activeTeam), which covers couch solo (one pin) and showdown (all pins).
export function recordPartyRound(history, round, { mode, activeTeam } = {}) {
  const hist = Array.isArray(history) ? history : [];
  // Nothing valid to record — the truthless fake reveal on couch pool
  // exhaustion lands here too (phase "reveal" with no final truth).
  if (!round || !finite(round.number) || round.number <= 0) return history;
  const truth = round.truth;
  if (!truth || !finite(truth.lat) || !finite(truth.lng)) return history;
  // Idempotence: the fold is re-called on every state echo.
  if (hist.some((e) => e.number === round.number)) return history;

  const pins = mode === "h2h"
    ? revealPins(round)
    : couchRevealPins(round, activeTeam);
  return hist.concat({
    number: round.number,
    name: truth.name || null,
    truth: { lat: truth.lat, lng: truth.lng },
    pins,
  });
}

// One card per revealed round, sorted by round number ascending. Malformed
// entries are dropped. totalRounds = the highest round number present (the
// rounds actually played — honest when pool exhaustion ended the game early,
// and tolerant of a gap from a device that missed a reveal snapshot).
// Empty/nullish in → [].
export function partyRecapCards(history) {
  const hist = Array.isArray(history) ? history : [];
  const valid = hist.filter((e) =>
    e && finite(e.number) && e.number > 0 &&
    e.truth && finite(e.truth.lat) && finite(e.truth.lng) &&
    Array.isArray(e.pins));
  if (!valid.length) return [];
  const totalRounds = valid.reduce((m, e) => Math.max(m, e.number), 0);
  return valid
    .slice()
    .sort((a, b) => a.number - b.number)
    .map((e) => ({
      round: e.number,
      totalRounds,
      name: e.name || null,
      truth: e.truth,
      pins: e.pins,
    }));
}

// The caption under a card: round number, the place name (masked wholesale by
// the recap block, so a real name is safe here), and the closest guess. No
// points and no team names (§2.3): points are multi-team here and the final
// board sits right above the recap; the pin colors already carry recall.
export function partyRecapCaption(card) {
  const parts = [
    `Round ${card.round} of ${card.totalRounds}`,
    card.name || "Somewhere mysterious",
  ];
  const dists = card.pins
    .map((p) => p.distanceKm)
    .filter((d) => finite(d));
  if (!dists.length) {
    parts.push("no pins");
  } else {
    const min = Math.min(...dists);
    // "closest" only when there's more than one pin to be closest among (a
    // couch solo card reads "… · 12.4 km").
    parts.push((card.pins.length > 1 ? "closest " : "") + formatDistance(min));
  }
  return parts.join(" · ");
}

// A recap card's map scene — a pure passthrough to the shared reveal scenes.
// Pins present → phoneRevealScene (multi-pin, team colors, gold truth), but
// mapped to {id, lat, lng} only, which strips the SUPER SURE halo (D4: a
// permanent tooltip label is clutter on a small card and the bet's fate was
// its reveal-moment story) and decoys are never accumulated (round theater,
// not geography recall). Pinless round → dailyRevealScene's no-guess framing
// (zoom-4 view + truth pin); phoneRevealScene would fitBounds a single point
// into a meaningless close-up. `teams` is used only for teamHex color lookup
// and never renders as text.
export function partyRecapCardScene(card, teams) {
  if (card.pins.length === 0) {
    return dailyRevealScene({
      truth: card.truth, guess: null, ghost: null, reducedMotion: false,
    });
  }
  return phoneRevealScene({
    truth: card.truth,
    pins: card.pins.map((p) => ({ id: p.id, lat: p.lat, lng: p.lng })),
    decoys: [],
    teams,
  });
}
