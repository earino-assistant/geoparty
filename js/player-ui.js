// player-ui.js — head-to-head team phone controller. Unlike the couch host
// (single source of truth, writes and never re-reads), a head-to-head phone
// is one of up to four peers: it SUBSCRIBES to the room like the TV does,
// and only ever writes the paths its own team owns —
//   teams/<myTeam>            (claim / total)
//   round/live/<myTeam>       (throttled live mirror for the TV panel)
//   round/results/<myTeam>    (the locked-in guess)
// — plus the shared phase flips it is entitled to make: the current host
// phone starts rounds and advances past reveal, and whichever phone
// completes the submission set flips the room to reveal. Writes to disjoint
// paths never conflict, so N writers stay coherent without a referee.

import {
  readRoom,
  writeRoom,
  updateRoom,
  deleteRoom,
  subscribeRoom,
  claimTeamSlot,
  onConnectionChange,
} from "./firebase.js";
import {
  defaultNight, bumpNight, carryNight, champion,
  tallyLineText, crownHookText, championText, nightSummary,
} from "./night.js";
import {
  normalizeTwistSetting, drawTwist, twistRoundSeconds, twistMoveAllowed,
  twistedRoundScore, twistHudTag, twistRevealTag, twistCard,
} from "./twist.js";
import { revealDecoys } from "./decoy.js";
import { teamHex, phoneRevealScene } from "./revealmap.js";
import { renderRevealScene } from "./revealmap-ui.js";
import {
  MODIFIERS, availableModifiers, modifierInitialState, modifierFold,
  shouldCalloutModifier, calloutSpec, MODIFIER_SHEETS, sheetActions,
} from "./modifier.js";
import {
  showModifierCallout, dismissModifierCallout,
} from "./modifier-ui.js";
import {
  makeRoomCode,
  isValidRoomCode,
  haversineKm,
  scoreForDistance,
  bonusWindowMs,
  timeBonus,
  formatCountdown,
  formatDistance,
  revealResultLine,
  revealBoardRows,
  boardRowText,
  teamIds,
  standings,
  sanitizePose,
} from "./game.js";
import {
  h2hCanTransition,
  MAX_TEAMS,
  REVEAL_COUNTDOWN_MS,
  FORFEIT_GRACE_MS,
  freeTeamSlot,
  teamForDevice,
  allSubmitted,
  submittedCount,
  pendingTeams,
  submitRank,
  revealOrder,
  h2hWinner,
  initialH2hRoomState,
  carryTeams,
  screenAttached,
  liveRivalPins,
  revealPins,
  shouldReanchorViewer,
  panoMoved,
  normalizeAutoSubmit,
  expiryConduct,
  canGiveUp,
  forfeitCount,
  stompsHandoff,
} from "./h2h.js";
import {
  superSureAvailable,
  resolveSuperSure,
  superSureSettlement,
} from "./supersure.js";
import {
  HINT_CARDS,
  LOCK_LABELS,
  guessMapHintLines,
  lockNowEstimate,
  lockButtonLabel,
  panoHintCard,
} from "./hints.js";
import {
  oneShotHint,
  showHintCard,
  dismissHintCard,
  hintCardOpen,
  paintLockButton,
} from "./hints-ui.js";
import {
  autoAdvancePatch,
  autoAdvanceStatus,
  shouldAutoAdvance,
  advanceTarget,
  advanceSecondsLeft,
  countdownText,
  holdAdvancePatch,
} from "./autoadvance.js";
import { withUtm, partyShareText, foldBestMoment, winBragText } from "./share.js";
import { shareResult, shareTvLink } from "./share-ui.js";
import { screenLink, tvBrowserLine, phoneJoinLine } from "./tvlink.js";
import { countdownTick, winLine, celebrationSpec } from "./fx.js";
import { initSound, playSound, buzz, stampFlash, spawnConfetti } from "./fx-ui.js";
import {
  loadRecords, saveRecords, applyPartyGuess, medalForDistance,
} from "./records.js";
import { loadPool, PoolSampler, normalizeDifficulty } from "./pool.js";
import {
  lastTeam, randomPun, recentTeams, rememberTeam, suggestTeams,
} from "./team-names.js";
import { scrubErrorMessage } from "./imagery.js";
import { drawQr } from "./qr.js";
import { track } from "./consent.js";
import { setActiveScreen } from "./chrome-ui.js";
import { createViewer, loadRoundImage } from "./viewer-ui.js";
import { toastWithReport, toastPlain } from "./report-ui.js";

/* ================================================================
 * DOM helpers
 * ================================================================ */

const $ = (id) => document.getElementById(id);
const SCREENS = [
  "p-home", "p-setup", "p-lobby", "p-round", "p-guess",
  "p-locked", "p-reveal", "p-gameover",
];

let shownScreen = null;
function showScreen(id) {
  shownScreen = id;
  dismissHintCard(); // a hint never outlives the moment it teaches
  for (const s of SCREENS) $(s).classList.toggle("hidden", s !== id);
  // §4.1: the utility corners (🍪/🔊) leave while a play screen is up, and
  // a deferred first-run consent ask waits for a calm one (§6.5).
  setActiveScreen(id);
}

let toastTimer = null;
// `reportCtx` turns this into the REACTIVE report surface (plan §10.1 as
// reconciled with the UI/UX review): an inline action on the toasts that
// already fire for a broken/degraded imagery condition — and nowhere else.
function toast(msg, reportCtx) {
  const el = $("toast");
  if (reportCtx) toastWithReport(el, msg, reportCtx); else toastPlain(el, msg);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => el.classList.remove("show"), reportCtx ? 6000 : 2500);
}

// One degraded-imagery nudge per game.
let degradedNoticeShown = false;
function noticeDegradedImagery(skips) {
  if (degradedNoticeShown || skips < 2) return;
  degradedNoticeShown = true;
  toast("Some images wouldn’t load — we skipped ahead.", { surface: "player" });
}

// Retryable imagery-degraded overlay (stabilization: review P2-1). Round
// start is host-only; a stub viewer or a transient timeout there hands back
// NO entry with `degraded: true`. That is NOT pool exhaustion, so the host
// must NOT push {phase:"gameOver"} — which would end the game for the whole
// room with a fabricated winner. Nothing is pushed; the host retries and the
// other phones keep waiting. Injected, no team name → nothing new to mask.
let degradedEl = null;
function showImageryDegraded(onRetry) {
  if (!degradedEl) {
    degradedEl = document.createElement("div");
    degradedEl.className = "imagery-degraded";
    const p = document.createElement("p");
    p.textContent =
      "Couldn’t load the imagery. Nobody was scored — check your connection " +
      "and try again.";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-primary";
    btn.textContent = "Retry";
    btn.addEventListener("click", () => {
      hideImageryDegraded();
      if (typeof degradedEl._retry === "function") degradedEl._retry();
    });
    degradedEl.append(p, btn);
    document.body.appendChild(degradedEl);
  }
  degradedEl._retry = onRetry;
  degradedEl.classList.remove("hidden");
}
function hideImageryDegraded() {
  if (degradedEl) degradedEl.classList.add("hidden");
}

function wireSeg(segId) {
  const seg = $(segId);
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    seg.dataset.value = btn.dataset.v;
    for (const b of seg.querySelectorAll("button")) {
      b.classList.toggle("sel", b === btn);
    }
  });
}

/* ================================================================
 * localStorage: device identity, active game, janitor bookkeeping
 * ================================================================ */

const LS_DEVICE = "geoparty_device_id";
const LS_H2H_ACTIVE = "geoparty_h2h_active";
const LS_MY_ROOMS = "geoparty_my_rooms"; // shared with host.html's janitor

const lsGet = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
};
const lsSet = (key, val) => localStorage.setItem(key, JSON.stringify(val));

