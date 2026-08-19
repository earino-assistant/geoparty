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

import { MAPILLARY_TOKEN } from "../config.js";
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
  makeRoomCode,
  isValidRoomCode,
  haversineKm,
  scoreForDistance,
  bonusWindowMs,
  timeBonus,
  formatSeconds,
  resultRowText,
  formatDistance,
  formatCountdown,
  teamIds,
  standings,
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
} from "./h2h.js";
import {
  superSureAvailable,
  resolveSuperSure,
  superSureSettlement,
  adjustedPoints,
  superSureLabel,
} from "./supersure.js";
import {
  HINT_CARDS,
  guessMapHintLines,
  lockNowEstimate,
  lockNowLabel,
} from "./hints.js";
import { oneShotHint, dismissHintCard } from "./hints-ui.js";
import {
  autoAdvancePatch,
  autoAdvanceStatus,
  shouldAutoAdvance,
  advanceTarget,
  advanceSecondsLeft,
  countdownText,
  holdAdvancePatch,
} from "./autoadvance.js";
import { withUtm, partyShareText, foldBestMoment } from "./share.js";
import { shareResult, shareTvLink } from "./share-ui.js";
import { screenLink, tvBrowserLine, phoneJoinLine } from "./tvlink.js";
import { countdownTick } from "./fx.js";
import { initSound, playSound, buzz } from "./fx-ui.js";
import { loadPool, PoolSampler, normalizeDifficulty } from "./pool.js";
import { drawQr } from "./qr.js";
import { track } from "./consent.js";

/* ================================================================
 * DOM helpers
 * ================================================================ */

const $ = (id) => document.getElementById(id);
const SCREENS = [
  "p-home", "p-lobby", "p-round", "p-guess",
  "p-locked", "p-reveal", "p-gameover", "p-next",
];

const TEAM_HEX = ["#ffcf3f", "#4dd6ff", "#ff6ec7", "#7dff8a"];
const teamHex = (teams, id) =>
  TEAM_HEX[teamIds(teams).indexOf(id) % TEAM_HEX.length];

let shownScreen = null;
function showScreen(id) {
  shownScreen = id;
  dismissHintCard(); // a hint never outlives the moment it teaches
  for (const s of SCREENS) $(s).classList.toggle("hidden", s !== id);
}

let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2500);
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
      catch (e) { console.warn("janitor: could not delete", entry.code, e); }
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

let viewer = null;         // MapillaryJS viewer (this phone's own eyes)
let currentImageId = null; // where the player IS (movement lands on neighbors)
let anchoredImageId = null; // the round anchor the viewer was last sent to
let guessMap = null;
let guessMarker = null;
let rivalMarkers = {};     // tid -> live rival pin on MY guess map
let revealMap = null;      // per-round reveal map (phone-sized TV reveal)
let revealMapShownFor = null; // round number the reveal map was built for

let myBest = null;         // my team's closest guess — the share card brag (S1)
let localStage = "explore"; // "explore" (pano) | "map" — this phone's UI mode
let lastRoundSeen = null;   // round number the UI has been reset for
let superSureArmed = false; // SUPER SURE toggled on for THIS pin — local only
                            // until lock-in, so rivals can't see it coming
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
let fanfarePlayed = false;  // S4: game-over fanfare, once per room

const isHost = () => !!room && room.hostTeam === myTeam;
const myResult = () =>
  (room && room.round && room.round.results && room.round.results[myTeam]) || null;

function push(patch) {
  updateRoom(roomCode, patch).catch((e) => {
    console.warn("Firebase write failed (continuing locally):", e);
  });
}

function persistActive() {
  lsSet(LS_H2H_ACTIVE, { code: roomCode, teamId: myTeam, createdAt: Date.now() });
}

/* ================================================================
 * Room lifecycle: create / join / follow / leave
 * ================================================================ */

