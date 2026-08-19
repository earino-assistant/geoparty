// share.js — pure share-artifact logic (design review §2.4, roadmap S1):
// the post-game result card is a clipboard string, no backend. Two shapes:
// the party brag ("We were 3 km from Kyoto") and the Wordle-style daily
// grid. Every link the card carries is UTM-tagged so PostHog can attribute
// new-room creations to shared links — the tag names a source and a
// campaign, never a person. No DOM in here; the Web Share / clipboard glue
// lives in share-ui.js.

import { formatDistance } from "./game.js";

/* ================================================================
 * UTM tagging. utm_source=share marks "arrived via a result card";
 * utm_campaign says which card ("couch" | "h2h" | "daily"). PostHog
 * picks utm_* off the landing URL automatically — no code reads them.
 * ================================================================ */

export const UTM_SOURCE = "share";

export function withUtm(href, campaign) {
  const url = new URL(href);
  url.searchParams.set("utm_source", UTM_SOURCE);
  url.searchParams.set("utm_campaign", campaign);
  return url.href;
}

/* ================================================================
 * The party card (both modes). The brag is the game's closest guess —
 * the moment the room will actually retell — plus the winning score.
 * Place names come from the pool's pre-geocoded labels; team names
 * (user-entered) deliberately never appear on the card.
 * ================================================================ */

// Fold one reveal's results into the game-best moment. results is the
// round's {teamId: {guess, distanceKm}} map (any subset — a solo phone
// passes just its own); placeName is that round's truth label. Returns
// {km, place} or the unchanged input. Idempotent, so re-renders are safe.
export function foldBestMoment(best, results, placeName) {
  let out = best;
  for (const r of Object.values(results || {})) {
    if (!r || !r.guess || typeof r.distanceKm !== "number") continue;
    if (!out || r.distanceKm < out.km) {
      out = { km: r.distanceKm, place: placeName || null };
    }
  }
  return out;
}

// "GeoParty 🌍 We were 3.2 km from Kyoto, Japan 🏆 12,340 pts — beat us: <url>"
// best may be null (an all-forfeit game still gets a card, minus the brag).
export function partyShareText({ best, points, url }) {
  const brag = best
    ? `We were ${formatDistance(best.km)} from ` +
      `${best.place || "the answer"} 🏆 `
    : "";
  return `GeoParty 🌍 ${brag}${points.toLocaleString()} pts — beat us: ${url}`;
}

/* ================================================================
 * The daily card: puzzle number, score, and the emoji row — one
 * square per round, graded by distance. The row is the Wordle grid:
 * legible at a glance in any chat, and it spoils nothing.
 * ================================================================ */

// Distance grades. Buckets are felt-quality tiers, not score math:
// green ≈ named the place, yellow ≈ right region, orange ≈ right
// continent, red ≈ lost, black ≈ never dropped a pin.
export const EMOJI_BUCKETS = Object.freeze([
  { maxKm: 100, emoji: "🟩" },
  { maxKm: 750, emoji: "🟨" },
  { maxKm: 3000, emoji: "🟧" },
  { maxKm: Infinity, emoji: "🟥" },
]);

export const EMOJI_NO_PIN = "⬛";

export function distanceEmoji(km) {
  if (typeof km !== "number") return EMOJI_NO_PIN;
  return EMOJI_BUCKETS.find((b) => km <= b.maxKm).emoji;
}

// rounds is a daily run's rounds array ({distanceKm: number|null}).
export function emojiRow(rounds) {
  return (rounds || []).map((r) => distanceEmoji(r.distanceKm)).join("");
}

// "GeoParty Daily #37 🌍 18,420 pts\n🟩🟩🟨🟧⬛\nBeat me: <url>"
export function dailyShareText({ dayNumber, score, rounds, url }) {
  return `GeoParty Daily #${dayNumber} 🌍 ${score.toLocaleString()} pts\n` +
    `${emojiRow(rounds)}\n` +
    `Beat me: ${url}`;
}