// A phone IS its team's controller: identity is a persistent random device
// id. The room maps teams to device ids, so a refreshed (or rotated-to)
// phone is recognized without accounts or pairing codes.
function getDeviceId() {
  let id = localStorage.getItem(LS_DEVICE);
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) ||
      `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(LS_DEVICE, id);
  }
  return id;
}
const deviceId = getDeviceId();

async function janitor() {
  const mine = lsGet(LS_MY_ROOMS, []);
  const keep = [];
  for (const entry of mine) {
    if (Date.now() - entry.createdAt > 86_400_000) {
      try { await deleteRoom(entry.code); }
      catch (e) { console.warn("janitor: could not delete", scrubErrorMessage(e)); }
    } else {
      keep.push(entry);
    }
  }
  lsSet(LS_MY_ROOMS, keep);
}

/* ================================================================
 * Session state
 * ================================================================ */

let roomCode = null;
let myTeam = null;
let room = null;           // latest subscribed state (server-authoritative)
let unsubRoom = null;
let switchingRooms = false;

let sampler = null;        // host-only pool sampler (lazy)
let pool = null;

let iv = null;             // instrumented viewer wrapper (viewer-ui.js)
let viewer = null;         // its raw MapillaryJS viewer (this phone's eyes)
let panoRoundSeen = null;  // round whose pano_session fold is already open
let currentImageId = null; // where the player IS (movement lands on neighbors)
let anchoredImageId = null; // the round anchor the viewer was last sent to
let guessMap = null;
let guessMarker = null;
let rivalMarkers = {};     // tid -> live rival pin on MY guess map
let revealHandle = null;   // per-round reveal map (phone-sized TV reveal)
let revealMapShownFor = null; // round number the reveal map was built for

let myBest = null;         // my team's closest guess — the share card brag (S1)
let localStage = "explore"; // "explore" (pano) | "map" — this phone's UI mode
let lastRoundSeen = null;   // round number the UI has been reset for
// The guess-modifier deploy state (one fold for SUPER SURE arming AND the
// Decoy plant machine; js/modifier.js). Local until lock-in, so rivals can't
// see a bet coming, and reset per round. The decoy's own marker/coords are
// separate render state (the fold tracks only armed/planted). The decoy rides
// the live feed as an ordinary pin (hidden in play by construction); the real
// pin never rides once a decoy is planted.
let deployState = modifierInitialState();
let decoyMarker = null;
let decoyPin = null;
let autoSubmitted = false;  // timeout auto-lock fired for this round
let sweepDone = false;      // host forfeit sweep fired for this round
let revealFlipPushed = null; // round number this phone already flipped for
let revealTracked = null;   // round number reveal_shown was captured for (host)
let autoAdvanceFired = null; // round number the S6 auto-advance fired for
let prevSubmitted = 0;      // for "Team X locked in!" toasts
let tickInterval = null;
let revealFlipTimer = null; // phone-side hold during the TV countdown
let lastTickSecond = null;  // S4: last countdown second the phone ticked for
let revealTickSecond = null; // S4: same, for the no-TV reveal 3-2-1
let stungFor = null;        // S4: round number the reveal sting played for
let acedFor = null;         // G4: round number the ACE stamp fired for
let fanfarePlayed = false;  // S4: game-over fanfare, once per room
let winCelebrated = false;  // win celebration: confetti + buzz, once per room

const isHost = () => !!room && room.hostTeam === myTeam;
const myResult = () =>
  (room && room.round && room.round.results && room.round.results[myTeam]) || null;

function push(patch) {
  updateRoom(roomCode, patch).catch((e) => {
    console.warn("Firebase write failed (continuing locally):", scrubErrorMessage(e));
  });
}

function persistActive() {
  lsSet(LS_H2H_ACTIVE, { code: roomCode, teamId: myTeam, createdAt: Date.now() });
}

/* ================================================================
 * Room lifecycle: create / join / follow / leave
 * ================================================================ */

// One settings panel serves both flows now (review §6.2), so there is one
// set of segment ids instead of the two identical sets this page carried.
function collectSettings() {
  return {
    roundCount: parseInt($("pSegRounds").dataset.value, 10),
    roundSeconds: parseInt($("pSegSeconds").dataset.value, 10),
    moveAllowed: $("pSegMove").dataset.value === "1",
    difficulty: normalizeDifficulty($("pSegDifficulty").dataset.value),
    twists: normalizeTwistSetting(   // G2
      $("pSegTwists") ? $("pSegTwists").dataset.value : "occasional"),
    // Overnight bundle #2: default OFF ("wait for players"). Absent segment or
    // any non-"1" value normalizes to false via normalizeAutoSubmit on read.
    autoSubmitOnTimeout:
      !!($("pSegAutoSubmit") && $("pSegAutoSubmit").dataset.value === "1"),
  };
}

/* The join/create split (review §6.2 / §3 hotspot 2). The joiner — the
 * majority, arriving from a QR or an invite link — needs two fields, and
 * used to face the full game-setup wall plus two competing primary buttons.
 * Now: panel 1 is the join, panel 2 is the settings, and the SAME panel 2
 * serves the winner's next-game setup (which used to be a third copy of
 * the same four segment groups).
 *
 * The team-name input is one DOM node moved between the panels rather than
 * duplicated — one field, one value, no sync bug. */
let setupMode = "new"; // "new" (start a party) | "next" (winner's handoff)

function showHome() {
  const group = $("pTeamNameGroup");
  group.classList.remove("hidden"); // the "next game" panel hides it
  $("p-home").querySelector(".host-wrap").insertBefore(group, $("pJoinGroup"));
  showScreen("p-home");
}

function openSetup(mode) {
  setupMode = mode === "next" ? "next" : "new";
  const wrap = $("p-setup").querySelector(".host-wrap");
  const next = setupMode === "next";
  $("pSetupTitle").textContent = next ? "👑 Your game now" : "Start a new game";
  $("pSetupNote").textContent = next
    ? "Same teams, fresh scores. Every phone and the TV follow automatically."
    : "";
  $("pSetupNote").classList.toggle("hidden", !next);
  $("btnSetupBack").classList.toggle("hidden", next);
  // The winner already has a team name; the party starter still needs one.
  if (next) {
    $("pTeamNameGroup").classList.add("hidden");
  } else {
    $("pTeamNameGroup").classList.remove("hidden");
    wrap.insertBefore($("pTeamNameGroup"), $("pSetupTitle").nextSibling);
  }
  showScreen("p-setup");
}

// Team-roster brief, extended to the h2h joiner (owner: pre-fill + 🎲 pun +
// inline type-ahead only — no permanent/collapsible roster UI). One input,
// unlike the couch's per-team rows, so no active-input tracking is needed.
function hideTeamSuggestions() {
  const el = $("pTeamSuggestions");
  el.innerHTML = "";
  el.classList.add("hidden");
}

function renderTeamSuggestions() {
  const input = $("myTeamName");
  const el = $("pTeamSuggestions");
  const matches = suggestTeams(input.value);
  el.innerHTML = "";
  if (!matches.length) { el.classList.add("hidden"); return; }
  const recentLower = new Set(recentTeams().map((n) => n.toLowerCase()));
  for (const match of matches) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = match;
    // mousedown (not click) fires before the input's blur, and preventDefault
    // keeps focus on the input so hideTeamSuggestions below can't race a blur.
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      input.value = match;
      input.dataset.source = recentLower.has(match.toLowerCase()) ? "recent" : "pun";
      hideTeamSuggestions();
    });
    el.appendChild(btn);
  }
  el.classList.remove("hidden");
}

// Persists the name for next time (pre-fill + suggestions) and reports
// whether the pun bank / suggestions cut typing — mirrors host-ui.js's
// collectTeams(), called once the name is actually committed to a room.
function commitTeamName(name) {
  const input = $("myTeamName");
  const source = input.dataset.source === "pun" || input.dataset.source === "recent"
    ? input.dataset.source : "typed";
  rememberTeam(name);
  track("team_name_used", { mode: "h2h", source });
}

// The ghost "Start a new game →": a deliberate action, and the one place
// that gates on a team name before the settings are worth filling in.
function startNewGame() {
  if (!$("myTeamName").value.trim()) {
    toast("Give your team a name first");
    $("myTeamName").focus();
    return;
  }
  openSetup("new");
}

async function pickFreeRoomCode() {
  let code = makeRoomCode();
  for (let i = 0; i < 5; i++) {
    try {
      const existing = await Promise.race([
        readRoom(code),
        new Promise((res) => setTimeout(() => res(null), 1500)),
      ]);
      if (!existing) break;
    } catch { break; }
    code = makeRoomCode();
  }
  return code;
}

async function createRoom() {
  const name = $("myTeamName").value.trim();
  if (!name) { toast("Give your team a name first"); return; }
  $("btnOpenRoom").disabled = true;
  try {
    const code = await pickFreeRoomCode();
    const teams = {
      t1: { name, total: 0, deviceId, joinedAt: Date.now() },
    };
    const state = initialH2hRoomState(collectSettings(), teams, "t1");
    writeRoom(code, state).catch((e) =>
      console.warn("Firebase write failed:", scrubErrorMessage(e)));
    const mine = lsGet(LS_MY_ROOMS, []);
    mine.push({ code, createdAt: state.createdAt });
    lsSet(LS_MY_ROOMS, mine);
    track("game_created", {
      room: code,
      mode: "h2h",
      num_teams: 1, // teams join the lobby after creation
      num_rounds: state.settings.roundCount,
      round_seconds: state.settings.roundSeconds,
      difficulty: state.settings.difficulty,
      auto_submit: normalizeAutoSubmit(state.settings.autoSubmitOnTimeout),
    });
    commitTeamName(name);
    track("team_joined", { mode: "h2h", team_count: 1 });
    enterRoom(code, "t1");
  } catch (e) {
    console.error(scrubErrorMessage(e));
    toast("Couldn't start the party — check your connection and try again.");
  } finally {
    $("btnOpenRoom").disabled = false;
  }
}

async function joinRoom() {
  const code = $("joinCode").value.trim().toUpperCase();
  const name = $("myTeamName").value.trim();
  const err = $("joinErr");
  err.textContent = "";
  if (!isValidRoomCode(code)) { err.textContent = "That's not a room code."; return; }
  if (!name) { err.textContent = "Give your team a name first."; return; }
  $("btnJoin").disabled = true;
  try {
    const state = await readRoom(code);
    if (!state) { err.textContent = "Room not found — check the code."; return; }
    if (state.mode !== "h2h") {
      err.textContent = "That code is for a one-phone party — nothing to join from your phone.";
      return;
    }
    // Refresh / phone re-entry: this device already owns a team here.
    const mine = teamForDevice(state.teams, deviceId);
    if (mine) { enterRoom(code, mine); return; }
    if (state.phase !== "lobby") {
      err.textContent = "That game already started — ask for a new code when the next one begins.";
      return;
    }
    // Claim the first free slot atomically; retry on the next if raced.
    let claimed = null;
    let teamCount = 0;
    for (let attempt = 0; attempt < MAX_TEAMS && !claimed; attempt++) {
      const fresh = attempt === 0 ? state : (await readRoom(code)) || state;
      const slot = freeTeamSlot(fresh.teams);
      if (!slot) break;
      const ok = await claimTeamSlot(code, slot, {
        name, total: 0, deviceId, joinedAt: Date.now(),
      });
      if (ok) {
        claimed = slot;
        teamCount = teamIds(fresh.teams).length + 1;
      }
    }
    if (!claimed) { err.textContent = "Room is full (4 teams max)."; return; }
    commitTeamName(name);
    track("team_joined", { mode: "h2h", team_count: teamCount });
    enterRoom(code, claimed);
  } catch (e) {
    console.error(scrubErrorMessage(e));
    err.textContent = "Could not join — try again.";
  } finally {
    $("btnJoin").disabled = false;
  }
}

function enterRoom(code, teamId) {
  if (unsubRoom) { unsubRoom(); unsubRoom = null; }
  destroyViewer();
  clearRivalPins();
  destroyRevealMap();
  roomCode = code;
  myTeam = teamId;
  room = null;
  sampler = null;
  myBest = null;
  lastRoundSeen = null;
  autoSubmitted = false;
  sweepDone = false;
  revealFlipPushed = null;
  revealTracked = null;
  autoAdvanceFired = null;
  prevSubmitted = 0;
  stungFor = null;
  acedFor = null;
  fanfarePlayed = false;
  winCelebrated = false;
  localStage = "explore";
  deployState = modifierInitialState();
  switchingRooms = false;
  persistActive();
  let sawState = false;
  unsubRoom = subscribeRoom(code, (state) => {
    if (switchingRooms || code !== roomCode) return;
    if (!state) {
      if (sawState) { leaveToHome("The room was closed."); }
      else { leaveToHome("Room not found."); }
      return;
    }
    sawState = true;
    onState(state);
  });
}

// The winner spawned the next game: everyone else's phone (and the TV)
// follows the nextRoom pointer, re-recognized by device id — nobody types
// anything. This is the self-organizing handoff.
async function followNextRoom(code) {
  switchingRooms = true;
  try {
    let state = null;
    for (let i = 0; i < 5 && !state; i++) {
      state = await readRoom(code).catch(() => null);
      if (!state) await new Promise((r) => setTimeout(r, 800));
    }
    const mine = state && teamForDevice(state.teams, deviceId);
    if (!mine) { leaveToHome("Couldn't follow into the next game."); return; }
    toast("Following the winner…");
    enterRoom(code, mine);
  } catch (e) {
    console.error(scrubErrorMessage(e));
    leaveToHome();
  }
}

function leaveToHome(message) {
  if (unsubRoom) { unsubRoom(); unsubRoom = null; }
  stopTick();
  stopAdvanceTicker();
  clearTimeout(revealFlipTimer);
  destroyViewer();
  clearRivalPins();
  destroyRevealMap();
  cancelLiveWrite();
  localStorage.removeItem(LS_H2H_ACTIVE);
  roomCode = null;
  myTeam = null;
  room = null;
  switchingRooms = false;
  showHome();
  renderResumeBanner();
  if (message) toast(message);
}

async function leaveOrAbandon() {
  if (!room) { leaveToHome(); return; }
  if (isHost()) {
    // Host abandoning the lobby kills the room for everyone.
    track("game_abandoned", {
      room: roomCode,
      mode: "h2h",
      rounds_played: room.round ? room.round.number : 0,
    });
    try { await deleteRoom(roomCode); } catch (e) { console.warn(scrubErrorMessage(e)); }
    const mine = lsGet(LS_MY_ROOMS, []).filter((r) => r.code !== roomCode);
    lsSet(LS_MY_ROOMS, mine);
    leaveToHome();
  } else {
    // A member leaving the lobby frees their slot for someone else.
    if (room.phase === "lobby") {
      try { await updateRoom(roomCode, { [`teams/${myTeam}`]: null }); }
      catch (e) { console.warn(scrubErrorMessage(e)); }
    }
    leaveToHome();
  }
}

/* ================================================================
 * State-driven render (every phone, host included, renders from
 * the subscription — local writes echo back through it)
 * ================================================================ */

function onState(state) {
  room = state;

  // Follow the winner's next game from the game-over screen.
  if (state.phase === "gameOver" && typeof state.nextRoom === "string" &&
      isValidRoomCode(state.nextRoom) && state.nextRoom !== roomCode) {
    followNextRoom(state.nextRoom);
    return;
  }

  // My team vanished (host abandoned & recreated, or slot removed).
  if (!state.teams || !state.teams[myTeam] ||
      (state.teams[myTeam].deviceId &&
       state.teams[myTeam].deviceId !== deviceId)) {
    leaveToHome("You're no longer in this room.");
    return;
  }

  // Deadlock guard: when the last two phones lock in near-simultaneously
  // (the timeout auto-submit makes this the COMMON case), each computes the
  // "am I last?" check in lockIn from a snapshot that predates the other's
  // result, so neither flips the room to reveal — and the sweep won't
  // either, since nothing is pending. Any phone that later SEES the
  // complete result set while the phase is still roundActive closes the
  // round. Racing closers write the same shape, so duplicates are harmless.
  if (state.phase === "roundActive" && state.round &&
      allSubmitted(state.teams, state.round) &&
      revealFlipPushed !== state.round.number) {
    revealFlipPushed = state.round.number;
    const revealAt = Date.now() + REVEAL_COUNTDOWN_MS;
    push({
      phase: "reveal",
      "round/revealAt": revealAt,
      // S6: the soft auto-advance deadline rides every reveal flip, anchored
      // where the reveal becomes visible (after the 3-2-1). Racing closers
      // differ by milliseconds — the accepted revealAt collision.
      ...autoAdvancePatch(revealAt),
      // Settle any SUPER SURE bets in the same atomic patch (see lockIn):
      // racing closers compute identical values from the complete set.
      ...superSureSettlement(state.teams, state.round.results).patch,
    });
  }

  // Race-pressure toast: someone else locked in.
  const nowSubmitted = submittedCount(state.round);
  if (state.phase === "roundActive" && nowSubmitted > prevSubmitted) {
    const results = (state.round && state.round.results) || {};
    for (const id of Object.keys(results)) {
      if (id !== myTeam && submitRank(state.round, id) === nowSubmitted &&
          nowSubmitted !== prevSubmitted) {
        if (!myResult()) toast(`${state.teams[id].name} locked in!`);
        break;
      }
    }
  }
  prevSubmitted = nowSubmitted;

  // Overnight bundle #3: once the winner opens the next-game setup panel, the
  // old room is still "gameOver" and its subscription is still live. A stray
  // echo (another phone's heartbeat, a Firebase re-delivery) must not re-render
  // the game-over screen over the open handoff panel and make them tap again.
  // The nextRoom-follow and team-vanished guards above still run first.
  if (stompsHandoff(state.phase, shownScreen)) return;

  switch (state.phase) {
    case "lobby": renderLobby(); break;
    case "roundActive": renderRoundActive(); break;
    case "reveal": renderReveal(); break;
    case "gameOver": renderGameOver(); break;
    default: break;
  }
  if (state.phase !== "roundActive" && state.phase !== "reveal") stopTick();
  if (state.phase !== "reveal") stopAdvanceTicker();
}

/* ---------------- Lobby ---------------- */

function renderLobby() {
  lastRoundSeen = null;
  if (shownScreen !== "p-lobby") {
    showScreen("p-lobby");
    $("pRoomCodeHuge").textContent = roomCode;
    $("pRoomCodeHuge").classList.remove("skeleton"); // P1.7: real value has landed
    const joinUrl = new URL(`player.html?room=${roomCode}`, location.href).href;
    $("pJoinUrl").textContent = phoneJoinLine(location.href, roomCode);
    drawQr($("pQrCanvas"), joinUrl);
    // The Add a TV panel: scan-and-cast QR, plus the typing fallback line
    // (hidden on file://, where there's nothing typeable to point at).
    drawQr($("pTvQr"), screenLink(location.href, roomCode, "qr"));
    $("pTvType").textContent = tvBrowserLine(location.href) || "";
  }

  // TV presence comes free with the room subscription (screenHeartbeat).
  // A TV is a bonus, never a requirement: remote rivals join by link and
  // every phone carries its own reveal — so the whole affordance collapses
  // to a checkmark the moment a screen attaches.
  const attached = screenAttached(room, Date.now());
  $("pTvAdd").classList.toggle("hidden", attached);

  const list = $("pLobbyTeams");
  list.innerHTML = "";
  const ids = teamIds(room.teams);
  ids.forEach((id) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent =
      room.teams[id].name +
      (id === myTeam ? " (you)" : "") +
      (id === room.hostTeam ? " · host" : "");
    name.style.color = teamHex(room.teams, id);
    const tag = document.createElement("span");
    tag.textContent = "ready";
    tag.style.color = "var(--muted)";
    li.append(name, tag);
    list.appendChild(li);
  });

  const host = isHost();
  $("btnPStart").classList.toggle("hidden", !host);
  $("btnPLeave").textContent = host ? "Close the room" : "Leave";
  // §2.4: ONE status line. The TV state used to be a second stacked muted
  // line above this one; it folds in as a suffix instead.
  const base = host
    ? (ids.length < 2
        ? "Start solo, or wait for rivals — they join with the QR."
        : `${ids.length} teams in — start when everyone's ready.`)
    : `Waiting for ${room.teams[room.hostTeam] ? room.teams[room.hostTeam].name : "the host"} to start…`;
  const note = $("pLobbyNote");
  // G3 (C5): the night tally rides the nextRoom chain into game ≥ 2's lobby —
  // one muted line folded into the existing status (§3.3), never a new element.
  const tally = tallyLineText(room.night, room.teams);
  const status = attached ? `${base} · TV ✓` : base;
  note.textContent = tally ? `${tally} · ${status}` : status;
  note.classList.toggle("ok", attached);
}