function collectSettings(prefix) {
  return {
    roundCount: parseInt($(`${prefix}SegRounds`).dataset.value, 10),
    roundSeconds: parseInt($(`${prefix}SegSeconds`).dataset.value, 10),
    moveAllowed: $(`${prefix}SegMove`).dataset.value === "1",
    difficulty: normalizeDifficulty($(`${prefix}SegDifficulty`).dataset.value),
  };
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
  $("btnCreateRoom").disabled = true;
  try {
    const code = await pickFreeRoomCode();
    const teams = {
      t1: { name, total: 0, deviceId, joinedAt: Date.now() },
    };
    const state = initialH2hRoomState(collectSettings("p"), teams, "t1");
    writeRoom(code, state).catch((e) =>
      console.warn("Firebase write failed:", e));
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
    });
    track("team_joined", { mode: "h2h", team_count: 1 });
    enterRoom(code, "t1");
  } catch (e) {
    console.error(e);
    toast("Could not create game — see console");
  } finally {
    $("btnCreateRoom").disabled = false;
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
      err.textContent = "That room is a couch game — this page is head-to-head.";
      return;
    }
    // Refresh / phone re-entry: this device already owns a team here.
    const mine = teamForDevice(state.teams, deviceId);
    if (mine) { enterRoom(code, mine); return; }
    if (state.phase !== "lobby") {
      err.textContent = "That game already started.";
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
    track("team_joined", { mode: "h2h", team_count: teamCount });
    enterRoom(code, claimed);
  } catch (e) {
    console.error(e);
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
  fanfarePlayed = false;
  localStage = "explore";
  superSureArmed = false;
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
    toast("Following the winner into the next game…");
    enterRoom(code, mine);
  } catch (e) {
    console.error(e);
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
  showScreen("p-home");
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
    try { await deleteRoom(roomCode); } catch (e) { console.warn(e); }
    const mine = lsGet(LS_MY_ROOMS, []).filter((r) => r.code !== roomCode);
    lsSet(LS_MY_ROOMS, mine);
    leaveToHome();
  } else {
    // A member leaving the lobby frees their slot for someone else.
    if (room.phase === "lobby") {
      try { await updateRoom(roomCode, { [`teams/${myTeam}`]: null }); }
      catch (e) { console.warn(e); }
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
  const note = $("pScreenNote");
  const attached = screenAttached(room, Date.now());
  $("pTvAdd").classList.toggle("hidden", attached);
  if (attached) {
    note.textContent = "TV connected ✓";
    note.classList.add("ok");
  } else {
    note.textContent = "No TV needed — every phone shows the reveal.";
    note.classList.remove("ok");
  }

  const list = $("pLobbyTeams");
  list.innerHTML = "";
  const ids = teamIds(room.teams);
  ids.forEach((id) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent =
      room.teams[id].name +
      (id === myTeam ? " (you)" : "") +
      (id === room.hostTeam ? " 👑" : "");
    name.style.color = teamHex(room.teams, id);
    const tag = document.createElement("span");
    tag.textContent = "ready";
    tag.style.color = "var(--muted)";
    li.append(name, tag);
    list.appendChild(li);
  });

  const host = isHost();
  $("btnPStart").classList.toggle("hidden", !host);
  $("btnPLeave").textContent = host ? "Abandon" : "Leave";
  $("pLobbyNote").textContent = host
    ? (ids.length < 2
        ? "You can start solo, but it's better with rivals — phones join with the QR."
        : `${ids.length} teams in — start when everyone's ready.`)
    : `Waiting for ${room.teams[room.hostTeam] ? room.teams[room.hostTeam].name : "the host"} to start…`;
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
        text: `Join my GeoParty head-to-head — room ${roomCode}`,
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
    toast("Invite link copied — send it to your rival");
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
    // so renderRoundActive's screen-change guard won't fire this for it.
    oneShotHint("pano", HINT_CARDS.pano);
    if (!viewer) makeViewer();
    let entry = sampler.peek();
    let loaded = false;
    while (entry && !loaded) {
      try {
        await viewer.moveTo(entry.image_id);
        loaded = true;
      } catch (e) {
        console.warn(`Pool image ${entry.image_id} failed to load, skipping`, e);
        entry = sampler.advance();
      }
    }
    if (!entry) {
      toast("Location pool exhausted!");
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
    const secs = room.settings.roundSeconds;
    const number = (room.round ? room.round.number : 0) + 1;
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
    };
    push({ phase: "roundActive", round, poolCursor: sampler.cursor });
    track("round_started", {
      room: roomCode, mode: "h2h", round_number: number,
      ...(via ? { advance: via } : {}),
    });
  } catch (e) {
    console.error(e);
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
    localStage = "explore";
    superSureArmed = false; // the bet is armed per-pin, never carried over
    lastTickSecond = null;
    revealTickSecond = null;
    clearTimeout(revealFlipTimer);
    if (guessMarker) { guessMarker.remove(); guessMarker = null; }
    clearRivalPins();
    if (guessMap) guessMap.setView([25, 10], 2);
    $("btnLockIn").disabled = true;
    $("lockNowHint").textContent = "";
    startTick();
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
      // First pano ever on this device: teach the loop's first move (M5).
      oneShotHint("pano", HINT_CARDS.pano);
      if (viewer) viewer.resize();
    }
    if (!viewer) makeViewer();
    // Re-anchor ONLY when the round's anchor changes (new round / rejoin /
    // fresh viewer). Comparing currentImageId here snapped every forward
    // move back to the anchor on the next state echo (movement bounce).
    if (viewer && shouldReanchorViewer(anchoredImageId, currentImageId, round.imageId)) {
      const target = round.imageId;
      anchoredImageId = target;
      currentImageId = target;
      viewer.moveTo(target).catch((e) => {
        console.warn("player: image load failed", e);
        toast("Imagery failed to load — you can still guess from the map");
      });
    }
  }

  $("pHudRound").textContent =
    `Round ${round.number}/${room.settings.roundCount}`;
  updateLockedHud();
}

