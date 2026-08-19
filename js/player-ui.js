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
} from "./h2h.js";
import { loadPool, PoolSampler } from "./pool.js";
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
let currentImageId = null;
let guessMap = null;
let guessMarker = null;

let localStage = "explore"; // "explore" (pano) | "map" — this phone's UI mode
let lastRoundSeen = null;   // round number the UI has been reset for
let autoSubmitted = false;  // timeout auto-lock fired for this round
let sweepDone = false;      // host forfeit sweep fired for this round
let revealFlipPushed = null; // round number this phone already flipped for
let revealTracked = null;   // round number reveal_shown was captured for (host)
let prevSubmitted = 0;      // for "Team X locked in!" toasts
let tickInterval = null;
let revealFlipTimer = null; // phone-side hold during the TV countdown

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
      mode: "h2h",
      num_teams: 1, // teams join the lobby after creation
      num_rounds: state.settings.roundCount,
      round_seconds: state.settings.roundSeconds,
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
  roomCode = code;
  myTeam = teamId;
  room = null;
  sampler = null;
  lastRoundSeen = null;
  autoSubmitted = false;
  sweepDone = false;
  revealFlipPushed = null;
  revealTracked = null;
  prevSubmitted = 0;
  localStage = "explore";
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
  clearTimeout(revealFlipTimer);
  destroyViewer();
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
    push({ phase: "reveal", "round/revealAt": Date.now() + REVEAL_COUNTDOWN_MS });
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
}

/* ---------------- Lobby ---------------- */