// Remote play: the QR only works across a table — a rival across the
// internet gets the join link by share sheet (or clipboard fallback).
async function shareInvite() {
  if (!roomCode) return;
  const url = new URL(`player.html?room=${roomCode}`, location.href).href;
  if (navigator.share) {
    try {
      await navigator.share({
        title: "GeoParty",
        text: `Join my GeoParty — room ${roomCode}`,
        url,
      });
      track("invite_shared", { mode: "h2h", method: "share" });
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return; // user closed the sheet
      // Share sheet unavailable/failed: fall through to the clipboard.
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Invite link copied");
    track("invite_shared", { mode: "h2h", method: "copy" });
  } catch {
    toast(`Send this link: ${url}`);
  }
}

/* ---------------- Round start (host only) ---------------- */

async function ensureSampler() {
  if (!pool) pool = await loadPool();
  // Legacy rooms carry no difficulty and must rebuild their legacy order.
  if (!sampler) {
    sampler = new PoolSampler(pool, roomCode, room.poolCursor || 0,
      (room.settings && room.settings.difficulty) || null);
  }
}

async function startRound(advance) {
  if (!isHost() || !h2hCanTransition(room.phase, "roundActive")) return;
  // "auto"/"manual" from nextOrFinish; the lobby's round 1 (a click event
  // lands here) follows no reveal and carries no advance property.
  const via = advance === "auto" || advance === "manual" ? advance : null;
  $("btnPStart").disabled = true;
  $("btnPNext").disabled = true;
  try {
    await ensureSampler();
    // The host phone validates imagery before committing the round, same
    // dead-image skip as couch mode — everyone else just follows imageId.
    showScreen("p-round");
    // The host phone shows the pano screen before the state echoes back,
    // so renderRoundActive's screen-change guard won't fire this for it. #7:
    // the pano card teaches the arrows when movement is allowed (round 1 is
    // twist-free, so the game-wide lever is the movement state here).
    oneShotHint("pano", panoHintCard(room.settings.moveAllowed));
    if (!iv) makeViewer();
    panoRoundSeen = (room.round ? room.round.number : 0) + 1;
    iv.beginRound(panoRoundSeen);
    // Same dead-image skip loop as before, now shared and instrumented.
    const { entry, skips, degraded } = await loadRoundImage(sampler, iv, "anchor");
    noticeDegradedImagery(skips);
    if (!entry) {
      if (degraded) {
        // Retryable imagery failure (stub viewer / transient timeout), NOT
        // pool exhaustion: nothing was pushed, so the room stays where it is.
        // Never push gameOver here (review P2-1) — that would end the game for
        // every phone with a fabricated winner. The host retries.
        // Drop a stub viewer so the retry rebuilds it (the SDK may load late);
        // a transient timeout keeps its working viewer.
        if (iv && iv.ok === false) destroyViewer();
        showImageryDegraded(() => startRound(advance));
        return;
      }
      toast("We're out of new places — final scores!", { surface: "player" });
      const winner = h2hWinner(room.teams, roomCode);
      push({ phase: "gameOver", hostTeam: winner });
      track("game_completed", {
        room: roomCode,
        mode: "h2h",
        rounds: room.round ? room.round.number : 0,
        winner_team: winner,
        winning_score: room.teams[winner] ? room.teams[winner].total : 0,
        team_count: teamIds(room.teams).length,
      });
      return;
    }
    currentImageId = entry.image_id;
    anchoredImageId = entry.image_id;
    sampler.advance();

    const now = Date.now();
    const number = (room.round ? room.round.number : 0) + 1;
    // G2: the hostTeam phone draws the twist (deterministic, standings-free)
    // and writes it into the round; every other phone reads round.twist and
    // never redraws. Long Haul rides the tested gentler curve on the normal
    // supply here (its dedicated expert sampler is a documented follow-up).
    const prevTwist = room.round && room.round.twist ? room.round.twist.id : null;
    const twistId = drawTwist({
      roomCode, roundNumber: number, roundCount: room.settings.roundCount,
      mode: "h2h", moveAllowed: room.settings.moveAllowed,
      difficulty: room.settings.difficulty, twists: room.settings.twists,
      prevTwistId: prevTwist, isShowdown: false,
      numTeams: teamIds(room.teams).length,
      poolScored: true, longHaulExhausted: false,
    });
    const secs = twistRoundSeconds(room.settings, twistId);
    // Truth rides in the round: with it, every phone scores itself at
    // submit time — no central scorer, no pool download on member phones.
    // (Peeking at devtools mid-party is not a threat model we carry.)
    const round = {
      number,
      imageId: entry.image_id,
      startedAt: now,
      endsAt: secs > 0 ? now + secs * 1000 : null,
      truth: { lat: entry.lat, lng: entry.lng, name: entry.name || null },
      live: null,
      results: null,
      revealAt: null,
      twist: twistId ? { id: twistId } : null,   // G2
    };
    push({ phase: "roundActive", round, poolCursor: sampler.cursor });
    // #5: the starter applies the drawn twist's movement lever LOCALLY now,
    // rather than waiting for its own Firebase write to echo back through
    // renderRoundActive — otherwise a Frozen round briefly allows movement on
    // the starter's phone until the echo lands. Every other phone still reads
    // round.twist from the echo, as before.
    if (iv && iv.setMoveAllowed) {
      iv.setMoveAllowed(twistMoveAllowed(room.settings, twistId));
    }
    track("round_started", {
      room: roomCode, mode: "h2h", round_number: number,
      ...(via ? { advance: via } : {}),
      ...(twistId ? { twist: twistId } : {}),   // G2
    });
  } catch (e) {
    console.error(scrubErrorMessage(e));
    toast("Could not start the round");
  } finally {
    $("btnPStart").disabled = false;
    $("btnPNext").disabled = false;
  }
}

/* ---------------- Round active: explore / map / locked ---------------- */

function renderRoundActive() {
  const round = room.round;
  if (!round) return;

  if (round.number !== lastRoundSeen) {
    // New round: reset this phone's local play state.
    lastRoundSeen = round.number;
    autoSubmitted = false;
    sweepDone = false;
    hideGiveUp(); // #2: a stale give-up affordance never carries into a round
    localStage = "explore";
    // Reset the whole modifier deploy state (bet + decoy) — round-local, never
    // carried over. A stale callout never outlives the round either.
    deployState = modifierFold(deployState, { type: "newRound" }).state;
    dismissModifierCallout();
    lastTickSecond = null;
    revealTickSecond = null;
    clearTimeout(revealFlipTimer);
    if (guessMarker) { guessMarker.remove(); guessMarker = null; }
    if (decoyMarker) { decoyMarker.remove(); decoyMarker = null; }
    decoyPin = null;
    clearRivalPins();
    if (guessMap) guessMap.setView([25, 10], 2);
    $("btnLockIn").disabled = true;
    updateLockButton();
    updateGuessBanner();
    startTick();
    // G2: apply this round's twist locally (every phone reads round.twist) —
    // the card flip, and the Frozen movement lever.
    applyRoundTwist(round.twist ? round.twist.id : null);
  }

  // Rivals' pins land on MY map too (not just the TV panels), so the
  // stare-down works with no shared screen. onState fires on their every
  // throttled live write, so this tracks them at the same ≤4/s cadence.
  updateRivalPins();

  if (myResult()) {
    renderLockedScreen();
    return;
  }

  if (localStage === "map") {
    if (shownScreen !== "p-guess") openGuessMapScreen();
  } else {
    if (shownScreen !== "p-round") {
      showScreen("p-round");
      // First pano ever on this device: teach the loop's first move (M5) — and
      // the arrows when this round allows movement (#7).
      oneShotHint("pano", panoHintCard(
        twistMoveAllowed(room.settings, round.twist ? round.twist.id : null)));
      if (viewer) viewer.resize();
    }
    if (!iv) {
      makeViewer();
      // C5: makeViewer seeds movement from the game-wide moveAllowed, so a
      // Frozen round resumed/refreshed into (applyRoundTwist ran while iv was
      // still null) would silently re-enable street movement. Re-assert the
      // round's twist lever now that the viewer exists.
      if (iv && iv.setMoveAllowed) {
        iv.setMoveAllowed(
          twistMoveAllowed(room.settings, round.twist ? round.twist.id : null));
      }
    }
    // #5: reassert the movement lever every active-round render, so a transient
    // activateComponent failure recovers on a later render instead of stranding
    // the movement controls for the whole round. A no-op once it has stuck.
    if (iv && iv.reassertMove) iv.reassertMove();
    // One pano_session per round on THIS phone. startRound() only runs on
    // the h2h host, so without this every non-host player would be invisible
    // to the navigation/interaction panels.
    if (round.number !== panoRoundSeen) {
      panoRoundSeen = round.number;
      iv.beginRound(round.number);
    }
    // Re-anchor ONLY when the round's anchor changes (new round / rejoin /
    // fresh viewer). Comparing currentImageId here snapped every forward
    // move back to the anchor on the next state echo (movement bounce).
    if (iv && shouldReanchorViewer(anchoredImageId, currentImageId, round.imageId)) {
      const target = round.imageId;
      anchoredImageId = target;
      currentImageId = target;
      // The bounce-regression canary: every re-anchor during active play is
      // counted into pano_session.reanchors (plan §5/§7.2). The guard above
      // is untouched — the wrapper only observes it.
      iv.noteReanchor();
      iv.moveTo(target, "anchor").catch((e) => {
        // Raw SDK rejections carry the image id / a tokened URL, and console
        // capture rides into replays — log only the scrubbed message (P1-1).
        console.warn("player: image load failed —", scrubErrorMessage(e));
        toast("Imagery didn’t load — guess from the map.",
          { surface: "player" });
      });
    }
  }

  const twistId = round.twist ? round.twist.id : null;
  $("pHudRound").textContent =
    `Round ${round.number}/${room.settings.roundCount}` +
    (twistId ? ` · ${twistHudTag(twistId)}` : "");   // G2
  updateLockedHud();
}

// G2: the twist card flip (center overlay + scrim, ~2.5s, tap to skip) plus the
// Frozen movement lever. Injected overlay — no team name, so nothing to mask.
let twistCardEl = null;
let twistCardTimer = null;
function applyRoundTwist(twistId) {
  if (iv && iv.setMoveAllowed) {
    iv.setMoveAllowed(twistMoveAllowed(room.settings, twistId));
  }
  if (!twistId) return;
  const card = twistCard(twistId);
  if (!card) return;
  playSound("sting");
  if (!twistCardEl) {
    twistCardEl = document.createElement("div");
    twistCardEl.className = "twist-card-overlay";
    twistCardEl.addEventListener("click", () => twistCardEl.classList.add("hidden"));
    document.body.appendChild(twistCardEl);
  }
  twistCardEl.innerHTML = "";
  const title = document.createElement("div");
  title.className = "twist-card-title";
  title.textContent = card.card;
  const rule = document.createElement("div");
  rule.className = "twist-card-rule";
  rule.textContent = card.rule;
  twistCardEl.append(title, rule);
  twistCardEl.classList.remove("hidden");
  clearTimeout(twistCardTimer);
  twistCardTimer = setTimeout(() => twistCardEl.classList.add("hidden"), 2500);
}

function updateLockedHud() {
  const n = submittedCount(room.round);
  const total = teamIds(room.teams).length;
  $("pHudLocked").textContent = n > 0 ? `${n}/${total} locked in` : "";
}

function makeViewer() {
  destroyViewer();
  const moveAllowed = room.settings.moveAllowed;
  iv = createViewer({
    surface: "player",
    container: "playerViewer",
    moveAllowed,
    component: {
      cover: false,
      direction: moveAllowed,
      sequence: moveAllowed,
      keyboard: moveAllowed,
      zoom: true,
      bearing: true,
    },
  });
  viewer = iv.viewer;
  // Construction failed: viewer_init is reported and every moveTo rejects,
  // so the existing "guess from the map" degradation path takes over.
  if (!viewer) return;
  viewer.on("pov", scheduleLiveWrite);
  viewer.on("position", scheduleLiveWrite);
  viewer.on("image", (ev) => {
    // Movement (when allowed) navigates to neighbor images; the TV panel
    // follows this team's own imageId, independent of the other teams.
    currentImageId = ev.image.id;
    scheduleLiveWrite();
  });
}

function destroyViewer() {
  if (iv) {
    iv.destroy();   // flushes the open pano_session, then viewer.remove()
    iv = null;
  }
  viewer = null;
  currentImageId = null;
  anchoredImageId = null;
  panoRoundSeen = null;
}

function ensureGuessMap() {
  if (guessMap) return;
  guessMap = L.map("playerGuessMap", { worldCopyJump: true, zoomControl: false })
    .setView([25, 10], 2);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(guessMap);
  guessMap.on("moveend zoomend", scheduleLiveWrite);
  guessMap.on("click", (e) => {
    // While a decoy is armed-but-not-yet-planted, the FIRST tap plants the
    // decoy; every tap after places/moves the real pin (modifier.js → decoy.js
    // decides). Pin moves no longer dismiss a live callout (§A1.2): the pill is
    // the only door now, and adjusting a fresh pin must not kill it.
    const fold = modifierFold(deployState, { type: "tap" });
    deployState = fold.state;
    if (fold.place === "decoy") {
      placeDecoyMarker(e.latlng);
      // C5 (spec §3.7): the spend is recorded at PLANT time, not lock-in, so a
      // decoy stays spent across a refresh (deployState is local and lost on
      // reload) AND across a host forfeit-sweep of this phone — no refund. The
      // lock-in patch re-writes the same value harmlessly.
      if (room && room.round) {
        push({ [`teams/${myTeam}/decoyUsed`]: room.round.number });
        // decoy_planted: the decoy's deployment moment (its analogue of
        // super_sure_resolved — plant time IS its resolution). Aggregates only;
        // the decoy's coordinates never ride.
        track("decoy_planted", {
          mode: "h2h",
          round_number: room.round.number,
          rounds: room.settings.roundCount,
        });
      }
      scheduleLiveWrite();        // the decoy now rides the live feed
      return;                     // no real pin yet → lock stays disabled
    }
    const firstPin = !guessMarker;
    if (guessMarker) {
      guessMarker.setLatLng(e.latlng);
    } else {
      guessMarker = L.marker(e.latlng, { draggable: true }).addTo(guessMap);
      guessMarker.on("move", scheduleLiveWrite);
      guessMarker.on("move", updateLockButton);
    }
    scheduleLiveWrite();
    $("btnLockIn").disabled = false;  // a real pin exists (canLockWithDecoy)
    updateGuessBanner();
    updateLockButton();
    // The tap that CREATED the real pin is the pin-drop moment (§4.1).
    if (firstPin) maybeCalloutModifier();
  });
}

// §6.1: one banner, and only until the first pin exists. The old second
// state ("Drag to adjust, then lock it in") taught what a draggable pin
// teaches by itself.
function updateGuessBanner() {
  $("pGuessHint").classList.toggle("hidden", !!guessMarker);
}

/* M3's live "if you locked in now" estimate, now ON the primary button
 * (review §6.1): one element instead of a floating pill stacked above a
 * second floating pill, and the number sits exactly where the decision is
 * made. Truth rides in the round, so the phone prices its own pin locally —
 * nothing leaves the device. Refreshed by the 250 ms ticker (the bonus
 * decays with time), on pin moves, and on SUPER SURE arm/disarm. */
function updateLockButton() {
  const btn = $("btnLockIn");
  const superArmed = deployState.superArmed;
  btn.classList.toggle("armed", superArmed);
  if (!room || room.phase !== "roundActive" || !room.round ||
      localStage !== "map" || !guessMarker || myResult()) {
    paintLockButton(btn, lockButtonLabel(LOCK_LABELS.h2h, null, superArmed));
    return;
  }
  const truth = room.round.truth;
  if (!truth || typeof truth.lat !== "number") {
    paintLockButton(btn, lockButtonLabel(LOCK_LABELS.h2h, null, superArmed));
    return;
  }
  const g = guessMarker.getLatLng();
  const km = haversineKm(
    truth.lat, truth.lng, g.lat, L.Util.wrapNum(g.lng, [-180, 180], true));
  const elapsed = Math.max(0, Date.now() - (room.round.startedAt || Date.now()));
  // C5: price the estimate through the SAME twist-aware scorer lockIn uses
  // (blitz ×1.5 + its 20s window, Long Haul's gentler curve), so the "if you
  // locked in now" number matches what actually banks. twistId null ⇒
  // twistedRoundScore reproduces lockNowEstimate exactly.
  const twistId = room.round.twist ? room.round.twist.id : null;
  const est = twistId
    ? twistedRoundScore(twistId, km, elapsed, room.settings)
    : lockNowEstimate(km, elapsed, room.settings.roundSeconds);
  paintLockButton(btn, lockButtonLabel(LOCK_LABELS.h2h, est, superArmed));
}

// Live rival pins, in team colors, on this phone's own guess map — the
// same public-until-lock-in pins the TV panels show, so the gamesmanship
// (bluffs, copies, stare-downs) survives with no shared screen. A rival's
// pin disappears the moment they lock in (lockIn nulls live/<tid>/pin).
function updateRivalPins() {
  if (!guessMap) return;
  const pins = (room && room.phase === "roundActive")
    ? liveRivalPins(room.round, myTeam)
    : [];
  const want = new Set(pins.map((p) => p.id));
  for (const id of Object.keys(rivalMarkers)) {
    if (!want.has(id)) { rivalMarkers[id].remove(); delete rivalMarkers[id]; }
  }
  for (const p of pins) {
    const pos = [p.lat, p.lng];
    if (rivalMarkers[p.id]) {
      rivalMarkers[p.id].setLatLng(pos);
    } else {
      rivalMarkers[p.id] = L.circleMarker(pos, {
        radius: 9, color: "#fff", weight: 2, opacity: 0.9,
        fillColor: teamHex(room.teams, p.id), fillOpacity: 0.75,
        interactive: false,
      }).addTo(guessMap);
    }
  }
}

function clearRivalPins() {
  for (const id of Object.keys(rivalMarkers)) rivalMarkers[id].remove();
  rivalMarkers = {};
}

function openGuessMapScreen() {
  localStage = "map";
  showScreen("p-guess");
  ensureGuessMap();
  $("btnLockIn").disabled = !guessMarker;
  updateGuessBanner();
  // First guess map ever: the scoring one-liner and the rival-pins warning,
  // at the moment they matter (M5). The SUPER SURE line has left this card
  // — the bet is explained in exactly one place now, its own sheet (§6.1).
  oneShotHint("guessmap", {
    title: "Drop your pin",
    lines: guessMapHintLines("h2h"),
  });
  updateLockButton();
  setTimeout(() => guessMap.invalidateSize(), 50);
  updateRivalPins();
  scheduleLiveWrite();
}

/* ---------------- Guess modifiers: one door, one sheet ----------------- */

/* The whole modifier class (SUPER SURE 🔥 + the Decoy 🎭) runs through ONE
 * door: the pin-drop callout (js/modifier.js). There is no chip — the callout
 * is the single entry point (§A1.1), fires from round 1 on every round's first
 * real pin while a modifier is unspent (§A2.1), and presents every available
 * modifier co-equally (§A2.2). It all lives on this phone's own guess screen
 * only; arming/planting is purely local state until lock-in commits it —
 * nothing about a bet ever rides on the live feed, so rivals can't learn it
 * before the reveal. Arming is a commitment: there is no disarm (§A2.3); the
 * armed SUPER stake shows on the primary button's own label. */

// Ordered ids of modifiers this team can still play this round.
function currentModifiers() {
  if (!room || !room.round) return [];
  return availableModifiers({
    mode: "h2h",
    teams: room.teams,
    teamId: myTeam,
    twistId: room.round.twist ? room.round.twist.id : null,
    deployState,
  });
}

// The pin-drop moment (§4): tease every available modifier co-equally. Fires
// every qualifying round's first pin while unspent (§A2.1 — stateless, no
// per-game memory).
function maybeCalloutModifier() {
  if (!room || !room.round) return;
  const available = shouldCalloutModifier({
    mode: "h2h",
    roundNumber: room.round.number,
    available: currentModifiers(),
    firstPinOfRound: true,
    hasResult: !!myResult(),
  });
  if (!available) return;
  // §4.1: while a sheet is open, suppress the callout for this pin drop — it
  // fires again on a later round's first pin by construction (no latch).
  if (hintCardOpen()) return;
  track("modifier_callout_shown", {
    mode: "h2h",
    modifier: available.length > 1 ? "both" : available[0],
    round_number: room.round.number,
  });
  showModifierCallout(calloutSpec(available), () => openModifierSheet("callout"));
}

// The one sheet: every available modifier as a co-equal section (its rule lines
// + its own primary action), driven by MODIFIER_SHEETS + the pure action rows,
// through the existing showHintCard (sheet layer, one at a time).
function openModifierSheet(via) {
  if (!room || myResult()) return;
  const avail = currentModifiers();
  if (!avail.length) return;
  track("modifier_sheet_opened", {
    mode: "h2h", modifier: avail.length > 1 ? "both" : avail[0], via,
  });
  const actions = sheetActions({ available: avail, deployState })
    .map((row) => modifierActionButton(row));
  if (avail.length === 1) {
    const sheet = MODIFIER_SHEETS[avail[0]];
    showHintCard({ title: sheet.title, lines: sheet.lines, actions });
    return;
  }
  // Co-equal sections in registry order: each modifier's header + its rules.
  const lines = [];
  for (const m of MODIFIERS) {
    if (!avail.includes(m.id)) continue;
    const sheet = MODIFIER_SHEETS[m.id];
    lines.push(`${m.icon} ${sheet.title}`);
    lines.push(...sheet.lines);
  }
  showHintCard({ title: "Raise the stakes?", lines, actions });
}

// Map a pure sheet-action row to a showHintCard button spec, wiring the effect.
// Co-equal arm rows (each its own primary) + one cancel — no cross/disarm.
function modifierActionButton(row) {
  if (row.kind === "arm") {
    return { label: row.label, onClick: () => armModifier(row.id) };
  }
  return { label: row.label, primary: false }; // cancel
}

// Arm a modifier through the shared fold — a commitment, no disarm (§A2.3).
// SUPER arming is local until lock-in and re-prices the primary button; a decoy
// "arm" queues the plant tap.
function armModifier(id) {
  if (!room || myResult() || !currentModifiers().includes(id)) return;
  if (id === "super") {
    deployState = modifierFold(deployState, { type: "arm", id: "super" }).state;
    updateLockButton(); // the button flips to the bet's real stakes
  } else if (id === "decoy") {
    deployState = modifierFold(deployState, { type: "arm", id: "decoy" }).state;
    toast("Your next tap plants the decoy — then tap again for your real pin.");
  }
}

// The decoy marker on THIS phone's map — visually distinct (🎭), non-draggable,
// so the planter can never mistake it for their real pin.
function placeDecoyMarker(latlng) {
  decoyPin = { lat: latlng.lat, lng: L.Util.wrapNum(latlng.lng, [-180, 180], true) };
  if (decoyMarker) {
    decoyMarker.setLatLng(latlng);
  } else {
    decoyMarker = L.marker(latlng, {
      draggable: false,
      icon: L.divIcon({ className: "decoy-marker", html: "🎭" }),
    }).addTo(guessMap);
  }
}

function backToStreet() {
  localStage = "explore";
  showScreen("p-round");
  if (viewer) viewer.resize();
  scheduleLiveWrite();
}

/* ---------------- Live mirror: this team's feed to its TV panel ------- */

// One consolidated node per team, throttled to ≤4 writes/second — the same
// discipline as couch mode's pose/liveGuess/liveView writers, but N teams
// write N disjoint nodes in parallel. Worst case (4 phones × 4/s) is 16
// tiny messages/second at the TV, which onValue coalesces effortlessly.
let liveTimer = null;
let liveDirty = false;
function scheduleLiveWrite() {
  liveDirty = true;
  if (liveTimer) return;
  liveTimer = setTimeout(async () => {
    liveTimer = null;
    if (!liveDirty || !room || room.phase !== "roundActive" ||
        !room.round || myResult()) return;
    liveDirty = false;
    const live = {
      stage: localStage,
      imageId: currentImageId || room.round.imageId || null,
      pose: null,
      view: null,
      pin: null,
    };
    try {
      if (localStage === "explore" && viewer) {
        const [pov, center, zoom] = await Promise.all([
          viewer.getPointOfView(),
          viewer.getCenter(),
          viewer.getZoom(),
        ]);
        // A NaN center/zoom from a viewer mid-navigation would make Firebase
        // reject the ENTIRE round/live/<tid> patch (dropping stage + pin too);
        // sanitizePose keeps a bad pose out so the rest of the live write lands.
        live.pose = sanitizePose({ bearing: pov.bearing, center, zoom });
      } else if (localStage === "map" && guessMap) {
        const c = guessMap.getCenter();
        live.view = {
          lat: c.lat,
          lng: L.Util.wrapNum(c.lng, [-180, 180], true),
          zoom: guessMap.getZoom(),
        };
        // G7: once a decoy is planted, the live feed carries the DECOY coords
        // (frozen where planted) and the real pin never rides the wire — hidden
        // in play by construction. Before a plant, the real pin broadcasts.
        if (decoyPin) {
          live.pin = { lat: decoyPin.lat, lng: decoyPin.lng };
        } else if (guessMarker) {
          const g = guessMarker.getLatLng();
          live.pin = { lat: g.lat, lng: L.Util.wrapNum(g.lng, [-180, 180], true) };
        }
      }
    } catch { /* viewer mid-navigation; next tick catches up */ }
    push({ [`round/live/${myTeam}`]: live });
  }, 250);
}

function cancelLiveWrite() {
  if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
  liveDirty = false;
}

/* ---------------- Lock in ---------------- */

// `auto`: the timeout auto-lock (auto-submit mode) — may forfeit with no pin.
// `voluntary`: a give-up (wait-for-players mode) — always a forfeit, even if a
// pin happens to be down, and it carries its own copy.
function lockIn(auto = false, voluntary = false) {
  if (!room || room.phase !== "roundActive" || !room.round || myResult()) return;
  const truth = room.round.truth;
  let guess = null;
  if (guessMarker && !voluntary) {
    const g = guessMarker.getLatLng();
    guess = { lat: g.lat, lng: L.Util.wrapNum(g.lng, [-180, 180], true) };
  }
  // manual lock needs a pin; a timeout auto-lock or a voluntary give-up forfeit.
  if (!guess && !auto && !voluntary) return;
  if (guess) { playSound("stamp"); buzz(35); } // S4: the lock-in beat
  const distanceKm = guess
    ? haversineKm(truth.lat, truth.lng, guess.lat, guess.lng)
    : null;
  // Speed clock: round start to this lock-in, on this phone's clock (the
  // same clock the countdown already trusts). Clamped ≥0 against skew.
  const submittedAt = Date.now();
  const elapsedMs = Math.max(0, submittedAt - (room.round.startedAt || submittedAt));
  // G2: one scorer for twisted and plain rounds (blitz ×1.5, Long Haul curve,
  // blitz 20s window). twistId is read from the round the host wrote.
  const twistId = room.round.twist ? room.round.twist.id : null;
  const ts = guess ? twistedRoundScore(twistId, distanceKm, elapsedMs, room.settings)
    : { distancePoints: 0, timeBonus: 0, points: 0 };
  const distancePoints = ts.distancePoints;
  const speedBonus = ts.timeBonus;
  const points = ts.points;
  // An armed bet commits here — with a pin it rides on the result; with no
  // pin at the buzzer it rides on the forfeit and burns at settlement.
  // Either way the one use is spent (superSureUsed on the team row).
  const betting = deployState.superArmed && superSureAvailable(room.teams, myTeam);
  deployState = { ...deployState, superArmed: false };
  const result = {
    guess,
    distanceKm,
    points,
    distancePoints,
    timeBonus: speedBonus,
    elapsedMs: guess ? elapsedMs : null,
    submittedAt,
    forfeited: guess ? null : true,
    superSure: betting ? true : null,
    twistTag: twistRevealTag(twistId),   // G2: reveal result line
    // G7: the planted decoy, exposed at reveal (readable pre-reveal in devtools,
    // the same accepted posture as the embedded truth and the bet).
    decoy: decoyPin ? { lat: decoyPin.lat, lng: decoyPin.lng } : null,
  };
  // R7 (G8/G4): fold this OWN-PHONE h2h guess into the device records —
  // closest-ever (context "party") and the ACE counter. The h2h guessing phone
  // is personal, so its pins count (§3.8); the couch host phone is shared and
  // never runs this path. Local-only: nothing here is sent, hashed, or
  // analytics-bound. A forfeit (no guess) folds nothing.
  if (guess) {
    const now = new Date();
    const monthKey =
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const applied = applyPartyGuess(loadRecords(localStorage), distanceKm, monthKey);
    saveRecords(localStorage, applied.records);
  }
  cancelLiveWrite();
  const patch = {
    [`round/results/${myTeam}`]: result,
    [`teams/${myTeam}/total`]: (room.teams[myTeam].total || 0) + points,
    [`round/live/${myTeam}/stage`]: "locked",
    [`round/live/${myTeam}/pin`]: null, // final pin (and decoy) vanish at lock-in
  };
  if (betting) patch[`teams/${myTeam}/superSureUsed`] = room.round.number;
  // G7: spending the decoy is recorded on the team row (survives refresh;
  // carryTeams resets it next game). Consumed even on a forfeit — it did its
  // work broadcasting to rivals.
  if (decoyPin) patch[`teams/${myTeam}/decoyUsed`] = room.round.number;
  // Last one in flips the room to reveal and stamps the countdown moment.
  // If two phones race the flip, both write the same phase and revealAt
  // values milliseconds apart — last-write-wins is harmless here. SUPER
  // SURE bets settle in the same atomic patch (raw points were banked at
  // each lock-in; the settlement writes outcome markers and corrected
  // absolute totals), so no surface can ever render an unsettled reveal.
  const others = teamIds(room.teams).filter((id) => id !== myTeam);
  const results = (room.round && room.round.results) || {};
  if (others.every((id) => !!results[id])) {
    patch.phase = "reveal";
    patch["round/revealAt"] = Date.now() + REVEAL_COUNTDOWN_MS;
    Object.assign(patch, autoAdvancePatch(patch["round/revealAt"])); // S6
    const merged = { ...results, [myTeam]: result };
    const teamsBanked = {
      ...room.teams,
      [myTeam]: {
        ...room.teams[myTeam],
        total: (room.teams[myTeam].total || 0) + points,
      },
    };
    // Overrides this patch's own teams/<me>/total when I'm a bettor.
    const settlement = superSureSettlement(teamsBanked, merged);
    Object.assign(patch, settlement.patch);
    // My own outcome must ride inside my full result write — a descendant
    // path next to it would make the multi-path update invalid (RTDB
    // rejects ancestor+descendant in one patch).
    if (settlement.outcomes[myTeam]) {
      result.superSureOutcome = settlement.outcomes[myTeam];
      delete patch[`round/results/${myTeam}/superSureOutcome`];
    }
  }
  push(patch);
  if (guess) {
    // Aggregates only — the pin itself never leaves the device. Forfeits
    // (no pin at the buzzer) aren't guesses, so they aren't tracked here;
    // a burned bet surfaces via super_sure_resolved at the reveal instead.
    track("guess_submitted", {
      room: roomCode,
      mode: "h2h",
      team_id: myTeam,
      distance_km: distanceKm,
      time_bonus: speedBonus,
      total_score: points,
      time_seconds: elapsedMs / 1000,
      super_sure: betting,
      moved: panoMoved(anchoredImageId, currentImageId),
      round_number: room.round.number,                 // G2/G7 join key
      ...(twistId ? { twist: twistId } : {}),          // G2
      decoy: !!(result.decoy),                          // G7 (set when a decoy was planted)
    });
  }
  if (voluntary) {
    toast(betting
      ? "You gave up — your SUPER SURE bet is gone."
      : "You gave up — no points this round.");
  } else if (auto && !guess) {
    toast(betting
      ? "Time! No pin — your SUPER SURE bet is gone."
      : "Time! No pin — no points this round.");
  } else if (auto) {
    toast("Time! Your pin was locked in.");
  }
}

/* Wait-for-players give-up: a voluntary forfeit. The only way to close out a
 * round with no pin once the clock is up in auto_submit=OFF mode (a manual
 * Lock It In still needs a pin). An armed SUPER SURE burns, per doctrine. */
function giveUp() {
  if (!room) return;
  if (!canGiveUp({
    autoSubmit: normalizeAutoSubmit(room.settings && room.settings.autoSubmitOnTimeout),
    phase: room.phase,
    hasResult: !!myResult(),
  })) return;
  hideGiveUp();
  lockIn(false, true);
}

// Show/hide the give-up affordance on whichever play screen is active. Called
// from the ticker (offerGiveUp) and cleared once a result exists.
function updateGiveUp(offer) {
  // Give-up is the pinless straggler's exit; with a pin down the move is Lock
  // It In, so only surface it when there is genuinely no pin (spec: "after
  // expiry and no pin").
  const show = offer && !guessMarker;
  $("btnPGiveUpStreet").classList.toggle("hidden", !(show && shownScreen === "p-round"));
  $("btnPGiveUpMap").classList.toggle("hidden", !(show && shownScreen === "p-guess"));
}

function hideGiveUp() {
  $("btnPGiveUpStreet").classList.add("hidden");
  $("btnPGiveUpMap").classList.add("hidden");
}

// "1st", "2nd", "3rd" — the lock-in order badge. Handles the 11–13 teens
// exception (mirrors js/daily-ui.js ordinal).
function ordinal(n) {
  const v = Math.abs(n) % 100;
  const s = ["th", "st", "nd", "rd"];
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

function renderLockedRoster() {
  const list = $("pLockedList");
  list.innerHTML = "";
  for (const id of teamIds(room.teams)) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = room.teams[id].name + (id === myTeam ? " (you)" : "");
    name.style.color = teamHex(room.teams, id);
    const status = document.createElement("span");
    const r = room.round.results && room.round.results[id];
    status.textContent = r ? `✓ locked in ${ordinal(submitRank(room.round, id))}` : "…thinking";
    status.style.color = r ? "var(--good)" : "var(--muted)";
    li.append(name, status);
    list.appendChild(li);
  }
}

function renderLockedScreen() {
  if (shownScreen !== "p-locked") showScreen("p-locked");
  const rank = submitRank(room.round, myTeam);
  $("pLockedRank").textContent = rank ? `You locked in ${ordinal(rank)}` : "";
  // With no TV attached (remote play), this phone IS the show.
  $("pLockedSub").textContent = screenAttached(room, Date.now())
    ? "Eyes on the TV 📺"
    : "Results land right here when everyone's in";
  renderLockedRoster();
  // Host safety valve: close a stuck round (no-limit games, dead phones).
  const stuck = pendingTeams(room.teams, room.round).length > 0;
  $("btnCloseRound").classList.toggle("hidden", !(isHost() && stuck));
  updateLockedHud();
}

// Host sweep: forfeit every team that never submitted, then reveal. Fired
// manually (Close Round) or automatically after the timer + grace. With
// force, any phone may fire it — the fallback when the HOST's phone is the
// one that died (racing sweeps write identical shapes, so it's harmless).
function sweepAndReveal(force) {
  if (!(isHost() || force === true)) return;
  if (!room || room.phase !== "roundActive" || sweepDone) return;
  const pending = pendingTeams(room.teams, room.round);
  if (pending.length === 0) return;
  sweepDone = true;
  const revealAt = Date.now() + REVEAL_COUNTDOWN_MS;
  const patch = {
    phase: "reveal",
    "round/revealAt": revealAt,
    ...autoAdvancePatch(revealAt), // S6
  };
  for (const id of pending) {
    patch[`round/results/${id}`] = {
      guess: null, distanceKm: null, points: 0,
      distancePoints: 0, timeBonus: 0, elapsedMs: null,
      submittedAt: Date.now(), forfeited: true,
    };
    patch[`round/live/${id}/stage`] = "locked";
  }
  // Settle SUPER SURE bets among the submitted results in the same patch.
  // Swept forfeits never carry a bet (arming is local to the dead phone,
  // so its use is simply not spent) and no forfeit moves "closest".
  Object.assign(
    patch, superSureSettlement(room.teams, room.round.results || {}).patch);
  push(patch);
}

/* ---------------- Ticker: timer HUD, auto-submit, host sweep ---------- */

function startTick() {
  stopTick();
  tickInterval = setInterval(tick, 250);
  tick();
}

function stopTick() {
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
}

function tick() {
  if (!room || room.phase !== "roundActive" || !room.round) return;
  updateLockButton(); // the speed bonus decays in real time
  const endsAt = room.round.endsAt;
  const timerEl = $("pHudTimer");
  const mapTimerEl = $("pGuessTimer"); // timer stays visible on the map too
  if (!endsAt) {
    timerEl.textContent = "∞";
    mapTimerEl.textContent = "";
    timerEl.classList.remove("low");
    mapTimerEl.classList.remove("low");
    updateGiveUp(false); // no clock, no expiry — nothing to give up on
  } else {
    const left = endsAt - Date.now();
    timerEl.textContent = formatCountdown(left);
    mapTimerEl.textContent = formatCountdown(left);
    // S4: the countdown pulse (CSS) + tick (Web Audio) over the final
    // seconds — only while this phone is still in the race.
    const low = left > 0 && left <= 10_500 && !myResult();
    timerEl.classList.toggle("low", low);
    mapTimerEl.classList.toggle("low", low);
    if (!myResult()) {
      const t = countdownTick(lastTickSecond, left);
      if (t) {
        lastTickSecond = t.second;
        playSound(t.urgent ? "tickUrgent" : "tick");
      }
    }
    // Overnight bundle #2: the room's timeout doctrine decides what happens at
    // zero. Auto-lock mode reproduces the legacy forfeit/sweep; the default
    // wait-for-players mode auto-locks nothing and offers a voluntary give-up.
    const now = Date.now();
    const conduct = expiryConduct({
      autoSubmit: normalizeAutoSubmit(room.settings && room.settings.autoSubmitOnTimeout),
      expired: left <= 0,
      hasResult: !!myResult(),
      isHost: isHost(),
      overGrace: now > endsAt + FORFEIT_GRACE_MS,
      overGrace3: now > endsAt + FORFEIT_GRACE_MS * 3,
    });
    if (conduct.autoLock && !autoSubmitted) {
      // Time's up: lock whatever pin this phone has (or forfeit with none).
      autoSubmitted = true;
      lockIn(true);
    }
    if (conduct.hostSweep) {
      // Referee of last resort: a phone that died can't stall the party.
      sweepAndReveal();
    } else if (conduct.forceSweep) {
      // ...and if the dead phone IS the host's, any locked-in phone steps up.
      sweepAndReveal(true);
    }
    updateGiveUp(conduct.offerGiveUp);
  }
}

/* ---------------- Reveal ---------------- */

function renderReveal() {
  const round = room.round;
  if (!round) return;
  stopTick();
  cancelLiveWrite();

  // Hold the phones during the reveal countdown so the place name doesn't
  // leak early. With a TV the phone says "look up"; without one, the phone
  // runs the 3-2-1 itself. Re-arming every ≤300ms keeps the number ticking.
  const wait = (round.revealAt || 0) - Date.now();
  if (wait > 150) {
    if (shownScreen !== "p-locked") showScreen("p-locked");
    $("pLockedRank").textContent = "Everyone's in!";
    const attached = screenAttached(room, Date.now());
    $("pLockedSub").textContent = attached
      ? "Eyes on the TV 📺"
      : `Reveal in ${Math.ceil(wait / 1000)}…`;
    // S4: with no TV this phone runs the 3-2-1 — give it the beat too
    // (with a TV attached the TV ticks; the phone stays quiet).
    if (!attached) {
      const t = countdownTick(revealTickSecond, wait, 3);
      if (t) { revealTickSecond = t.second; playSound("tickUrgent"); }
    }
    renderLockedRoster();
    $("btnCloseRound").classList.add("hidden");
    clearTimeout(revealFlipTimer);
    revealFlipTimer = setTimeout(() => {
      if (room && room.phase === "reveal") renderReveal();
    }, Math.min(wait + 50, 300));
    return;
  }

  showScreen("p-reveal");
  // S4: the reveal sting, once per round (renderReveal re-runs on every
  // state echo while the phase holds).
  if (stungFor !== round.number) {
    stungFor = round.number;
    playSound("sting");
  }
  // First reveal ever: label the breakdown once (M5); the injected speed
  // line below carries the numbers themselves every round.
  oneShotHint("reveal", HINT_CARDS.reveal);
  renderRevealMap(round);
  // Host phone only, once per round — mirrors round_started's cardinality
  // so the funnel counts rounds, not phones.
  if (isHost() && revealTracked !== round.number) {
    revealTracked = round.number;
    track("reveal_shown", {
      room: roomCode, mode: "h2h", round_number: round.number,
      forfeits: forfeitCount(round), // how many closed with no pin (#2 KPI)
    });
    // One super_sure_resolved per bet, host phone only (same cardinality
    // discipline as reveal_shown). Burned bets appear ONLY here — a
    // forfeit is not a guess, so it never sent guess_submitted.
    const outcomes = resolveSuperSure(round.results);
    for (const id of Object.keys(outcomes)) {
      track("super_sure_resolved", {
        mode: "h2h",
        round_number: round.number,
        rounds: room.settings.roundCount,
        outcome: outcomes[id],
        round_total: (round.results[id] && round.results[id].points) || 0,
      });
    }
  }
  const last = round.number >= room.settings.roundCount;
  $("pRevealHeading").textContent =
    `Round ${round.number} of ${room.settings.roundCount}`;
  $("pRevealPlace").textContent = (round.truth && round.truth.name) || "—";
  const mine = myResult();
  // S1: fold my result into my team's closest-guess moment for the share
  // card. Idempotent, so the re-renders this function gets are harmless.
  myBest = foldBestMoment(
    myBest, { me: mine }, round.truth && round.truth.name);

  // G4 (C2): the medal grade of my pin — its caption rides the reveal result
  // line, and a sub-1km ACE fires the stamp ceremony once per round on the
  // acing phone (reduced-motion collapses the stamp via CSS, like LOCKED IN).
  const medal = mine && typeof mine.distanceKm === "number"
    ? medalForDistance(mine.distanceKm) : null;
  if (medal && medal.ace && acedFor !== round.number) {
    acedFor = round.number;
    playSound("stamp");
    stampFlash(`🎯 ACE — ${formatDistance(mine.distanceKm)}`);
  }

  /* §6.4: ONE result line replaces the Location/Distance/Points cards and
   * the two sub-lines that used to be injected under them (speed breakdown,
   * SUPER SURE verdict). The SUPER SURE ceremony is untouched — the verdict
   * rides here and on the map halo, exactly as before. */
  const resultEl = $("pRevealResult");
  resultEl.textContent = revealResultLine(
    medal && medal.caption ? { ...mine, medalCaption: medal.caption } : mine);
  resultEl.classList.toggle(
    "lost", !!(mine && mine.superSure && mine.superSureOutcome !== "won"));

  /* §6.4: ONE board replaces "This round" + "Totals". The round delta sits
   * next to the running total instead of the eye having to join two lists,
   * and the crown still marks the round's closest pin. */
  const board = $("pRevealBoard");
  board.innerHTML = "";
  for (const row of revealBoardRows(room.teams, round.results)) {
    const li = document.createElement("li");
    if (row.crown) li.classList.add("active");
    const name = document.createElement("span");
    name.textContent = (row.crown ? "👑 " : "") + row.name +
      (row.id === myTeam ? " (you)" : "");
    name.style.color = teamHex(room.teams, row.id);
    const val = document.createElement("span");
    val.textContent = boardRowText(row);
    li.append(name, val);
    board.appendChild(li);
  }

  const host = isHost();
  $("btnPNext").classList.toggle("hidden", !host);
  $("btnPNext").textContent = last ? "Finish game" : "Next round";
  startAdvanceTicker();
}

/* S6 soft auto-advance (h2h). Every phone ticks the shared countdown from
 * round.autoAdvanceAt (stamped by whichever phone flipped the reveal), but
 * only the hostTeam's phone — the one that owns manual advance — fires it.
 * The host can hold (null the deadline for everyone) or advance early as
 * before. If the host phone is dead the countdown shows the "starting…"
 * beat briefly, then lapses back to the classic waiting copy — the same
 * dead-host stall as before S6, just honestly rendered. */
let advanceTicker = null;

function stopAdvanceTicker() {
  if (advanceTicker) { clearInterval(advanceTicker); advanceTicker = null; }
}

function startAdvanceTicker() {
  stopAdvanceTicker();
  advanceTicker = setInterval(renderAdvanceState, 250);
  renderAdvanceState();
}

function renderAdvanceState() {
  if (!room || room.phase !== "reveal" || !room.round) {
    stopAdvanceTicker();
    return;
  }
  const round = room.round;
  const now = Date.now();
  if ((round.revealAt || 0) - now > 150) return; // still in the 3-2-1
  const host = isHost();
  const status = autoAdvanceStatus(round.autoAdvanceAt, now);
  const target = advanceTarget(round.number, room.settings.roundCount);
  $("btnPHold").classList.toggle(
    "hidden", !(host && status.state === "counting"));
  const counting = countdownText(status, target);
  const hostName =
    room.teams[room.hostTeam] ? room.teams[room.hostTeam].name : "The host";
  $("pRevealNote").textContent = counting !== null
    ? counting
    : host
      ? ""
      : target === "gameOver"
        ? `${hostName} wraps up the game…`
        : `${hostName} starts the next round…`;
  // Once per round: startRound / the gameOver push are async, and a state
  // echo arriving mid-flight would restart this ticker while the local
  // phase still reads "reveal" — without the latch the advance fires twice.
  if (autoAdvanceFired !== round.number && shouldAutoAdvance({
    phase: room.phase, autoAdvanceAt: round.autoAdvanceAt, isHost: host, now,
  })) {
    autoAdvanceFired = round.number;
    stopAdvanceTicker();
    nextOrFinish("auto");
  }
}

function holdAdvance() {
  if (!isHost() || !room || room.phase !== "reveal" || !room.round) return;
  const status = autoAdvanceStatus(room.round.autoAdvanceAt, Date.now());
  if (status.state !== "counting") return;
  room.round.autoAdvanceAt = null; // render now; the echo confirms
  push(holdAdvancePatch());
  track("auto_advance_hold", {
    room: roomCode, mode: "h2h", round_number: room.round.number,
    seconds_left: advanceSecondsLeft(status.msLeft),
  });
  renderAdvanceState();
  toast("Holding — advance whenever you're ready");
}

// The all-pins reveal, phone-sized: every guess, a line to the truth, the
// answer pinned gold. This is what makes head-to-head complete on a single
// device per player — no TV required for the payoff moment.
// The all-pins reveal is now a declarative scene (js/revealmap.js) executed
// by the shared renderer (js/revealmap-ui.js): every guess pin + line, a
// SUPER SURE verdict halo where a pin wore the bet (reveal-only, per the
// hidden rule), each planted G7 decoy as a 🎭, and the gold truth. The
// render-once latch and the truth guard stay here.
function renderRevealMap(round) {
  if (revealMapShownFor === round.number) return;
  if (!round.truth || typeof round.truth.lat !== "number") return;
  destroyRevealMap();
  revealMapShownFor = round.number;
  revealHandle = renderRevealScene("pRevealMap", phoneRevealScene({
    truth: round.truth,
    pins: revealPins(round),
    decoys: revealDecoys(round),
    teams: room.teams,
  }));
}

function destroyRevealMap() {
  revealHandle?.destroy();
  revealHandle = null;
  revealMapShownFor = null;
}

function renderTotalsList(listEl) {
  listEl.innerHTML = "";
  for (const t of standings(room.teams)) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = t.name + (t.id === myTeam ? " (you)" : "");
    name.style.color = teamHex(room.teams, t.id);
    const pts = document.createElement("span");
    pts.textContent = t.total.toLocaleString();
    li.append(name, pts);
    listEl.appendChild(li);
  }
}

