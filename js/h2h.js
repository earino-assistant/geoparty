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

// A TV is "attached" while its heartbeat is fresher than this. The phones
// use it to adapt copy (and the reveal hold) — head-to-head is fully
// playable with no shared screen at all, e.g. two people over the internet.
export const SCREEN_STALE_MS = 30_000;

export function screenAttached(state, now) {
  const beat = state && state.screenHeartbeat;
  return typeof beat === "number" && now - beat < SCREEN_STALE_MS;
}

// Rivals' live pins, for this phone's own guess map — the phone-sized
// version of the TV panels. Pins are public until lock-in (gamesmanship by
// design: copying costs the time bonus the rival already spent), and a
// team's pin vanishes at lock-in because lockIn() nulls live/<tid>/pin.
export function liveRivalPins(round, myTeam) {
  // G2 Blind Duel: rival pins are hidden for the round (the twist rides the
  // round record, so every device suppresses them identically, §3.2).
  if (round && round.twist && round.twist.id === "blind") return [];
  const live = (round && round.live) || {};
  return Object.keys(live).sort()
    .filter((id) => id !== myTeam)
    .map((id) => ({ id, pin: live[id] && live[id].pin }))
    .filter((e) => e.pin &&
      typeof e.pin.lat === "number" && typeof e.pin.lng === "number")
    .map((e) => ({ id: e.id, lat: e.pin.lat, lng: e.pin.lng }));
}

// The closest (minimum-distance) real pin of a multi-team round — the pin an
// ACE burst rides on the TV reveal cascade (spec §3.4: "the TV shows the ACE
// burst when the closest pin lands"). If the closest pin is sub-1km the round
// has an ACE, because nothing is closer; if it isn't, no pin aced. Returns the
// km (or null when nobody pinned) so the renderer prices the medal + label.
// Ceremony only — this never touches points. Used by the h2h reveal and the
// couch Final Showdown cascade alike (R3/C2).
export function revealAceKm(round) {
  const results = (round && round.results) || {};
  let min = null;
  for (const id of Object.keys(results)) {
    const km = results[id] && results[id].distanceKm;
    if (typeof km === "number" && (min === null || km < min)) min = km;
  }
  return min;
}

// Real guesses for a reveal map, farthest first (the TV's draw order), so
// the phone reveal builds toward the winner too. Forfeits carry no pin.
// SUPER SURE status rides along: this is a REVEAL-ONLY surface (the bet is
// hidden on every in-play one), and the no-screen h2h phone map must show
// the bet's fate.
export function revealPins(round) {
  return revealOrder(round)
    .filter((r) => r.guess &&
      typeof r.guess.lat === "number" && typeof r.guess.lng === "number")
    .map((r) => ({
      id: r.id, lat: r.guess.lat, lng: r.guess.lng, distanceKm: r.distanceKm,
      superSure: !!r.superSure, superSureOutcome: r.superSureOutcome || null,
    }));
}

/* Movement-bounce regression guard: the pano viewer re-anchors ONLY when
 * the round's anchor image changes (new round, mid-round rejoin, fresh
 * viewer) — never because the player navigated. currentImageId tracks
 * where the player IS (movement lands on neighbor images); comparing it
 * against round.imageId snapped every forward step back to the anchor on
 * the next state echo (which arrives ≤4×/s from live writes). */
export function shouldReanchorViewer(anchoredImageId, currentImageId, roundImageId) {
  if (!roundImageId) return false;
  return anchoredImageId !== roundImageId;
}

// Did this pin's pano get navigated away from the round's anchor image?
// Feeds guess_submitted.moved — image ids only, never a location.
export function panoMoved(anchoredImageId, currentImageId) {
  return !!(anchoredImageId && currentImageId &&
    currentImageId !== anchoredImageId);
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

/* ================================================================
 * Round-timer expiry conduct (overnight bundle #2). Historically the h2h
 * round timer auto-locked a zero-point forfeit on every phone that hadn't
 * pinned, and the host phone force-swept stragglers — a hard cut nobody chose.
 * `autoSubmitOnTimeout` makes that an explicit, opt-in room setting; the
 * DEFAULT is OFF ("wait for players"), and OFF surfaces a voluntary give-up
 * instead of a forced forfeit. Couch (guess map after the buzzer) and Daily/
 * Hard (doctrine-fixed clocks) are untouched — this only governs h2h.
 * ================================================================ */

// Absent / legacy / garbage → false, so an existing room and an un-upgraded
// client both read OFF (the safe default). Only a strict `true` opts in.
export function normalizeAutoSubmit(value) {
  return value === true;
}

/* What a phone should do at/after the round clock runs out. Pure so both modes
 * are tested without a live room. Mirrors the legacy tick decisions exactly
 * when autoSubmit is ON.
 *   autoSubmit  the room's normalized autoSubmitOnTimeout
 *   expired     the round clock has passed 0 (endsAt && now >= endsAt)
 *   hasResult   this phone already submitted this round (never re-acts)
 *   isHost      this device holds host authority
 *   overGrace   now > endsAt + FORFEIT_GRACE_MS   (host sweep window)
 *   overGrace3  now > endsAt + FORFEIT_GRACE_MS*3 (host-died failover window)
 * Returns { autoLock, hostSweep, forceSweep, offerGiveUp }. */
export function expiryConduct({
  autoSubmit, expired, hasResult, isHost, overGrace, overGrace3,
}) {
  if (!autoSubmit) {
    // Wait-for-players: nothing is auto-locked and the clock never force-sweeps.
    // A phone with no result yet, once the clock is up, gets a give-up option.
    return {
      autoLock: false, hostSweep: false, forceSweep: false,
      offerGiveUp: expired === true && hasResult !== true,
    };
  }
  // Auto-lock mode reproduces the legacy behavior byte for byte:
  //   left<=0 & no result           → this phone auto-locks (forfeit if pinless)
  //   host & past grace             → host sweeps remaining stragglers
  //   non-host with a result & ×3   → steps up when the host's own phone died
  return {
    autoLock: expired === true && hasResult !== true,
    hostSweep: isHost === true && overGrace === true,
    forceSweep: isHost !== true && hasResult === true && overGrace3 === true,
    offerGiveUp: false,
  };
}

// May this phone voluntarily forfeit the current h2h round? Only in
// wait-for-players mode — auto-lock mode ends the round on the clock — while
// the round is live and this phone has no result yet.
export function canGiveUp({ autoSubmit, phase, hasResult }) {
  return autoSubmit !== true && phase === "roundActive" && hasResult !== true;
}

/* Next-game handoff guard (overnight bundle #3). When the winner opens the
 * "your game now" setup panel (screen p-setup) at game over, the OLD room is
 * still phase "gameOver" and its live subscription is still attached. A stray
 * echo of that state — another phone's heartbeat, a Firebase re-delivery —
 * must NOT re-render the game-over screen over the open handoff panel and make
 * the winner tap the button again. True when an incoming render for `phase`
 * would stomp the open handoff setup. */
export function stompsHandoff(phase, shownScreen) {
  return shownScreen === "p-setup" && phase === "gameOver";
}

// Reveal-time forfeit count (reveal_shown.forfeits): how many teams closed the
// round with no pin — a swept/timed-out/gave-up straggler. Aggregate only.
export function forfeitCount(round) {
  const results = (round && round.results) || {};
  let n = 0;
  for (const id of Object.keys(results)) {
    if (results[id] && !results[id].guess) n++;
  }
  return n;
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