function renderLobby() {
  lastRoundSeen = null;
  if (shownScreen !== "p-lobby") {
    showScreen("p-lobby");
    $("pRoomCodeHuge").textContent = roomCode;
    const joinUrl = new URL(`player.html?room=${roomCode}`, location.href).href;
    const screenUrl = new URL(`screen.html?room=${roomCode}`, location.href).href;
    $("pJoinUrl").textContent = `Teams join at ${joinUrl}`;
    drawQr($("pQrCanvas"), joinUrl);
    $("pScreenNote").dataset.screenUrl = screenUrl;
  }

  // TV presence comes free with the room subscription (screenHeartbeat).
  const note = $("pScreenNote");
  const beat = room.screenHeartbeat;
  if (beat && Date.now() - beat < 30_000) {
    note.textContent = "TV connected ✓";
    note.classList.add("ok");
  } else {
    note.textContent = `TV: open ${note.dataset.screenUrl || "screen.html"} and enter ${roomCode}`;
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

/* ---------------- Round start (host only) ---------------- */

async function ensureSampler() {
  if (!pool) pool = await loadPool();
  if (!sampler) sampler = new PoolSampler(pool, roomCode, room.poolCursor || 0);
}

async function startRound() {
  if (!isHost() || !h2hCanTransition(room.phase, "roundActive")) return;
  $("btnPStart").disabled = true;
  $("btnPNext").disabled = true;
  try {
    await ensureSampler();
    // The host phone validates imagery before committing the round, same
    // dead-image skip as couch mode — everyone else just follows imageId.
    showScreen("p-round");
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
    track("round_started", { room: roomCode, mode: "h2h", round_number: number });
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
    clearTimeout(revealFlipTimer);
    if (guessMarker) { guessMarker.remove(); guessMarker = null; }
    if (guessMap) guessMap.setView([25, 10], 2);
    $("btnLockIn").disabled = true;
    startTick();
  }

  if (myResult()) {
    renderLockedScreen();
    return;
  }

  if (localStage === "map") {
    if (shownScreen !== "p-guess") openGuessMapScreen();
  } else {
    if (shownScreen !== "p-round") {
      showScreen("p-round");
      if (viewer) viewer.resize();
    }
    if (!viewer) makeViewer();
    if (currentImageId !== round.imageId && viewer) {
      const target = round.imageId;
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
    }
    scheduleLiveWrite();
    $("btnLockIn").disabled = false;
  });
}

function openGuessMapScreen() {
  localStage = "map";
  showScreen("p-guess");
  ensureGuessMap();
  $("btnLockIn").disabled = !guessMarker;
  $("pGuessHint").textContent = guessMarker
    ? "Drag to adjust, then lock it in"
    : "Tap the map to drop your pin";
  setTimeout(() => guessMap.invalidateSize(), 50);
  scheduleLiveWrite();
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
  const result = {
    guess,
    distanceKm,
    points,
    distancePoints,
    timeBonus: speedBonus,
    elapsedMs: guess ? elapsedMs : null,
    submittedAt,
    forfeited: guess ? null : true,
  };
  cancelLiveWrite();
  const patch = {
    [`round/results/${myTeam}`]: result,
    [`teams/${myTeam}/total`]: (room.teams[myTeam].total || 0) + points,
    [`round/live/${myTeam}/stage`]: "locked",
    [`round/live/${myTeam}/pin`]: null, // final pin stays secret until reveal
  };
  // Last one in flips the room to reveal and stamps the countdown moment.
  // If two phones race the flip, both write the same phase and revealAt
  // values milliseconds apart — last-write-wins is harmless here.
  const others = teamIds(room.teams).filter((id) => id !== myTeam);
  const results = (room.round && room.round.results) || {};
  if (others.every((id) => !!results[id])) {
    patch.phase = "reveal";
    patch["round/revealAt"] = Date.now() + REVEAL_COUNTDOWN_MS;
  }
  push(patch);
  if (guess) {
    // Aggregates only — the pin itself never leaves the device. Forfeits
    // (no pin at the buzzer) aren't guesses, so they aren't tracked here.
    track("guess_submitted", {
      room: roomCode,
      mode: "h2h",
      team_id: myTeam,
      distance_km: distanceKm,
      time_bonus: speedBonus,
      total_score: points,
      time_seconds: elapsedMs / 1000,
    });
  }
  if (auto && !guess) toast("Time! No pin — no points this round.");
  else if (auto) toast("Time! Your pin was locked in.");
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
  const patch = {
    phase: "reveal",
    "round/revealAt": Date.now() + REVEAL_COUNTDOWN_MS,
  };
  for (const id of pending) {
    patch[`round/results/${id}`] = {
      guess: null, distanceKm: null, points: 0,
      distancePoints: 0, timeBonus: 0, elapsedMs: null,
      submittedAt: Date.now(), forfeited: true,
    };
    patch[`round/live/${id}/stage`] = "locked";
  }
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
  const endsAt = room.round.endsAt;
  const timerEl = $("pHudTimer");
  const mapTimerEl = $("pGuessTimer"); // timer stays visible on the map too
  if (!endsAt) {
    timerEl.textContent = "∞";
    mapTimerEl.textContent = "";
  } else {
    const left = endsAt - Date.now();
    timerEl.textContent = formatCountdown(left);
    mapTimerEl.textContent = formatCountdown(left);
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

  // Hold the phones during the TV's countdown so the place name doesn't
  // leak early — the phone literally says "look up".
  const wait = (round.revealAt || 0) - Date.now();
  if (wait > 150) {
    if (shownScreen !== "p-locked") showScreen("p-locked");
    $("pLockedRank").textContent = "Everyone's in!";
    renderLockedRoster();
    $("btnCloseRound").classList.add("hidden");
    clearTimeout(revealFlipTimer);
    revealFlipTimer = setTimeout(() => {
      if (room && room.phase === "reveal") renderReveal();
    }, wait + 50);
    return;
  }

  showScreen("p-reveal");
  // Host phone only, once per round — mirrors round_started's cardinality
  // so the funnel counts rounds, not phones.
  if (isHost() && revealTracked !== round.number) {
    revealTracked = round.number;
    track("reveal_shown", {
      room: roomCode, mode: "h2h", round_number: round.number,
    });
  }
  const last = round.number >= room.settings.roundCount;
  $("pRevealHeading").textContent =
    `Round ${round.number} of ${room.settings.roundCount}`;
  $("pRevealPlace").textContent = (round.truth && round.truth.name) || "—";
  const mine = myResult();
  if (mine && mine.guess) {
    $("pRevealDistance").textContent = formatDistance(mine.distanceKm);
    $("pRevealPoints").textContent = `+${mine.points.toLocaleString()}`;
  } else {
    $("pRevealDistance").textContent = "no pin";
    $("pRevealPoints").textContent = "+0";
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
  $("pRevealNote").textContent = host
    ? ""
    : `${room.teams[room.hostTeam] ? room.teams[room.hostTeam].name : "The host"} starts the next round…`;
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

function nextOrFinish() {
  if (!isHost() || !room || room.phase !== "reveal") return;
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
    });
  } else {
    startRound();
  }
}

/* ---------------- Game over & handoff ---------------- */

function renderGameOver() {
  showScreen("p-gameover");
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

function openNextGameSetup() {
  // Carry the current settings into the setup segs.
  for (const [seg, val] of [
    ["nSegRounds", String(room.settings.roundCount)],
    ["nSegSeconds", String(room.settings.roundSeconds)],
    ["nSegMove", room.settings.moveAllowed ? "1" : "0"],
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
      mode: "h2h",
      num_teams: teamIds(teams).length, // carried over from the last game
      num_rounds: state.settings.roundCount,
      round_seconds: state.settings.roundSeconds,
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
wireSeg("nSegRounds");
wireSeg("nSegSeconds");
wireSeg("nSegMove");

$("btnCreateRoom").addEventListener("click", createRoom);
$("btnJoin").addEventListener("click", joinRoom);
$("btnPLeave").addEventListener("click", leaveOrAbandon);
$("btnPStart").addEventListener("click", startRound);
$("btnOpenMap").addEventListener("click", openGuessMapScreen);
$("btnBackToStreet").addEventListener("click", backToStreet);
$("btnLockIn").addEventListener("click", () => lockIn(false));
$("btnCloseRound").addEventListener("click", sweepAndReveal);
$("btnPNext").addEventListener("click", nextOrFinish);
$("btnPHome").addEventListener("click", () => leaveToHome());
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
// types a team name. That's the whole join flow.
const urlCode = (new URLSearchParams(location.search).get("room") || "")
  .toUpperCase();
if (isValidRoomCode(urlCode)) {
  $("joinCode").value = urlCode;
  $("myTeamName").focus();
}

showScreen("p-home");
janitor();
renderResumeBanner();