function nextOrFinish(advance) {
  if (!isHost() || !room || room.phase !== "reveal") return;
  stopAdvanceTicker();
  const via = advance === "auto" ? "auto" : "manual";
  if (room.round.number >= room.settings.roundCount) {
    // Game over — and the crown moves: host authority is written to the
    // winning team in the same patch, so from this moment only the
    // winner's phone can spawn the next game. Ties are broken by the
    // deterministic room-code coin flip in h2hWinner.
    const winner = h2hWinner(room.teams, roomCode);
    push({ phase: "gameOver", hostTeam: winner });
    track("game_completed", {
      room: roomCode,
      mode: "h2h",
      rounds: room.round.number,
      winner_team: winner,
      winning_score: room.teams[winner] ? room.teams[winner].total : 0,
      team_count: teamIds(room.teams).length,
      advance: via,
    });
    // G3 Crown Night: the phase-writing device fires the champion event when
    // this game's crown reaches first-to-3 (display is recomputed on every
    // device; the authoritative carry happens in createNextGame).
    const bumped = bumpNight(room.night || defaultNight(), winner);
    if (champion(bumped)) {
      track("night_champion", { mode: "h2h", games: bumped.games });
    }
  } else {
    startRound(via);
  }
}

/* ---------------- Game over & handoff ---------------- */