function updateLockedHud() {
  const n = submittedCount(room.round);
  const total = teamIds(room.teams).length;
  $("pHudLocked").textContent = n > 0 ? `${n}/${total} in` : "";
}

function makeViewer() {
  destroyViewer();
  const moveAllowed = room.settings.moveAllowed;
  viewer = new mapillary.Viewer({
    accessToken: MAPILLARY_TOKEN,
    container: "playerViewer",
    component: {
      cover: false,
      direction: moveAllowed,
      sequence: moveAllowed,
      keyboard: moveAllowed,
      zoom: true,
      bearing: true,
    },
  });
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
  if (viewer) {
    try { viewer.remove(); } catch { /* already gone */ }
    viewer = null;
    currentImageId = null;
    anchoredImageId = null;
  }
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
    if (guessMarker) {
      guessMarker.setLatLng(e.latlng);
    } else {
      guessMarker = L.marker(e.latlng, { draggable: true }).addTo(guessMap);
      guessMarker.on("move", scheduleLiveWrite);
      guessMarker.on("move", updateLockNowHint);
    }
    scheduleLiveWrite();
    $("btnLockIn").disabled = false;
    updateLockNowHint();
  });
}

// M3: the live "if you locked in now" pill. Truth rides in the round, so
// the phone can price its own pin locally — nothing leaves the device.
// Refreshed by the 250 ms ticker (the bonus decays with time), on pin
// moves, and on SUPER SURE toggles (armed = show the doubled stakes).
function updateLockNowHint() {
  const el = $("lockNowHint");
  if (!room || room.phase !== "roundActive" || !room.round ||
      localStage !== "map" || !guessMarker || myResult()) {
    el.textContent = "";
    return;
  }
  const truth = room.round.truth;
  if (!truth || typeof truth.lat !== "number") { el.textContent = ""; return; }
  const g = guessMarker.getLatLng();
  const km = haversineKm(
    truth.lat, truth.lng, g.lat, L.Util.wrapNum(g.lng, [-180, 180], true));
  const elapsed = Math.max(0, Date.now() - (room.round.startedAt || Date.now()));
  const est = lockNowEstimate(km, elapsed, room.settings.roundSeconds);
  el.textContent = lockNowLabel(est, superSureArmed);
  el.classList.toggle("armed", superSureArmed);
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
  $("pGuessHint").textContent = guessMarker
    ? "Drag to adjust, then lock it in"
    : "Tap the map to drop your pin — rivals can see it move";
  renderSuperSureToggle();
  // First guess map ever: the scoring one-liner, the rival-pins warning,
  // and the SUPER SURE stakes — at the moment they matter (M5 + M3).
  oneShotHint("guessmap", {
    title: "Drop your pin",
    lines: guessMapHintLines("h2h", superSureAvailable(room.teams, myTeam)),
  });
  updateLockNowHint();
  setTimeout(() => guessMap.invalidateSize(), 50);
  updateRivalPins();
  scheduleLiveWrite();
}

