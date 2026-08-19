// h2h.js — shared head-to-head game logic. No DOM, no Firebase in here.
// Couch mode (game.js) is one-writer/many-readers; head-to-head is
// many-writers: every team phone owns its own subtree of the round
// (round/live/<tid>, round/results/<tid>, teams/<tid>) and the phase is
// advanced by whichever phone completes the set. This module holds the
// pure logic both the player phones and the TV renderer agree on.

import { teamIds, standings } from "./game.js";

// Head-to-head phase machine. There is no global "guessing" phase: each
// team flips between the pano and its own map asynchronously inside
// roundActive, and the round closes when every team has a result.
export const H2H_PHASES = ["lobby", "roundActive", "reveal", "gameOver"];

const H2H_TRANSITIONS = {
  lobby: ["roundActive"],
  roundActive: ["reveal"],
  reveal: ["roundActive", "gameOver"],
  gameOver: [], // a new game is a new room (nextRoom pointer)
};

export function h2hCanTransition(from, to) {
  return (H2H_TRANSITIONS[from] || []).includes(to);
}

export const MAX_TEAMS = 4;

// Countdown between "last team locked in" and the full reveal — long enough
// for every head to turn to the TV, short enough to stay electric.
export const REVEAL_COUNTDOWN_MS = 4000;

// Grace after the round timer before the host phone sweeps stragglers into
// forfeits: covers a phone that died or lost connectivity mid-round.
export const FORFEIT_GRACE_MS = 6000;

// First free team slot (t1..t4), or null when the room is full.
export function freeTeamSlot(teams) {
  const taken = new Set(teamIds(teams));
  for (let i = 1; i <= MAX_TEAMS; i++) {
    if (!taken.has(`t${i}`)) return `t${i}`;
  }
  return null;
}

// The team a device already owns in this room, or null.
export function teamForDevice(teams, deviceId) {
  if (!deviceId) return null;
  for (const id of teamIds(teams)) {
    if (teams[id] && teams[id].deviceId === deviceId) return id;
  }
  return null;
}

export function isHostDevice(state, deviceId) {
  return !!state && !!state.hostTeam &&
    teamForDevice(state.teams, deviceId) === state.hostTeam;
}

// Has every joined team submitted this round?
export function allSubmitted(teams, round) {
  const results = (round && round.results) || {};
  const ids = teamIds(teams);
  return ids.length > 0 && ids.every((id) => !!results[id]);
}

export function submittedCount(round) {
  return Object.keys((round && round.results) || {}).length;
}

// Teams still out — the phones show this list to build race pressure.
export function pendingTeams(teams, round) {
  const results = (round && round.results) || {};
  return teamIds(teams).filter((id) => !results[id]);
}

// Submit order (1-based rank for a team), by submittedAt. Rank badges on the
// TV panels and the phone's "Locked in! #2" moment come from this.
export function submitRank(round, teamId) {
  const results = (round && round.results) || {};
  const order = Object.keys(results)
    .sort((a, b) => (results[a].submittedAt || 0) - (results[b].submittedAt || 0));
  const i = order.indexOf(teamId);
  return i >= 0 ? i + 1 : null;
}

// Reveal draw order: farthest guess first, closest last, so the animation
// builds to the winner. Forfeits (no guess) lead off — dead weight first.
export function revealOrder(round) {
  const results = (round && round.results) || {};
  return Object.keys(results)
    .map((id) => ({ id, ...results[id] }))
    .sort((a, b) => {
      const da = a.guess ? a.distanceKm : Infinity;
      const db = b.guess ? b.distanceKm : Infinity;
      return db - da;
    });
}

// Closest real guess of the round (crown-wearer), or null if all forfeited.
export function roundClosest(round) {
  const order = revealOrder(round);
  const last = order[order.length - 1];
  return last && last.guess ? last.id : null;
}

// Small deterministic string hash (fnv-ish) for the tie-break coin flip.
function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* Winner of the game — the team that inherits host authority. Ties for
 * first are broken by a coin flip seeded from the room code and the tied
 * ids: deterministic, so every phone and the TV independently agree on the
 * same winner with no extra coordination write, and unbiased across rooms
 * because the code itself was random. The room never stalls on a tie. */
export function h2hWinner(teams, roomCode) {
  const ranked = standings(teams);
  if (ranked.length === 0) return null;
  const top = ranked.filter((t) => t.total === ranked[0].total);
  if (top.length === 1) return top[0].id;
  const ids = top.map((t) => t.id).sort();
  return ids[hashStr(`${roomCode}|${ids.join(",")}`) % ids.length];
}

// Fresh head-to-head room state. `teams` may be pre-seeded (next-game
// handoff carries names + deviceIds over with totals reset).
export function initialH2hRoomState(settings, teams, hostTeam) {
  return {
    createdAt: Date.now(),
    mode: "h2h",
    phase: "lobby",
    settings,
    hostTeam,
    teams,
    round: null,
    poolCursor: 0,
    screenHeartbeat: null,
  };
}

// Teams carried into the next game: same slots, names and devices, zeroed
// scores. joinedAt survives so lobby ordering stays familiar.
export function carryTeams(teams) {
  const next = {};
  for (const id of teamIds(teams)) {
    const t = teams[id];
    next[id] = {
      name: t.name,
      total: 0,
      deviceId: t.deviceId || null,
      joinedAt: t.joinedAt || null,
    };
  }
  return next;
}