function renderGameOver() {
  showScreen("p-gameover");
  destroyViewer();
  const winner = room.hostTeam; // rotated to the winner at finish
  const winnerName = room.teams[winner] ? room.teams[winner].name : "The winner";
  const iWon = winner === myTeam;
  const bumped = bumpNight(room.night || defaultNight(), winner);
  const isChampion = !!champion(bumped);
  // S4: the game-over cue plays once per room, regardless of who's watching;
  // a Crown Night win earns the bigger championFanfare instead.
  if (!fanfarePlayed) {
    fanfarePlayed = true;
    playSound(isChampion ? "championFanfare" : "fanfare");
  }
  const gameOverEl = $("p-gameover");
  const titleEl = $("pGameOverTitle");
  const statEl = $("pWinStat");
  // "Your Color Takes the Room": the celebration renders on the WINNER's own
  // phone only — everyone else's game-over screen stays exactly as before.
  if (iWon) {
    const seed = `${roomCode}:${bumped.games}`;
    const plan = celebrationSpec({
      won: true,
      champion: isChampion,
      teamColor: teamHex(room.teams, winner),
      seed,
      surface: "phone",
    });
    gameOverEl.style.setProperty("--win", plan.winVar);
    gameOverEl.classList.add("is-win");
    gameOverEl.classList.toggle("is-champion", isChampion);
    titleEl.textContent = isChampion ? "🏆 You won!" : winLine(seed, winnerName);
    titleEl.classList.add("win-headline");
    const brag = winBragText(myBest);
    statEl.textContent = brag;
    statEl.classList.toggle("hidden", !brag);
    if (!winCelebrated) {
      winCelebrated = true;
      spawnConfetti($("pConfetti"), {
        seed: plan.seed, tier: plan.tier, accentColor: plan.accentColor,
        spread: plan.spread, count: plan.count,
      });
      buzz([40, 30, 70]);
    }
  } else {
    gameOverEl.style.removeProperty("--win");
    gameOverEl.classList.remove("is-win", "is-champion");
    titleEl.textContent = "Game over!";
    titleEl.classList.remove("win-headline");
    statEl.classList.add("hidden");
  }
  renderTotalsList($("pFinalTotals"));
  // §2.9 / §4.1: exactly one primary per state. The winner's primary is the
  // next game; for everyone else Share becomes the primary, so the bar is
  // never two filled peers and never a lone unstyled button. Leave is the
  // third action and has moved to a ghost link in the content above.
  $("btnPNextGame").classList.toggle("hidden", !iWon);
  // P1.4: Share's static class is btn-ghost (the established secondary); on
  // a loss it becomes the bar's one primary instead (Next Game is hidden),
  // so the two classes are toggled as a mutually-exclusive pair, never both
  // at once (style.css resolves .btn-ghost after .btn-primary in the
  // cascade, so leaving btn-ghost on would silently win over btn-primary).
  $("btnPShareResult").classList.toggle("btn-primary", !iWon);
  $("btnPShareResult").classList.toggle("btn-ghost", iWon);
  $("pHandoffNote").textContent = iWon
    ? "Winner runs the table: your phone is the host now. Set up the next game and everyone follows automatically."
    : `${winnerName} won — their phone is the host now. Stay here; you'll follow into their next game automatically.`;
  renderNightTally(bumped, iWon);
}

