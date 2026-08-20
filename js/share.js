// share.js — pure share-artifact logic (design review §2.4, roadmap S1):
// the post-game result card is a clipboard string, no backend. Two shapes:
// the party brag ("We were 3 km from Kyoto") and the Wordle-style daily
// grid. Every link the card carries is UTM-tagged so PostHog can attribute
// new-room creations to shared links — the tag names a source and a
// campaign, never a person. No DOM in here; the Web Share / clipboard glue
// lives in share-ui.js.

import { formatDistance } from "./game.js";
import { appendGhostFragment } from "./ghost.js";

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
// continent, red ≈ lost, black ≈ never dropped a pin. G4 (spec §3.4) adds
// the one-word caption — the vocabulary of bragging shown at the reveal —
// so the grid square and the caption can never disagree.
export const EMOJI_BUCKETS = Object.freeze([
  { maxKm: 100, emoji: "🟩", caption: "Nailed it" },
  { maxKm: 750, emoji: "🟨", caption: "Right region" },
  { maxKm: 3000, emoji: "🟧", caption: "Right continent" },
  { maxKm: Infinity, emoji: "🟥", caption: "Lost" },
]);

export const EMOJI_NO_PIN = "⬛";

// G4 ACE: a pin under 1 km. The 🎯 square replaces 🟩 in the grid for ace
// rounds (a visibly different flex, no new copy). The threshold is fixed and
// mode/difficulty-independent — an ACE on Expert is simply worth retelling
// more (spec §3.4, owner checklist #7).
export const ACE_MAX_KM = 1;
export const EMOJI_ACE = "🎯";

export function distanceEmoji(km) {
  if (typeof km !== "number") return EMOJI_NO_PIN;
  if (km < ACE_MAX_KM) return EMOJI_ACE;
  return EMOJI_BUCKETS.find((b) => km <= b.maxKm).emoji;
}

// rounds is a daily run's rounds array ({distanceKm: number|null}).
export function emojiRow(rounds) {
  return (rounds || []).map((r) => distanceEmoji(r.distanceKm)).join("");
}

// The daily card. Grows across phases (spec §8) but the shape is stable:
//   line 1  header — number, hard star ⚡ (G6), 🔥streak (G1), score
//   line 2  the emoji grid (🎯-capable for aces, G4)
//   line 3  the link — a Ghost Duel challenge by default once G5 ships (§3.5.1)
// A run that isn't a duel and predates the streak simply omits those segments,
// so P2's first card is exactly the plain card plus the ⚔️ challenge line.
//
// verdict (§3.5.4) leads with the duel result instead of the score:
//   "GeoParty Daily #37 — I beat the ghost by 1,840 🏆"
export function dailyShareText({
  dayNumber, score = 0, rounds, url,
  streak = 0, hard = false, challenge = false, verdict = null,
}) {
  const star = hard ? "*" : "";
  let first;
  if (verdict) {
    first = `GeoParty Daily #${dayNumber}${star} — ${verdictLead(verdict)}`;
  } else {
    const flair = [];
    if (hard) flair.push("⚡");
    if (streak >= 2) flair.push(`🔥${streak}`);   // a 🔥1 is noise, not a brag
    if (flair.length === 0) flair.push("🌍");
    first = `GeoParty Daily #${dayNumber}${star} ${flair.join(" ")}` +
      ` · ${score.toLocaleString()} pts`;
  }
  const last = verdict ? `⚔️ Your move: ${url}`
    : challenge ? `⚔️ Beat my ghost: ${url}`
      : `Beat me: ${url}`;
  return `${first}\n${emojiRow(rounds)}\n${last}`;
}

function verdictLead(v) {
  if (v.outcome === "won") return `I beat the ghost by ${(v.margin || 0).toLocaleString()} 🏆`;
  if (v.outcome === "lost") return `The ghost got me by ${(v.margin || 0).toLocaleString()} 👻`;
  return "Dead heat with the ghost 🤝";
}

// The challenge/return-challenge link: UTM tag AND the ghost fragment coexist —
// the utm_* on the query string (inbound attribution), the payload on the
// fragment ONLY (never an HTTP request, never a log, §3.5.6).
export function dailyChallengeUrl(baseHref, payload, campaign = "daily") {
  return appendGhostFragment(withUtm(baseHref, campaign), payload);
}