/* ---------------- SUPER SURE: arm/disarm the one-per-game bet --------- */

// The toggle lives on this phone's own guess screen only. Arming is purely
// local state until lock-in commits it — nothing about the bet ever rides
// on the live feed, so rivals can't learn it before the reveal.
function toggleSuperSure() {
  if (!room || myResult() || !superSureAvailable(room.teams, myTeam)) return;
  superSureArmed = !superSureArmed;
  renderSuperSureToggle();
  updateLockNowHint(); // the pill flips to the bet's doubled stakes
  toast(superSureArmed
    ? "SUPER SURE armed: closest pin wins ×2 — anyone closer and you get 0"
    : "SUPER SURE disarmed — bet saved for later");
}

function renderSuperSureToggle() {
  const btn = $("btnSuperSure");
  const available = room && superSureAvailable(room.teams, myTeam);
  btn.disabled = !available;
  btn.classList.toggle("armed", !!available && superSureArmed);
  if (!available) {
    btn.textContent = "SUPER SURE — spent";
  } else if (superSureArmed) {
    btn.textContent = "🔥 SUPER SURE ARMED — ×2 or 0";
  } else {
    btn.textContent = "🔥 SUPER SURE · double or nothing · once per game";
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
        live.pose = { bearing: pov.bearing, center, zoom };
      } else if (localStage === "map" && guessMap) {
        const c = guessMap.getCenter();
        live.view = {
          lat: c.lat,
          lng: L.Util.wrapNum(c.lng, [-180, 180], true),
          zoom: guessMap.getZoom(),
        };
        if (guessMarker) {
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

function lockIn(auto = false) {
  if (!room || room.phase !== "roundActive" || !room.round || myResult()) return;
  const truth = room.round.truth;
  let guess = null;
  if (guessMarker) {
    const g = guessMarker.getLatLng();
    guess = { lat: g.lat, lng: L.Util.wrapNum(g.lng, [-180, 180], true) };
  }
  if (!guess && !auto) return; // manual lock needs a pin; timeout may forfeit
  if (guess) { playSound("stamp"); buzz(35); } // S4: the lock-in beat
  const distanceKm = guess
    ? haversineKm(truth.lat, truth.lng, guess.lat, guess.lng)
    : null;
  // Speed clock: round start to this lock-in, on this phone's clock (the
  // same clock the countdown already trusts). Clamped ≥0 against skew.
  const submittedAt = Date.now();
  const elapsedMs = Math.max(0, submittedAt - (room.round.startedAt || submittedAt));
  const distancePoints = guess ? scoreForDistance(distanceKm) : 0;
  const speedBonus = guess
    ? timeBonus(distancePoints, elapsedMs, bonusWindowMs(room.settings.roundSeconds))
    : 0;
  const points = distancePoints + speedBonus;
  // An armed bet commits here — with a pin it rides on the result; with no
  // pin at the buzzer it rides on the forfeit and burns at settlement.
  // Either way the one use is spent (superSureUsed on the team row).
  const betting = superSureArmed && superSureAvailable(room.teams, myTeam);
  superSureArmed = false;
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
  };
  cancelLiveWrite();
  const patch = {
    [`round/results/${myTeam}`]: result,
    [`teams/${myTeam}/total`]: (room.teams[myTeam].total || 0) + points,
    [`round/live/${myTeam}/stage`]: "locked",
    [`round/live/${myTeam}/pin`]: null, // final pin stays secret until reveal
  };
  if (betting) patch[`teams/${myTeam}/superSureUsed`] = room.round.number;
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
    });
  }
  if (auto && !guess) {
    toast(betting
      ? "Time! SUPER SURE with no pin — the bet is burned."
      : "Time! No pin — no points this round.");
  } else if (auto) {
    toast("Time! Your pin was locked in.");
  }
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
    status.textContent = r ? `✓ in (#${submitRank(room.round, id)})` : "…thinking";
    status.style.color = r ? "var(--good)" : "var(--muted)";
    li.append(name, status);
    list.appendChild(li);
  }
}