// G3: the night tally + champion ceremony on the h2h game-over screen, and the
// "Game N?" hook on the winner's next-game button. Team names ride these nodes,
// so #pChampion / #pNightTally / #pNightHook carry data-ph-mask in player.html.
function renderNightTally(night, iWon) {
  const champId = champion(night);
  const champEl = $("pChampion");
  const tallyEl = $("pNightTally");
  if (champId) {
    const name = (room.teams[champId] && room.teams[champId].name) || champId;
    champEl.textContent = championText(name);
    champEl.classList.remove("hidden");
    tallyEl.classList.add("hidden");
  } else {
    champEl.classList.add("hidden");
    const line = tallyLineText(night, room.teams);
    tallyEl.textContent = line;
    tallyEl.classList.toggle("hidden", !line);
  }
  const hook = $("pNightHook");
  if (hook) {
    const show = iWon && nightSummary(night, room.teams).length > 0;
    hook.textContent = show ? crownHookText(night, room.teams, night.games + 1) : "";
    hook.classList.toggle("hidden", !show);
  }
}

// S1: every phone shares its own team's card — closest moment + final
// total, no team names. The link is the front door, UTM-tagged so rooms
// created by recipients attribute back to shared cards.
function shareMyResult() {
  if (!room || !room.teams[myTeam]) return;
  shareResult(
    partyShareText({
      best: myBest,
      points: room.teams[myTeam].total || 0,
      url: withUtm(new URL(".", location.href).href, "h2h"),
    }),
    "h2h",
    toast
  );
}

