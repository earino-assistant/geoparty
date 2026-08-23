// recap.js — pure logic for the Daily "Your five places" recap (design:
// the done-screen recall aid; owner's trigger: replaying a friend's ghost
// link and not remembering what the answers were). No DOM, no Leaflet, no
// network — same discipline as game.js / daily.js / revealmap.js. This turns
// a completed run into per-round recap cards; js/daily-ui.js is the thin DOM
// glue that draws them via the shared revealmap renderer.
//
// The five truths are recomputed from the day seed (not persisted — the
// truths never enter the saved run), and paired with the player's saved pins.
// The SKEW GUARD below drops any card whose saved distance doesn't match the
// recomputed truth: a pool that shifted under an old save, or a skip-adjusted
// play order, would otherwise pair the wrong place with a pin.

import { haversineKm, formatDistance } from "./game.js";
import { dailyRevealScene } from "./revealmap.js";

// A saved guess whose recorded distance disagrees with the recomputed truth by
// more than this many km is a mispairing (changed pool / wrong-day / skip
// drift), not a real guess — drop the card rather than show a lie.
export const RECAP_SKEW_TOLERANCE_KM = 50;

// Build one recap card per played round from:
//   places      — the day's truths in shown order: [{name, lat, lng}, ...]
//   rounds      — the saved run's rounds: [{distanceKm, points, guess?}, ...]
//   ghostRounds — duel bookkeeping (optional): [{points, distanceKm, pin?}]
// Each card: { round, name, truth, guess, points, distanceKm, ghost }.
// Handles forfeits (guess null), pre-v2 saves (no `guess` field → truth-only
// card), a shorter places or rounds list (min wins), and empty-in → empty-out.
export function recapCards({ places, rounds, ghostRounds } = {}) {
  const ps = Array.isArray(places) ? places : [];
  const rs = Array.isArray(rounds) ? rounds : [];
  const gs = Array.isArray(ghostRounds) ? ghostRounds : [];
  const n = Math.min(ps.length, rs.length);
  const cards = [];
  for (let i = 0; i < n; i++) {
    const place = ps[i];
    const round = rs[i];
    if (!place || typeof place.lat !== "number" || typeof place.lng !== "number") {
      continue;
    }
    const truth = { lat: place.lat, lng: place.lng };
    const guess = round && round.guess &&
      typeof round.guess.lat === "number" && typeof round.guess.lng === "number"
      ? { lat: round.guess.lat, lng: round.guess.lng }
      : null;
    const distanceKm =
      round && typeof round.distanceKm === "number" ? round.distanceKm : null;

    // Skew guard: only meaningful when BOTH a pin and its recorded distance
    // survive in the save (pre-v2 saves carry a distance but no pin, so this
    // is skipped and the card renders truth-only).
    if (guess && distanceKm != null) {
      const recomputed = haversineKm(truth.lat, truth.lng, guess.lat, guess.lng);
      if (Math.abs(recomputed - distanceKm) > RECAP_SKEW_TOLERANCE_KM) continue;
    }

    const g = gs[i];
    const ghost = g && g.pin &&
      typeof g.pin.lat === "number" && typeof g.pin.lng === "number"
      ? {
          pin: { lat: g.pin.lat, lng: g.pin.lng },
          distanceKm: typeof g.distanceKm === "number" ? g.distanceKm : null,
        }
      : null;

    cards.push({
      round: i + 1,
      name: place.name || null,
      truth,
      guess,
      points: round && typeof round.points === "number" ? round.points : 0,
      distanceKm,
      ghost,
    });
  }
  return cards;
}

// How many of the leading recap cards should be initialised eagerly (their
// map rendered up front) rather than lazily on scroll, so a second card
// visibly peeks in and signals there's more to swipe.
export function recapEagerCount(cardCount) {
  const n = Math.max(0, Math.floor(Number(cardCount) || 0));
  return Math.min(2, n);
}

// A recap card's map scene — a pure passthrough to the shared daily reveal
// scene (guess pin + line, the delayed 👻 beat when it's a duel, the truth
// pin). Reusing dailyRevealScene keeps the recap card pixel-identical to the
// live reveal it mirrors.
export function recapCardScene(card, reducedMotion) {
  return dailyRevealScene({
    truth: card.truth,
    guess: card.guess,
    ghost: card.ghost,
    reducedMotion: !!reducedMotion,
  });
}

// The caption under a card: round number, the city name (masked wholesale by
// the recap block, so a real place name is safe here), and — when the round
// was actually guessed — the distance and points. A forfeit reads "no guess".
export function recapCaption(card) {
  const parts = [`Round ${card.round} of 5`, card.name || "—"];
  if (card.distanceKm != null) {
    parts.push(formatDistance(card.distanceKm));
    parts.push(`${card.points.toLocaleString()} pts`);
  } else {
    parts.push("no guess");
  }
  return parts.join(" · ");
}