function renderLockedScreen() {
  if (shownScreen !== "p-locked") showScreen("p-locked");
  const rank = submitRank(room.round, myTeam);
  $("pLockedRank").textContent = rank ? `#${rank} to lock in` : "";
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
  updateLockNowHint(); // the speed bonus decays in real time
  const endsAt = room.round.endsAt;
  const timerEl = $("pHudTimer");
  const mapTimerEl = $("pGuessTimer"); // timer stays visible on the map too
  if (!endsAt) {
    timerEl.textContent = "∞";
    mapTimerEl.textContent = "";
    timerEl.classList.remove("low");
    mapTimerEl.classList.remove("low");
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
    if (left <= 0 && !myResult() && !autoSubmitted) {
      // Time's up: lock whatever pin this phone has (or forfeit with none).
      autoSubmitted = true;
      lockIn(true);
    }
    if (isHost() && Date.now() > endsAt + FORFEIT_GRACE_MS) {
      // Referee of last resort: a phone that died can't stall the party.
      sweepAndReveal();
    } else if (myResult() && Date.now() > endsAt + FORFEIT_GRACE_MS * 3) {
      // ...and if the dead phone IS the host's, any locked-in phone steps up.
      sweepAndReveal(true);
    }
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
  if (mine && mine.guess) {
    $("pRevealDistance").textContent = formatDistance(mine.distanceKm);
    $("pRevealPoints").textContent = `+${adjustedPoints(mine).toLocaleString()}`;
  } else {
    $("pRevealDistance").textContent = "no pin";
    // A burned bet is not a plain forfeit: "0" (you bet it), not "+0".
    $("pRevealPoints").textContent = mine && mine.superSure ? "0" : "+0";
  }
  // SUPER SURE verdict line under the points card (injected — HTML
  // untouched). Only the bettor's own card carries it; the round list
  // below shows everyone's.
  let ssEl = $("pRevealSuperSure");
  if (!ssEl) {
    ssEl = document.createElement("div");
    ssEl.id = "pRevealSuperSure";
    ssEl.className = "ss-note";
    $("pRevealPoints").closest(".stat-card").appendChild(ssEl);
  }
  if (mine && mine.superSure) {
    ssEl.textContent = `🔥 ${superSureLabel(mine)}`;
    ssEl.classList.toggle("lost", mine.superSureOutcome !== "won");
  } else {
    ssEl.textContent = "";
  }
  // Speed line under the points card (injected — HTML untouched).
  let speedEl = $("pRevealSpeed");
  if (!speedEl) {
    speedEl = document.createElement("div");
    speedEl.id = "pRevealSpeed";
    speedEl.className = "time-note";
    $("pRevealPoints").closest(".stat-card").appendChild(speedEl);
  }
  if (mine && mine.guess && typeof mine.elapsedMs === "number") {
    speedEl.textContent =
      `${mine.distancePoints.toLocaleString()} distance` +
      ` + ⚡${mine.timeBonus.toLocaleString()} speed` +
      ` · answered in ${formatSeconds(mine.elapsedMs)}`;
    speedEl.classList.toggle("zero", !mine.timeBonus);
  } else {
    speedEl.textContent = "";
  }

  // This round, closest first (reveal order reversed).
  const list = $("pRoundResults");
  list.innerHTML = "";
  revealOrder(round).slice().reverse().forEach((r, i) => {
    const li = document.createElement("li");
    if (i === 0 && r.guess) li.classList.add("active");
    const name = document.createElement("span");
    name.textContent = (i === 0 && r.guess ? "👑 " : "") + room.teams[r.id].name;
    name.style.color = teamHex(room.teams, r.id);
    const val = document.createElement("span");
    val.textContent = resultRowText(r);
    li.append(name, val);
    list.appendChild(li);
  });

  renderTotalsList($("pRevealTotals"));

  const host = isHost();
  $("btnPNext").classList.toggle("hidden", !host);
  $("btnPNext").textContent = last ? "Finish Game" : "Next Round";
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
function renderRevealMap(round) {
  if (revealMapShownFor === round.number) return;
  if (!round.truth || typeof round.truth.lat !== "number") return;
  destroyRevealMap();
  revealMapShownFor = round.number;
  revealMap = L.map("pRevealMap", {
    zoomControl: false, dragging: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false,
  });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(revealMap);
  const truth = L.latLng(round.truth.lat, round.truth.lng);
  const pins = revealPins(round);
  revealMap.fitBounds(
    L.latLngBounds([truth, ...pins.map((p) => L.latLng(p.lat, p.lng))])
      .pad(0.25),
    { maxZoom: 10 }
  );
  for (const p of pins) {
    const guess = L.latLng(p.lat, p.lng);
    const color = teamHex(room.teams, p.id);
    L.polyline([guess, truth], { color, weight: 3, dashArray: "6 8" })
      .addTo(revealMap);
    L.circleMarker(guess, {
      radius: 8, color: "#fff", weight: 2, fillColor: color, fillOpacity: 1,
    }).addTo(revealMap);
    // The no-screen h2h payoff surface: a super-sure pin wears its verdict
    // right on the map (halo + label) — reveal-only, per the hidden rule.
    if (p.superSure) {
      L.circleMarker(guess, {
        radius: 14, color: "#ffcf3f", weight: 3, fill: false,
        dashArray: "4 6", interactive: false,
      }).addTo(revealMap)
        .bindTooltip(
          p.superSureOutcome === "won" ? "SUPER SURE ×2" : "SUPER SURE — 0",
          { permanent: true, direction: "bottom", className: "ss-tooltip" });
    }
  }
  L.circleMarker(truth, {
    radius: 10, color: "#111", weight: 3, fillColor: "#ffcf3f", fillOpacity: 1,
  }).addTo(revealMap);
  setTimeout(() => revealMap && revealMap.invalidateSize({ pan: false }), 60);
}

function destroyRevealMap() {
  if (revealMap) {
    try { revealMap.remove(); } catch { /* already gone */ }
    revealMap = null;
  }
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
  } else {
    startRound(via);
  }
}

/* ---------------- Game over & handoff ---------------- */

function renderGameOver() {
  showScreen("p-gameover");
  if (!fanfarePlayed) { fanfarePlayed = true; playSound("fanfare"); } // S4
  destroyViewer();
  const winner = room.hostTeam; // rotated to the winner at finish
  const winnerName = room.teams[winner] ? room.teams[winner].name : "The winner";
  const iWon = winner === myTeam;
  $("pGameOverTitle").textContent = iWon ? "🏆 You won!" : "Game over!";
  renderTotalsList($("pFinalTotals"));
  $("btnPNextGame").classList.toggle("hidden", !iWon);
  $("pHandoffNote").textContent = iWon
    ? "Winner runs the table: your phone is the host now. Set up the next game and everyone follows automatically."
    : `${winnerName} won — their phone is the host now. Stay here; you'll follow into their next game automatically.`;
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

function openNextGameSetup() {
  // Carry the current settings into the setup segs.
  for (const [seg, val] of [
    ["nSegRounds", String(room.settings.roundCount)],
    ["nSegSeconds", String(room.settings.roundSeconds)],
    ["nSegMove", room.settings.moveAllowed ? "1" : "0"],
    ["nSegDifficulty", normalizeDifficulty(room.settings.difficulty)],
  ]) {
    const el = $(seg);
    el.dataset.value = val;
    for (const b of el.querySelectorAll("button")) {
      b.classList.toggle("sel", b.dataset.v === val);
    }
  }
  showScreen("p-next");
}

async function createNextGame() {
  if (!isHost() || !room || room.phase !== "gameOver") return;
  $("btnNextCreate").disabled = true;
  try {
    const oldCode = roomCode;
    const code = await pickFreeRoomCode();
    const teams = carryTeams(room.teams);
    const state = initialH2hRoomState(collectSettings("n"), teams, myTeam);
    switchingRooms = true; // stop reacting to the old room mid-handoff
    writeRoom(code, state).catch((e) =>
      console.warn("Firebase write failed:", e));
    // Queued after the new room's write on the same connection: by the time
    // any subscriber sees the pointer, the room exists (couch pattern).
    updateRoom(oldCode, { nextRoom: code }).catch((e) =>
      console.warn("nextRoom pointer write failed:", e));
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
    });
    enterRoom(code, myTeam);
  } catch (e) {
    console.error(e);
    switchingRooms = false;
    toast("Could not create the next game");
  } finally {
    $("btnNextCreate").disabled = false;
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
wireSeg("nSegRounds");
wireSeg("nSegSeconds");
wireSeg("nSegMove");
wireSeg("nSegDifficulty");

$("btnCreateRoom").addEventListener("click", createRoom);
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
$("btnSuperSure").addEventListener("click", toggleSuperSure);
$("btnLockIn").addEventListener("click", () => lockIn(false));
$("btnCloseRound").addEventListener("click", sweepAndReveal);
$("btnPNext").addEventListener("click", nextOrFinish);
$("btnPHold").addEventListener("click", holdAdvance);
$("btnPHome").addEventListener("click", () => leaveToHome());
$("btnPShareResult").addEventListener("click", shareMyResult);
$("btnPNextGame").addEventListener("click", openNextGameSetup);
$("btnNextCreate").addEventListener("click", createNextGame);

$("joinCode").addEventListener("input", () => {
  $("joinCode").value = $("joinCode").value.toUpperCase()
    .replace(/[^A-HJ-NP-Z]/g, "");
  $("joinErr").textContent = "";
});

onConnectionChange((isConnected) => {
  $("connPill").classList.toggle("hidden", isConnected);
});

// QR deep-link: player.html?room=CODE prefills the code; the joiner only
// types a team name. That's the whole join flow. The landing's chooser
// arrives with ?create=1 instead — a party starter, not a joiner.
const urlParams = new URLSearchParams(location.search);
const urlCode = (urlParams.get("room") || "").toUpperCase();
if (isValidRoomCode(urlCode)) {
  $("joinCode").value = urlCode;
  $("myTeamName").focus();
} else if (urlParams.get("create") === "1") {
  $("myTeamName").focus();
}

initSound("player"); // S4: muted by default on phones; 🔇 toggle persists
showScreen("p-home");
janitor();
renderResumeBanner();