// The winner's handoff reuses the ONE settings panel (§2.3): the four
// segment groups used to exist a third time on this page just for this.
function openNextGameSetup() {
  for (const [seg, val] of [
    ["pSegRounds", String(room.settings.roundCount)],
    ["pSegSeconds", String(room.settings.roundSeconds)],
    ["pSegMove", room.settings.moveAllowed ? "1" : "0"],
    ["pSegDifficulty", normalizeDifficulty(room.settings.difficulty)],
    ["pSegTwists", normalizeTwistSetting(room.settings.twists)],
    ["pSegAutoSubmit",
      normalizeAutoSubmit(room.settings.autoSubmitOnTimeout) ? "1" : "0"],
  ]) {
    const el = $(seg);
    el.dataset.value = val;
    for (const b of el.querySelectorAll("button")) {
      b.classList.toggle("sel", b.dataset.v === val);
    }
  }
  openSetup("next");
}

async function createNextGame() {
  if (!isHost() || !room || room.phase !== "gameOver") return;
  $("btnOpenRoom").disabled = true;
  try {
    const oldCode = roomCode;
    // Overnight bundle #3: stop reacting to the OLD room BEFORE the async
    // room-code search — otherwise a stray gameOver echo arriving during the
    // await snaps the handoff panel back to the game-over screen.
    switchingRooms = true;
    const code = await pickFreeRoomCode();
    const teams = carryTeams(room.teams);
    const state = initialH2hRoomState(collectSettings(), teams, myTeam);
    // G3 Crown Night: the winner's phone carries the tally into the NEW room —
    // bumped for the game just won, or reset to zero after a champion — before
    // the nextRoom pointer (the same ordering the pointer already relies on).
    state.night = carryNight(room.night || defaultNight(), myTeam);
    writeRoom(code, state).catch((e) =>
      console.warn("Firebase write failed:", scrubErrorMessage(e)));
    // Queued after the new room's write on the same connection: by the time
    // any subscriber sees the pointer, the room exists (couch pattern).
    updateRoom(oldCode, { nextRoom: code }).catch((e) =>
      console.warn("nextRoom pointer write failed:", scrubErrorMessage(e)));
    const mine = lsGet(LS_MY_ROOMS, []);
    mine.push({ code, createdAt: state.createdAt });
    lsSet(LS_MY_ROOMS, mine);
    track("next_game", { mode: "h2h" });
    track("game_created", {
      room: code,
      mode: "h2h",
      num_teams: teamIds(teams).length, // carried over from the last game
      num_rounds: state.settings.roundCount,
      round_seconds: state.settings.roundSeconds,
      difficulty: state.settings.difficulty,
      auto_submit: normalizeAutoSubmit(state.settings.autoSubmitOnTimeout),
    });
    enterRoom(code, myTeam);
  } catch (e) {
    console.error(scrubErrorMessage(e));
    switchingRooms = false;
    toast("Couldn't set up the next game — try again.");
  } finally {
    $("btnOpenRoom").disabled = false;
  }
}

