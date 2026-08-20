// night.js — Crown Night fold (G3, spec §3.3). No DOM, no Firebase. Consecutive
// games with carried teams accumulate a night tally of crowns (game wins);
// first team to 3 is Champion of the Night. The tally rides the room chain that
// already survives next_game (couch: same room; h2h: the nextRoom pointer) and
// nowhere else — no localStorage: a night that ends when everyone goes home is
// a feature, not a bug (§3.3).

import { standings } from "./game.js";
import { h2hWinner } from "./h2h.js";

export const NIGHT_VERSION = 1;
export const CROWNS_TO_WIN = 3;

export function defaultNight() {
  return { v: NIGHT_VERSION, games: 0, crowns: {} };
}

// Malformed / absent / wrong-version `night` reads as a fresh night — the same
// tolerant posture as loadDailyResult (§3.3). Never throws, never half-trusts.
export function normalizeNight(night) {
  if (!night || typeof night !== "object" || night.v !== NIGHT_VERSION) {
    return defaultNight();
  }
  const crowns = {};
  const src = night.crowns || {};
  for (const id of Object.keys(src)) {
    if (typeof src[id] === "number" && Number.isFinite(src[id])) {
      crowns[id] = Math.max(0, Math.round(src[id]));
    }
  }
  return {
    v: NIGHT_VERSION,
    games: typeof night.games === "number" ? Math.max(0, Math.round(night.games)) : 0,
    crowns,
  };
}

// Who wins a game — standings leader, ties broken by the seeded deterministic
// coin flip h2h already uses, so every device agrees with no extra write. Used
// for BOTH modes: couch games gain the same tie-break so the crown has one
// winner even when the podium shows a true tie (§3.3).
export function gameWinner(teams, roomCode) {
  return h2hWinner(teams, roomCode);
}

// Increment the tally for a game won by winnerId (games+1, crowns[winner]+1).
// Written at game over (couch: host phone into the same room; h2h: computed
// locally by every device for display, since gameWinner is deterministic).
export function bumpNight(night, winnerId) {
  const n = normalizeNight(night);
  const crowns = { ...n.crowns };
  if (winnerId) crowns[winnerId] = (crowns[winnerId] || 0) + 1;
  return { v: NIGHT_VERSION, games: n.games + 1, crowns };
}

// The champion after a bump (crowns ≥ 3), or null. Ties for the championship
// can't happen — crowns are awarded one per game to one winner.
export function champion(night) {
  const n = normalizeNight(night);
  for (const id of Object.keys(n.crowns)) {
    if (n.crowns[id] >= CROWNS_TO_WIN) return id;
  }
  return null;
}

// The tally carried into the NEXT game: a fresh night after a champion is
// crowned, otherwise unchanged. Couch resets in-room at the next game start;
// the h2h next-room creator carries it (below).
export function nextNight(night) {
  return champion(night) ? defaultNight() : normalizeNight(night);
}

// The h2h next-room fold (spec §3.3): bump for the game just won, then reset if
// that crowned a champion. Single writer (the winner's phone), written into the
// new room before the nextRoom pointer.
export function carryNight(night, winnerId) {
  return nextNight(bumpNight(night, winnerId));
}

// One pure resolution of a game-over night, so the finish path and the
// refresh/resume path compute BYTE-IDENTICAL results (spec §3.3, R2). `night`
// is the room's seeded pre-bump tally (persisted in RTDB at game creation);
// `bumped` is the display tally for this game-over, `carry` is what the next
// game inherits, `champ` is the champion id (or null). Deterministic in
// (night, teams, roomCode) — a host refresh between games recomputes the same
// crown it showed before the reload, so the night survives a refresh.
export function gameNight(night, teams, roomCode) {
  const winner = gameWinner(teams, roomCode);
  const bumped = bumpNight(night, winner);
  return { winner, bumped, carry: nextNight(bumped), champ: champion(bumped) };
}

/* ================================================================
 * Formatting (team names ride these → the DOM nodes carry data-ph-mask, §3.3)
 * ================================================================ */

// [{ id, name, crowns }] sorted by crowns desc, then slot — for the tally line.
export function nightSummary(night, teams) {
  const n = normalizeNight(night);
  return Object.keys(n.crowns)
    .filter((id) => n.crowns[id] > 0)
    .map((id) => ({ id, name: (teams && teams[id] && teams[id].name) || id, crowns: n.crowns[id] }))
    .sort((a, b) => b.crowns - a.crowns || (a.id < b.id ? -1 : 1));
}

// "👑 Atlas Cats ×2 · Pin Pals ×1 — first to 3 takes the night" (lobby of
// game ≥ 2). Empty string before any crown is awarded (invisible until game 2).
export function tallyLineText(night, teams) {
  const rows = nightSummary(night, teams);
  if (rows.length === 0) return "";
  const parts = rows.map((r) => `${r.name} ×${r.crowns}`);
  return `👑 ${parts.join(" · ")} — first to ${CROWNS_TO_WIN} takes the night`;
}

// The game-over hook: "👑 Ana ×2 · Ben ×1 — Game 4?" on the primary sub-line.
export function crownHookText(night, teams, nextGameNumber) {
  const rows = nightSummary(night, teams);
  const parts = rows.map((r) => `${r.name} ×${r.crowns}`);
  const tally = parts.length ? `👑 ${parts.join(" · ")} — ` : "";
  return `${tally}Game ${nextGameNumber}?`;
}

// "👑 CHAMPION OF THE NIGHT — Atlas Cats" for the ceremony.
export function championText(name) {
  return `👑 CHAMPION OF THE NIGHT — ${name}`;
}