/* ================================================================
 * Resume
 * ================================================================ */

async function renderResumeBanner() {
  const banner = $("pResumeBanner");
  banner.classList.add("hidden");
  const active = lsGet(LS_H2H_ACTIVE, null);
  if (!active || !active.code || !active.teamId) return;
  if (Date.now() - (active.createdAt || 0) > 86_400_000) {
    localStorage.removeItem(LS_H2H_ACTIVE);
    return;
  }
  let state = null;
  try { state = await readRoom(active.code); } catch { return; }
  if (!state || state.mode !== "h2h" ||
      teamForDevice(state.teams, deviceId) !== active.teamId) {
    localStorage.removeItem(LS_H2H_ACTIVE);
    return;
  }
  $("pResumeCode").textContent = active.code;
  banner.classList.remove("hidden");
  $("btnPResume").onclick = async () => {
    const fresh = await readRoom(active.code).catch(() => null);
    if (fresh && teamForDevice(fresh.teams, deviceId)) {
      banner.classList.add("hidden");
      enterRoom(active.code, teamForDevice(fresh.teams, deviceId));
    } else {
      banner.classList.add("hidden");
      localStorage.removeItem(LS_H2H_ACTIVE);
      toast("That room is gone");
    }
  };
}

/* ================================================================
 * Boot
 * ================================================================ */

wireSeg("pSegRounds");
wireSeg("pSegSeconds");
wireSeg("pSegMove");
wireSeg("pSegDifficulty");
wireSeg("pSegTwists");
wireSeg("pSegAutoSubmit");

$("btnStartNew").addEventListener("click", startNewGame);
$("btnSetupBack").addEventListener("click", showHome);
// One primary on the settings panel, two possible meanings: start this
// device's party, or spawn the winner's next game.
$("btnOpenRoom").addEventListener("click", () => {
  if (setupMode === "next") createNextGame(); else createRoom();
});
$("btnJoin").addEventListener("click", joinRoom);
$("btnPShare").addEventListener("click", shareInvite);
$("btnPTvLink").addEventListener("click", () => {
  if (!roomCode) return;
  shareTvLink(screenLink(location.href, roomCode, "link"), roomCode, "h2h", toast);
});
$("btnPLeave").addEventListener("click", leaveOrAbandon);
$("btnPStart").addEventListener("click", startRound);
$("btnOpenMap").addEventListener("click", openGuessMapScreen);
$("btnBackToStreet").addEventListener("click", backToStreet);
$("btnLockIn").addEventListener("click", () => lockIn(false));
$("btnPGiveUpStreet").addEventListener("click", giveUp);
$("btnPGiveUpMap").addEventListener("click", giveUp);
$("btnCloseRound").addEventListener("click", sweepAndReveal);
$("btnPNext").addEventListener("click", nextOrFinish);
$("btnPHold").addEventListener("click", holdAdvance);
$("btnPHome").addEventListener("click", () => leaveToHome());
$("btnPShareResult").addEventListener("click", shareMyResult);
$("btnPNextGame").addEventListener("click", openNextGameSetup);
// §6: the game-over "How to play" link.
$("pHowto").addEventListener("click", () =>
  track("howto_opened", { source: "gameover" }));

$("joinCode").addEventListener("input", () => {
  $("joinCode").value = $("joinCode").value.toUpperCase()
    .replace(/[^A-HJ-NP-Z]/g, "");
  $("joinErr").textContent = "";
});

// Team-roster brief, extended to the h2h joiner: 🎲 pun + inline type-ahead
// suggestions on this device's single team-name input.
$("pBtnSurprisePun").addEventListener("click", () => {
  $("myTeamName").value = randomPun();
  $("myTeamName").dataset.source = "pun";
  hideTeamSuggestions();
  $("myTeamName").focus();
});
$("myTeamName").addEventListener("input", () => {
  $("myTeamName").dataset.source = "typed";
  renderTeamSuggestions();
});
$("myTeamName").addEventListener("blur", () => {
  // Suggestion taps use mousedown+preventDefault so they never blur the
  // input; this timeout only covers a genuine tap elsewhere on screen.
  setTimeout(hideTeamSuggestions, 120);
});
// Pre-fill with this device's last-used name (no permanent roster UI —
// owner: "not worth the screen real estate" — just persistence + pun +
// suggestions, per js/team-names.js).
if (!$("myTeamName").value) {
  const last = lastTeam();
  if (last) { $("myTeamName").value = last; $("myTeamName").dataset.source = "recent"; }
}

onConnectionChange((isConnected) => {
  $("connPill").classList.toggle("hidden", isConnected);
});

// QR deep-link: player.html?room=CODE prefills the code; the joiner only
// types a team name. That's the whole join flow. The landing's chooser
// arrives with ?create=1 instead — a party starter, not a joiner.
const urlParams = new URLSearchParams(location.search);
const urlCode = (urlParams.get("room") || "").toUpperCase();
initSound("player"); // S4: muted by default on phones; 🔇 toggle persists
if (isValidRoomCode(urlCode)) {
  // A joiner: panel 1 is the only panel this arrival ever sees (§6.2).
  showHome();
  $("joinCode").value = urlCode;
  $("myTeamName").focus();
} else if (urlParams.get("create") === "1") {
  // The landing's chooser already committed this visitor to starting a
  // party, so the deliberate action happened one page ago — go straight to
  // the settings panel (which carries the team-name field with it) rather
  // than charging the create funnel an extra tap.
  openSetup("new");
  $("myTeamName").focus();
} else {
  showHome();
}
janitor();
renderResumeBanner();
