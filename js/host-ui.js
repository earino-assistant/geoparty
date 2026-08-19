// host-ui.js — operator phone controller. The host is the single source of
// truth: it holds full game state locally and pushes it to Firebase.

import { MAPILLARY_TOKEN } from "../config.js";
import {
  readRoom,
  writeRoom,
  updateRoom,
  deleteRoom,
  subscribeHeartbeat,
  onConnectionChange,
} from "./firebase.js";
import {
  canTransition,
  makeRoomCode,
  haversineKm,
  scoreForDistance,
  bonusWindowMs,
  timeBonus,
  formatSeconds,
  resultRowText,
  formatDistance,
  formatCountdown,
  teamForRound,
  teamIds,
  defaultTeams,
  initialRoomState,
  standings,
  isShowdownRound,
  showdownOrder,
  showdownResults,
} from "./game.js";
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
import { withUtm, partyShareText, foldBestMoment } from "./share.js";
import { shareResult, shareTvLink } from "./share-ui.js";
import { screenLink, tvBrowserLine } from "./tvlink.js";
import {
  AUTO_ADVANCE_MS,
  autoAdvanceStatus,
  shouldAutoAdvance,
  advanceTarget,
  advanceSecondsLeft,
  countdownText,
  holdAdvancePatch,
} from "./autoadvance.js";
import { countdownTick } from "./fx.js";
import { initSound, playSound, buzz, stampFlash } from "./fx-ui.js";
import { loadPool, PoolSampler } from "./pool.js";
import { drawQr } from "./qr.js";
import { track } from "./consent.js";

/* ================================================================
 * DOM helpers
 * ================================================================ */

const $ = (id) => document.getElementById(id);
const SCREENS = ["h-setup", "h-lobby", "h-round", "h-guess", "h-reveal", "h-gameover"];

// Concrete hex values of --team-1..4: Leaflet paints SVG markers with these,
// and CSS var() strings don't resolve there.
const TEAM_HEX = ["#ffcf3f", "#4dd6ff", "#ff6ec7", "#7dff8a"];
const teamHex = (teams, id) =>
  TEAM_HEX[teamIds(teams).indexOf(id) % TEAM_HEX.length];

// Leaflet tooltip content is HTML; team names are user input.
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function showScreen(id) {
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

/* ================================================================
 * localStorage: leaderboard, active room, janitor bookkeeping
 * ================================================================ */

const LS_LEADERBOARD = "geoparty_leaderboard";
const LS_ACTIVE = "geoparty_active_room";
const LS_MY_ROOMS = "geoparty_my_rooms";

const lsGet = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
};
const lsSet = (key, val) => localStorage.setItem(key, JSON.stringify(val));

function renderLeaderboard() {
  const list = $("leaderboardList");
  const top = lsGet(LS_LEADERBOARD, [])
    .slice()
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, 10);
  list.innerHTML = "";
  if (top.length === 0) {
    list.innerHTML = '<li class="empty">No games saved yet</li>';
    return;
  }
  for (const e of top) {
    const li = document.createElement("li");
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = `${e.teamName} · ${e.rounds} rounds · ${e.date}`;
    const pts = document.createElement("span");
    pts.className = "pts";
    pts.textContent = e.totalScore.toLocaleString();
    li.append(who, pts);
    list.appendChild(li);
  }
}

// Best-effort janitor (spec §12): rules can't be listed from the client, so
// we clean up the rooms this device created that are older than 24h.
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
 * Game state (host-local authority)
 * ================================================================ */

let room = null;          // full state mirror; host writes, never re-reads
let roomCode = null;
let sampler = null;       // PoolSampler for this room
let currentTruth = null;  // pool entry backing the active round
let gameBest = null;      // closest guess so far — the share card's brag (S1)
let connected = true;

let viewer = null;        // MapillaryJS viewer
let guessMap = null;      // Leaflet map
let guessMarker = null;
let superSureArmed = false; // active team's SUPER SURE toggle, this pin only
let timerInterval = null;
let unsubHeartbeat = null;
let heartbeatSeen = false;
let prevRoomCode = null;  // finished room to leave a nextRoom pointer in,
                          // so a still-subscribed screen follows us over

function persistActive() {
  lsSet(LS_ACTIVE, { code: roomCode, createdAt: room.createdAt });
}

// Mirror a host-local state change to Firebase, fire-and-forget: RTDB write
// promises don't settle while disconnected, so the game flow must never
// await them (degraded single-screen mode, spec §12).
function push(patch) {
  updateRoom(roomCode, patch).catch((e) => {
    console.warn("Firebase write failed (continuing locally):", e);
  });
}

function setPhase(next) {
  if (!canTransition(room.phase, next)) {
    console.error(`Illegal transition ${room.phase} -> ${next}`);
    return false;
  }
  room.phase = next;
  return true;
}

/* ================================================================
 * Setup screen
 * ================================================================ */

function wireSeg(segId, onChange) {
  const seg = $(segId);
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    seg.dataset.value = btn.dataset.v;
    for (const b of seg.querySelectorAll("button")) {
      b.classList.toggle("sel", b === btn);
    }
    if (onChange) onChange(btn.dataset.v);
  });
}

function renderTeamNameInputs(count) {
  const wrap = $("teamNames");
  const existing = [...wrap.querySelectorAll("input")].map((i) => i.value);
  wrap.innerHTML = "";
  if (count === 1) return; // single team defaults to "Everyone"
  for (let i = 0; i < count; i++) {
    const input = document.createElement("input");
    input.placeholder = `Team ${i + 1} name`;
    input.maxLength = 24;
    input.value = existing[i] || "";
    wrap.appendChild(input);
  }
}

function collectSettings() {
  return {
    roundCount: parseInt($("segRounds").dataset.value, 10),
    roundSeconds: parseInt($("segSeconds").dataset.value, 10), // 0 = no limit
    moveAllowed: $("segMove").dataset.value === "1",
  };
}

function collectTeams() {
  const count = parseInt($("segTeams").dataset.value, 10);
  if (count === 1) return defaultTeams();
  const inputs = [...$("teamNames").querySelectorAll("input")];
  const teams = {};
  for (let i = 0; i < count; i++) {
    teams[`t${i + 1}`] = {
      name: (inputs[i] && inputs[i].value.trim()) || `Team ${i + 1}`,
      total: 0,
    };
  }
  return teams;
}

async function newGame() {
  $("btnNewGame").disabled = true;
  try {
    const pool = await loadPool();
    let code = makeRoomCode();
    for (let i = 0; i < 5; i++) {
      // Avoid colliding with a live room; extremely unlikely, best effort —
      // time-boxed so an offline host can still create a game.
      try {
        const existing = await Promise.race([
          readRoom(code),
          new Promise((res) => setTimeout(() => res(null), 1500)),
        ]);
        if (!existing) break;
      } catch { break; }
      code = makeRoomCode();
    }
    roomCode = code;
    room = initialRoomState(collectSettings(), collectTeams(), roomCode);
    sampler = new PoolSampler(pool, roomCode, 0);
    currentTruth = null;
    gameBest = null;
    writeRoom(roomCode, room).catch((e) =>
      console.warn("Firebase write failed (continuing locally):", e));
    if (prevRoomCode && prevRoomCode !== roomCode) {
      // Queued after the new room's write on the same connection, so by the
      // time any subscriber of the old room sees the pointer, the new room
      // exists. The pointer lives inside the old room and is cleaned up
      // with it by the janitor.
      updateRoom(prevRoomCode, { nextRoom: roomCode }).catch((e) =>
        console.warn("nextRoom pointer write failed:", e));
    }
    prevRoomCode = null;
    persistActive();
    const mine = lsGet(LS_MY_ROOMS, []);
    mine.push({ code: roomCode, createdAt: room.createdAt });
    lsSet(LS_MY_ROOMS, mine);
    track("game_created", {
      mode: "couch",
      num_teams: teamIds(room.teams).length,
      num_rounds: room.settings.roundCount,
      round_seconds: room.settings.roundSeconds,
    });
    enterLobby();
  } catch (e) {
    console.error(e);
    toast("Could not create game — see console");
  } finally {
    $("btnNewGame").disabled = false;
  }
}

/* ================================================================
 * Lobby
 * ================================================================ */

function enterLobby() {
  showScreen("h-lobby");
  $("roomCodeHuge").textContent = roomCode;
  // The Add a TV affordance: scan-and-cast QR (any spare device becomes the
  // screen), one-tap link share, and the typing fallback line — never a raw
  // URL. The line hides itself on file://, where nothing is typeable.
  drawQr($("qrCanvas"), screenLink(location.href, roomCode, "qr"));
  $("tvType").textContent = tvBrowserLine(location.href) || "";
  heartbeatSeen = false;
  updateLobbyReadiness();
  if (unsubHeartbeat) unsubHeartbeat();
  unsubHeartbeat = subscribeHeartbeat(roomCode, (ts) => {
    if (ts) heartbeatSeen = true;
    updateLobbyReadiness();
  });
}

function updateLobbyReadiness() {
  const note = $("waitingNote");
  if (heartbeatSeen) {
    note.textContent = "TV connected — ready when you are.";
    note.classList.add("ok");
    $("btnStartRound").disabled = false;
  } else if (!connected) {
    // Degraded single-screen mode (spec §12): the party survives offline.
    note.textContent = "Offline — you can play on this phone alone.";
    note.classList.remove("ok");
    $("btnStartRound").disabled = false;
  } else {
    note.textContent = "The game starts the moment a screen joins…";
    note.classList.remove("ok");
    $("btnStartRound").disabled = true;
  }
}

async function abandonGame() {
  track("game_abandoned", {
    room: roomCode,
    mode: "couch",
    rounds_played: room && room.round ? room.round.number : 0,
  });
  stopTimer();
  stopLockNowTicker();
  stopAdvanceTicker();
  if (unsubHeartbeat) { unsubHeartbeat(); unsubHeartbeat = null; }
  try { await deleteRoom(roomCode); } catch (e) { console.warn(e); }
  localStorage.removeItem(LS_ACTIVE);
  destroyViewer();
  room = null;
  roomCode = null;
  enterSetup();
}

/* ================================================================
 * Round: MapillaryJS viewer + pose sync
 * ================================================================ */

function makeViewer() {
  destroyViewer();
  const moveAllowed = room.settings.moveAllowed;
  viewer = new mapillary.Viewer({
    accessToken: MAPILLARY_TOKEN,
    container: "hostViewer",
    component: {
      cover: false,
      // "No moving" mode locks navigation but keeps look-around (spec §6).
      direction: moveAllowed,
      sequence: moveAllowed,
      keyboard: moveAllowed,
      zoom: true,
      bearing: true,
    },
  });
  viewer.on("pov", schedulePoseWrite);
  viewer.on("position", schedulePoseWrite);
  viewer.on("image", (ev) => {
    if (room && room.round && ev.image.id !== room.round.imageId) {
      room.round.imageId = ev.image.id;
      push({ "round/imageId": ev.image.id });
    }
    schedulePoseWrite();
  });
}

function destroyViewer() {
  if (viewer) {
    try { viewer.remove(); } catch { /* already gone */ }
    viewer = null;
  }
}

// Throttle pose writes to at most 4/second (spec §1).
let poseTimer = null;
let poseDirty = false;
function schedulePoseWrite() {
  poseDirty = true;
  if (poseTimer) return;
  poseTimer = setTimeout(async () => {
    poseTimer = null;
    if (!poseDirty || !viewer || !room || room.phase !== "roundActive") return;
    poseDirty = false;
    try {
      const [pov, center, zoom] = await Promise.all([
        viewer.getPointOfView(),
        viewer.getCenter(),
        viewer.getZoom(),
      ]);
      const pose = { bearing: pov.bearing, center, zoom };
      room.round.pose = pose;
      push({ "round/pose": pose });
    } catch { /* viewer mid-navigation; next tick catches up */ }
  }, 250);
}

async function startRound(advance) {
  if (!setPhase("roundActive")) return;
  stopAdvanceTicker();
  // "auto" only from the S6 ticker; a click event lands here otherwise.
  const via = advance === "auto" ? "auto"
    : room.round ? "manual" : null; // round 1 follows no reveal
  const number = (room.round ? room.round.number : 0) + 1;
  showScreen("h-round");
  if (!viewer) makeViewer();

  // Sample the pool, skipping dead imagery silently (spec §9).
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
    room.phase = "reveal"; // allow reveal -> gameOver transition
    finishGame();
    return;
  }
  currentTruth = entry;
  sampler.advance();

  const now = Date.now();
  const secs = room.settings.roundSeconds;
  const showdown = isShowdownRound(room.teams, room.settings, number);
  room.round = {
    number,
    imageId: entry.image_id,
    startedAt: now,
    // Speed clock anchor: equals startedAt for solo rounds; showdown
    // handoffs reset it so each team's time bonus reflects its own turn.
    turnStartedAt: now,
    endsAt: secs > 0 ? now + secs * 1000 : null,
    pose: { bearing: 0 },
    truth: null,
    liveGuess: null,
    liveView: null,
    guess: null,
    score: null,
    // Final Showdown: every team pins the same location, leader first;
    // per-team guesses accumulate in results until the all-at-once reveal.
    showdown,
    order: showdown ? showdownOrder(room.teams) : null,
    results: null,
  };
  room.activeTeam = showdown
    ? room.round.order[0]
    : teamForRound(room.teams, number, roomCode);
  room.poolCursor = sampler.cursor;
  push({
    phase: "roundActive",
    round: room.round,
    activeTeam: room.activeTeam,
    poolCursor: room.poolCursor,
  });
  track("round_started", {
    room: roomCode, mode: "couch", round_number: number,
    ...(via ? { advance: via } : {}),
  });

  $("hudRound").textContent = `Round ${number}/${room.settings.roundCount}`;
  $("hudTeam").textContent = roundTeamLabel();
  // First-time education (M5): the showdown gets its one-rule interstitial;
  // an ordinary first pano teaches the loop's first move. One shot each.
  if (showdown) {
    oneShotHint("showdown", HINT_CARDS.showdown);
  } else {
    oneShotHint("pano", HINT_CARDS.pano);
  }
  startTimer();
}

// HUD label for the round screen: the active team, or the showdown banner.
function roundTeamLabel() {
  if (teamIds(room.teams).length <= 1) return "";
  if (room.round && room.round.showdown) return "FINAL SHOWDOWN";
  return room.teams[room.activeTeam].name;
}

let lastTickSecond = null; // S4: last countdown second this phone ticked for

function startTimer() {
  stopTimer();
  lastTickSecond = null;
  const tick = () => {
    if (!room || !room.round) return;
    const endsAt = room.round.endsAt;
    if (!endsAt) {
      $("hudTimer").textContent = "∞";
      $("hudTimer").classList.remove("low");
      return;
    }
    const left = endsAt - Date.now();
    $("hudTimer").textContent = formatCountdown(left);
    // S4: countdown pulse + tick over the final seconds of the pano phase.
    $("hudTimer").classList.toggle(
      "low", left > 0 && left <= 10_500 && room.phase === "roundActive");
    if (room.phase === "roundActive") {
      const t = countdownTick(lastTickSecond, left);
      if (t) {
        lastTickSecond = t.second;
        playSound(t.urgent ? "tickUrgent" : "tick");
      }
    }
    if (left <= 0 && room.phase === "roundActive") {
      toast("Time's up!");
      openGuessMap();
    }
  };
  tick();
  timerInterval = setInterval(tick, 250);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

/* ================================================================
 * Guess: Leaflet world map
 * ================================================================ */

// Live pin preview: while the host aims, the TV mirrors the pin in real time
// so the room can heckle. Same throttle discipline as the pose writer (≤4/s).
// This is round/liveGuess — separate from round/guess, which is only ever
// written on confirm, so a half-dragged pin can never leak into scoring.
let liveGuessTimer = null;
let liveGuessDirty = false;
function scheduleLiveGuessWrite() {
  liveGuessDirty = true;
  if (liveGuessTimer) return;
  liveGuessTimer = setTimeout(() => {
    liveGuessTimer = null;
    if (!liveGuessDirty || !guessMarker || !room || !room.round ||
        room.phase !== "guessing") return;
    liveGuessDirty = false;
    const g = guessMarker.getLatLng();
    const liveGuess = { lat: g.lat, lng: L.Util.wrapNum(g.lng, [-180, 180], true) };
    room.round.liveGuess = liveGuess;
    push({ "round/liveGuess": liveGuess });
  }, 250);
}

function cancelLiveGuessWrite() {
  if (liveGuessTimer) { clearTimeout(liveGuessTimer); liveGuessTimer = null; }
  liveGuessDirty = false;
}

// The TV mirrors the framing too: round/liveView carries the guess map's
// center + zoom (same ≤4/s throttle) so the audience sees exactly what the
// operator is looking at while they aim.
let liveViewTimer = null;
let liveViewDirty = false;
function scheduleLiveViewWrite() {
  liveViewDirty = true;
  if (liveViewTimer) return;
  liveViewTimer = setTimeout(() => {
    liveViewTimer = null;
    if (!liveViewDirty || !guessMap || !room || !room.round ||
        room.phase !== "guessing") return;
    liveViewDirty = false;
    const c = guessMap.getCenter();
    const liveView = {
      lat: c.lat,
      lng: L.Util.wrapNum(c.lng, [-180, 180], true),
      zoom: guessMap.getZoom(),
    };
    room.round.liveView = liveView;
    push({ "round/liveView": liveView });
  }, 250);
}

function cancelLiveViewWrite() {
  if (liveViewTimer) { clearTimeout(liveViewTimer); liveViewTimer = null; }
  liveViewDirty = false;
}

function ensureGuessMap() {
  if (guessMap) return;
  guessMap = L.map("guessMap", { worldCopyJump: true, zoomControl: false })
    .setView([25, 10], 2);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(guessMap);
  // moveend fires after pans, zooms, and setView alike — one event covers
  // every way the framing can change. zoomend is belt-and-braces for
  // pinch-zooms that settle without a pan.
  guessMap.on("moveend zoomend", scheduleLiveViewWrite);
  guessMap.on("click", (e) => {
    if (guessMarker) {
      guessMarker.setLatLng(e.latlng);
    } else {
      guessMarker = L.marker(e.latlng, { draggable: true }).addTo(guessMap);
      // "move" fires both while dragging and on setLatLng, so this one
      // listener keeps the live preview in sync for taps and drags alike.
      guessMarker.on("move", scheduleLiveGuessWrite);
      guessMarker.on("move", updateLockNowHint);
    }
    scheduleLiveGuessWrite();
    $("btnConfirmGuess").disabled = false;
    updateLockNowHint();
  });
}

// M3: the live "if you locked in now" pill. The host phone already holds
// the truth (currentTruth), so pricing the aimed pin is free and local.
// The round timer stops when the map opens, so the pill runs its own
// half-second ticker while the guessing phase lasts (the speed bonus keeps
// decaying on the confirm clock).
let lockNowTimer = null;
function updateLockNowHint() {
  const el = $("lockNowHint");
  if (!room || room.phase !== "guessing" || !room.round ||
      !guessMarker || !currentTruth) {
    el.textContent = "";
    return;
  }
  const g = guessMarker.getLatLng();
  const km = haversineKm(currentTruth.lat, currentTruth.lng,
    g.lat, L.Util.wrapNum(g.lng, [-180, 180], true));
  const elapsed = Math.max(0, Date.now() -
    (room.round.turnStartedAt || room.round.startedAt || Date.now()));
  const est = lockNowEstimate(km, elapsed, room.settings.roundSeconds);
  el.textContent = lockNowLabel(est, superSureArmed);
  el.classList.toggle("armed", superSureArmed);
}

function startLockNowTicker() {
  stopLockNowTicker();
  lockNowTimer = setInterval(updateLockNowHint, 500);
  updateLockNowHint();
}

function stopLockNowTicker() {
  if (lockNowTimer) { clearInterval(lockNowTimer); lockNowTimer = null; }
  const el = $("lockNowHint");
  if (el) el.textContent = "";
}

// The static "drop your pin" hint doubles as the whose-turn banner: solo
// rounds name the active team; showdown turns count down the pass-around.
function updateGuessHint() {
  const el = document.querySelector("#h-guess .guess-hint");
  if (!room || teamIds(room.teams).length <= 1) {
    el.textContent = "Tap the map to drop your pin";
    return;
  }
  const name = room.teams[room.activeTeam].name;
  if (room.round && room.round.showdown) {
    const order = room.round.order || [];
    const idx = order.indexOf(room.activeTeam);
    el.textContent = `${name} — drop your pin (${idx + 1}/${order.length})`;
  } else {
    el.textContent = `${name} — tap the map to drop your pin`;
  }
}

// Showdown pins already locked in, drawn in team colors so the team holding
// the phone sees the state of play without squinting at the TV.
let placedPinsLayer = null;
function renderPlacedPins() {
  if (!placedPinsLayer) placedPinsLayer = L.layerGroup().addTo(guessMap);
  placedPinsLayer.clearLayers();
  const results = (room.round && room.round.results) || {};
  for (const id of Object.keys(results)) {
    L.circleMarker([results[id].guess.lat, results[id].guess.lng], {
      radius: 9,
      color: "#fff",
      weight: 2,
      fillColor: teamHex(room.teams, id),
      fillOpacity: 1,
    })
      .addTo(placedPinsLayer)
      .bindTooltip(escapeHtml(room.teams[id].name), { direction: "top" });
  }
}

function openGuessMap() {
  if (!setPhase("guessing")) return;
  stopTimer();
  cancelLiveGuessWrite();
  cancelLiveViewWrite();
  if (room.round) {
    room.round.liveGuess = null;
    room.round.liveView = null;
  }
  push({ phase: "guessing", "round/liveGuess": null, "round/liveView": null });
  showScreen("h-guess");
  ensureGuessMap();
  if (guessMarker) { guessMarker.remove(); guessMarker = null; }
  $("btnConfirmGuess").disabled = true;
  guessMap.setView([25, 10], 2);
  renderPlacedPins();
  updateGuessHint();
  superSureArmed = false;
  renderSuperSureToggle();
  // First guess map ever on this device: the scoring one-liner and the
  // SUPER SURE stakes, at the moment they matter (M5 + M3).
  oneShotHint("guessmap", {
    title: "Drop your pin",
    lines: guessMapHintLines(
      "couch", superSureAvailable(room.teams, room.activeTeam)),
  });
  startLockNowTicker();
  // Leaflet needs a size pass after the container becomes visible.
  setTimeout(() => guessMap.invalidateSize(), 50);
}

/* ---------------- SUPER SURE: the active team's once-per-game bet ------ */

// Couch version of the h2h toggle: it belongs to whichever team holds the
// phone (the active team), and the TV never mirrors it — the bet stays
// hidden from the couch until the reveal.
function toggleSuperSure() {
  if (!room || !superSureAvailable(room.teams, room.activeTeam)) return;
  superSureArmed = !superSureArmed;
  renderSuperSureToggle();
  updateLockNowHint(); // the pill flips to the bet's doubled stakes
  toast(superSureArmed
    ? "SUPER SURE armed: closest pin wins ×2 — anyone closer and you get 0"
    : "SUPER SURE disarmed — bet saved for later");
}

function renderSuperSureToggle() {
  const btn = $("btnSuperSure");
  const available = room && superSureAvailable(room.teams, room.activeTeam);
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

function confirmGuess() {
  if (!guessMarker || !currentTruth) return;
  const g = guessMarker.getLatLng();
  const guess = { lat: g.lat, lng: L.Util.wrapNum(g.lng, [-180, 180], true) };
  const distanceKm = haversineKm(currentTruth.lat, currentTruth.lng, guess.lat, guess.lng);
  const distancePoints = scoreForDistance(distanceKm);
  // Speed clock: round start (or this team's showdown turn start) to this
  // confirm tap. turnStartedAt may be absent on rounds started pre-update.
  const submittedAt = Date.now();
  const elapsedMs = Math.max(
    0, submittedAt - (room.round.turnStartedAt || room.round.startedAt));
  const speedBonus =
    timeBonus(distancePoints, elapsedMs, bonusWindowMs(room.settings.roundSeconds));
  const points = distancePoints + speedBonus;
  // The active team's armed bet commits with this pin. Couch has no
  // forfeit path (a pin is always confirmed), so bets never burn here.
  const betting = superSureArmed &&
    superSureAvailable(room.teams, room.activeTeam);
  superSureArmed = false;
  playSound("stamp"); // S4: the lock-in beat on the operator phone
  buzz(35);

  // One event per confirmed pin, both solo and showdown turns. Only
  // aggregates leave the device — never the pin itself.
  track("guess_submitted", {
    room: roomCode,
    mode: "couch",
    team_id: room.activeTeam,
    distance_km: distanceKm,
    time_bonus: speedBonus,
    total_score: points,
    time_seconds: elapsedMs / 1000,
    super_sure: betting,
  });

  if (room.round.showdown) {
    confirmShowdownGuess({
      guess, distanceKm, points, distancePoints,
      timeBonus: speedBonus, elapsedMs, submittedAt,
      superSure: betting ? true : null,
    });
    return;
  }

  if (!setPhase("reveal")) return;
  cancelLiveGuessWrite(); // no trailing preview write after the phase flips
  cancelLiveViewWrite();
  // `name` rides along so the screen (a pure subscriber) can show the place
  // name at reveal without loading the pool itself. Older pool entries may
  // lack it; RTDB rejects `undefined`, hence the null fallback.
  const truth = {
    lat: currentTruth.lat,
    lng: currentTruth.lng,
    name: currentTruth.name || null,
  };

  room.round.truth = truth;
  room.round.guess = guess;
  room.round.liveGuess = null; // preview served its purpose
  room.round.liveView = null;
  const score = {
    points, distancePoints, timeBonus: speedBonus,
    elapsedMs, submittedAt, distanceKm,
    superSure: betting ? true : null,
    superSureOutcome: null,
  };
  if (betting) {
    // Solo rounds have exactly one pin, so the shared rule resolves it as
    // closest-by-definition — the couch risk lives in the showdown, where
    // every team pins the same spot (see resolveSuperSure).
    score.superSureOutcome = resolveSuperSure({
      [room.activeTeam]: { guess, distanceKm, points, superSure: true },
    })[room.activeTeam];
    room.teams[room.activeTeam].superSureUsed = room.round.number;
  }
  room.round.score = score;
  room.teams[room.activeTeam].total += adjustedPoints(score);

  // S6: the reveal is visible the moment this patch lands — stamp the soft
  // auto-advance deadline with it so every surface counts the same clock.
  room.round.autoAdvanceAt = Date.now() + AUTO_ADVANCE_MS;
  const patch = {
    phase: "reveal",
    "round/liveGuess": null,
    "round/liveView": null,
    "round/truth": truth,
    "round/guess": guess,
    "round/score": room.round.score,
    "round/autoAdvanceAt": room.round.autoAdvanceAt,
    [`teams/${room.activeTeam}/total`]: room.teams[room.activeTeam].total,
  };
  if (betting) {
    patch[`teams/${room.activeTeam}/superSureUsed`] = room.round.number;
  }
  push(patch);
  enterReveal();
}

// One showdown turn locked in. Middle teams: bank the result, pass the
// phone, stay in the guessing phase. Last team: flip to reveal with the
// truth so every pin lands on the TV at once.
function confirmShowdownGuess(result) {
  const team = room.activeTeam;
  const order = room.round.order || [];

  room.round.results = room.round.results || {};
  room.round.results[team] = result;
  // Raw points bank now; a SUPER SURE bet settles when the last pin lands
  // and "closest" is knowable — same contract as the h2h reveal flip.
  room.teams[team].total += result.points;
  if (result.superSure) {
    room.teams[team].superSureUsed = room.round.number;
  }
  room.round.liveGuess = null;
  cancelLiveGuessWrite();

  const next = order[order.indexOf(team) + 1];
  if (next) {
    room.activeTeam = next;
    // The next team's speed clock starts at the phone handoff, not at
    // round start — otherwise going later in the order would cost points.
    room.round.turnStartedAt = Date.now();
    const patch = {
      activeTeam: next,
      "round/liveGuess": null,
      "round/turnStartedAt": room.round.turnStartedAt,
      [`round/results/${team}`]: result,
      [`teams/${team}/total`]: room.teams[team].total,
    };
    if (result.superSure) {
      patch[`teams/${team}/superSureUsed`] = room.round.number;
    }
    push(patch);
    guessMarker.remove();
    guessMarker = null;
    $("btnConfirmGuess").disabled = true;
    guessMap.setView([25, 10], 2);
    renderPlacedPins();
    updateGuessHint();
    superSureArmed = false; // the next team arms (or not) for itself
    renderSuperSureToggle();
    // S4: a mid-showdown turn has no reveal to punctuate it — the stamp
    // overlay marks the handoff instead.
    stampFlash("LOCKED IN");
    toast(`Pass the phone — ${room.teams[next].name} is up!`);
    return;
  }

  if (!setPhase("reveal")) return;
  cancelLiveViewWrite();
  const truth = {
    lat: currentTruth.lat,
    lng: currentTruth.lng,
    name: currentTruth.name || null,
  };
  room.round.truth = truth;
  room.round.liveView = null;
  // Every pin is down: settle the bets and mirror the settlement into the
  // host's local authority state (outcome markers + corrected totals).
  const settlement = superSureSettlement(room.teams, room.round.results);
  for (const [id, outcome] of Object.entries(settlement.outcomes)) {
    room.round.results[id].superSureOutcome = outcome;
    room.teams[id].total = settlement.patch[`teams/${id}/total`];
  }
  // S6 deadline rides the showdown's reveal flip too (see the solo patch).
  room.round.autoAdvanceAt = Date.now() + AUTO_ADVANCE_MS;
  const patch = {
    phase: "reveal",
    "round/liveGuess": null,
    "round/liveView": null,
    "round/truth": truth,
    "round/autoAdvanceAt": room.round.autoAdvanceAt,
    [`round/results/${team}`]: result,
    [`teams/${team}/total`]: room.teams[team].total,
  };
  if (result.superSure) {
    patch[`teams/${team}/superSureUsed`] = room.round.number;
  }
  Object.assign(patch, settlement.patch);
  // The last team's outcome already rides inside its full result write
  // (mirrored above); the descendant path would make the multi-path
  // update invalid (RTDB rejects ancestor+descendant in one patch).
  delete patch[`round/results/${team}/superSureOutcome`];
  push(patch);
  enterReveal();
}

/* ================================================================
 * Reveal & game over
 * ================================================================ */

/* S6 soft auto-advance. The host phone owns manual advance, so it owns the
 * countdown decision too: every 250 ms render the shared deadline
 * (round.autoAdvanceAt, stamped by the reveal patch) and, when it lands,
 * advance exactly as a Next Round tap would. Hold nulls the deadline for
 * everyone. A lapsed deadline (resume into an old reveal) renders nothing
 * and never fires — the host taps like before S6. */
let advanceTicker = null;

function stopAdvanceTicker() {
  if (advanceTicker) { clearInterval(advanceTicker); advanceTicker = null; }
}

function renderAdvanceState() {
  if (!room || room.phase !== "reveal" || !room.round) {
    stopAdvanceTicker();
    return;
  }
  const now = Date.now();
  const status = autoAdvanceStatus(room.round.autoAdvanceAt, now);
  const target = advanceTarget(room.round.number, room.settings.roundCount);
  $("hostAdvanceNote").textContent = countdownText(status, target) || "";
  $("btnHoldAdvance").classList.toggle("hidden", status.state !== "counting");
  if (shouldAutoAdvance({
    phase: room.phase, autoAdvanceAt: room.round.autoAdvanceAt,
    isHost: true, now,
  })) {
    stopAdvanceTicker();
    nextOrFinish("auto");
  }
}

function startAdvanceTicker() {
  stopAdvanceTicker();
  advanceTicker = setInterval(renderAdvanceState, 250);
  renderAdvanceState();
}

function holdAdvance() {
  if (!room || room.phase !== "reveal" || !room.round) return;
  const status = autoAdvanceStatus(room.round.autoAdvanceAt, Date.now());
  if (status.state !== "counting") return;
  room.round.autoAdvanceAt = null;
  push(holdAdvancePatch());
  track("auto_advance_hold", {
    room: roomCode, mode: "couch", round_number: room.round.number,
    seconds_left: advanceSecondsLeft(status.msLeft),
  });
  renderAdvanceState();
  toast("Holding — advance whenever you're ready");
}

let revealTracked = null; // "<room>:<round>" — resume re-enters the reveal
function enterReveal() {
  stopLockNowTicker();
  showScreen("h-reveal");
  // First reveal ever: label the breakdown once (M5); the injected speed
  // line below carries the numbers themselves every round.
  oneShotHint("reveal", HINT_CARDS.reveal);
  const { number, showdown } = room.round;
  // S1: fold this reveal into the game's closest-guess moment — the share
  // card's brag line. Solo rounds carry one pin on round.guess/score;
  // showdowns carry everyone's on round.results. Idempotent on re-entry.
  gameBest = foldBestMoment(
    gameBest,
    showdown
      ? room.round.results
      : { solo: {
          guess: room.round.guess,
          distanceKm: room.round.score && room.round.score.distanceKm,
        } },
    room.round.truth && room.round.truth.name);
  if (revealTracked !== `${roomCode}:${number}`) {
    revealTracked = `${roomCode}:${number}`;
    playSound("sting"); // S4: the reveal beat, once per round
    track("reveal_shown", { room: roomCode, mode: "couch", round_number: number });
    // One super_sure_resolved per bet (host phone at reveal, same
    // once-per-round cardinality). Solo rounds carry the bet on the score;
    // showdowns on the per-team results. Couch has no burned bets.
    const bets = showdown
      ? Object.values(room.round.results || {}).filter((r) => r.superSure)
      : (room.round.score && room.round.score.superSure
          ? [room.round.score] : []);
    for (const r of bets) {
      track("super_sure_resolved", {
        mode: "couch",
        round_number: number,
        rounds: room.settings.roundCount,
        outcome: r.superSureOutcome,
        round_total: r.points || 0,
      });
    }
  }
  $("revealHeading").textContent = showdown
    ? "Final Showdown"
    : `Round ${number} of ${room.settings.roundCount}`;
  $("revealPlace").textContent =
    (room.round.truth && room.round.truth.name) || "—";

  // Solo rounds keep the Distance/Points cards; the showdown swaps them for
  // a closest-first list of every team's result (injected — HTML untouched).
  const distCard = $("revealDistance").closest(".stat-card");
  const ptsCard = $("revealPoints").closest(".stat-card");
  let list = $("hostShowdownResults");
  distCard.classList.toggle("hidden", !!showdown);
  ptsCard.classList.toggle("hidden", !!showdown);
  if (showdown) {
    if (!list) {
      list = document.createElement("ul");
      list.id = "hostShowdownResults";
      list.className = "totals-list showdown-results";
      ptsCard.after(list);
    }
    list.classList.remove("hidden");
    list.innerHTML = "";
    showdownResults(room.round).forEach((r, i) => {
      const li = document.createElement("li");
      if (i === 0) li.classList.add("closest");
      const name = document.createElement("span");
      name.textContent = (i === 0 ? "👑 " : "") + room.teams[r.id].name;
      const val = document.createElement("span");
      val.textContent = resultRowText(r);
      li.append(name, val);
      list.appendChild(li);
    });
  } else {
    if (list) list.classList.add("hidden");
    const score = room.round.score;
    $("revealDistance").textContent = formatDistance(score.distanceKm);
    $("revealPoints").textContent = adjustedPoints(score).toLocaleString();
    // Speed line under the points card (injected — HTML untouched).
    let speedEl = $("hostRevealSpeed");
    if (!speedEl) {
      speedEl = document.createElement("div");
      speedEl.id = "hostRevealSpeed";
      speedEl.className = "time-note";
      ptsCard.appendChild(speedEl);
    }
    if (typeof score.elapsedMs === "number") {
      speedEl.textContent =
        `${score.distancePoints.toLocaleString()} distance` +
        ` + ⚡${score.timeBonus.toLocaleString()} speed` +
        ` · answered in ${formatSeconds(score.elapsedMs)}`;
      speedEl.classList.toggle("zero", !score.timeBonus);
    } else {
      speedEl.textContent = "";
    }
    // SUPER SURE verdict line (injected — HTML untouched).
    let ssEl = $("hostRevealSuperSure");
    if (!ssEl) {
      ssEl = document.createElement("div");
      ssEl.id = "hostRevealSuperSure";
      ssEl.className = "ss-note";
      ptsCard.appendChild(ssEl);
    }
    if (score.superSure) {
      ssEl.textContent = `🔥 ${superSureLabel(score)}`;
      ssEl.classList.toggle("lost", score.superSureOutcome !== "won");
    } else {
      ssEl.textContent = "";
    }
  }
  renderTotals($("revealTotals"));
  $("btnNextRound").textContent =
    number >= room.settings.roundCount ? "Finish" : "Next Round";
  startAdvanceTicker();
}

function renderTotals(listEl) {
  listEl.innerHTML = "";
  // No "active team" highlight after a showdown — everyone just played.
  const showdown = room.round && room.round.showdown;
  for (const t of standings(room.teams)) {
    const li = document.createElement("li");
    if (t.id === room.activeTeam && !showdown) li.classList.add("active");
    const name = document.createElement("span");
    name.textContent = t.name;
    const pts = document.createElement("span");
    pts.textContent = t.total.toLocaleString();
    li.append(name, pts);
    listEl.appendChild(li);
  }
}

function nextOrFinish(advance) {
  stopAdvanceTicker();
  if (room.round.number >= room.settings.roundCount) {
    finishGame(advance === "auto" ? "auto" : "manual");
  } else {
    startRound(advance); // startRound sorts "auto" from a click event
  }
}

function finishGame(advance) {
  if (!setPhase("gameOver")) return;
  stopTimer();
  stopAdvanceTicker();
  push({ phase: "gameOver" });
  const winner = standings(room.teams)[0];
  track("game_completed", {
    room: roomCode,
    mode: "couch",
    rounds: room.round ? room.round.number : 0,
    winner_team: winner.id,
    winning_score: winner.total,
    team_count: teamIds(room.teams).length,
    // Absent on the pool-exhaustion end, which skips the final reveal.
    ...(advance === "auto" || advance === "manual" ? { advance } : {}),
  });
  destroyViewer();
  showScreen("h-gameover");
  playSound("fanfare"); // S4
  renderTotals($("finalTotals"));
  $("btnSaveLeaderboard").disabled = false;
  $("btnSaveLeaderboard").textContent = "Save to leaderboard";
}

// S1: the post-game result card — the game's closest moment plus the
// winning score, never a team name (user-entered text stays out of every
// outbound channel). The link is UTM-tagged so rooms created by recipients
// attribute back to shared cards in PostHog.
function shareGameResult() {
  if (!room) return;
  const winner = standings(room.teams)[0];
  shareResult(
    partyShareText({
      best: gameBest,
      points: winner ? winner.total : 0,
      url: withUtm(new URL(".", location.href).href, "couch"),
    }),
    "couch",
    toast
  );
}

function saveToLeaderboard() {
  const board = lsGet(LS_LEADERBOARD, []);
  const date = new Date().toISOString().slice(0, 10);
  for (const t of standings(room.teams)) {
    board.push({
      teamName: t.name,
      totalScore: t.total,
      rounds: room.settings.roundCount,
      date,
    });
  }
  lsSet(LS_LEADERBOARD, board);
  $("btnSaveLeaderboard").disabled = true;
  $("btnSaveLeaderboard").textContent = "Saved ✓";
  toast("Saved to leaderboard");
}

function newGameFromOver() {
  // gameOver -> lobby means: fresh room, back to setup (spec §7). Remember
  // the finished room so the next game can point the screen at itself.
  track("next_game", { mode: "couch" });
  prevRoomCode = roomCode;
  if (unsubHeartbeat) { unsubHeartbeat(); unsubHeartbeat = null; }
  localStorage.removeItem(LS_ACTIVE);
  room = null;
  roomCode = null;
  currentTruth = null;
  gameBest = null;
  enterSetup();
}

/* ================================================================
 * Setup entry + resume (spec §12)
 * ================================================================ */

function enterSetup() {
  showScreen("h-setup");
  $("resumeBanner").classList.add("hidden");
  renderLeaderboard();
}

async function checkResume() {
  const active = lsGet(LS_ACTIVE, null);
  if (!active || !active.code) return;
  if (Date.now() - active.createdAt > 86_400_000) {
    localStorage.removeItem(LS_ACTIVE);
    return;
  }
  let state = null;
  try { state = await readRoom(active.code); } catch { return; }
  if (!state || Date.now() - state.createdAt > 86_400_000) {
    localStorage.removeItem(LS_ACTIVE);
    return;
  }
  $("resumeCode").textContent = active.code;
  $("resumeBanner").classList.remove("hidden");
  $("btnResume").onclick = async () => {
    // Re-read at click time: the snapshot from page load may be stale.
    const fresh = await readRoom(active.code).catch(() => null);
    if (fresh) {
      resumeGame(active.code, fresh);
    } else {
      $("resumeBanner").classList.add("hidden");
      localStorage.removeItem(LS_ACTIVE);
      toast("That room is gone");
    }
  };
}

async function resumeGame(code, state) {
  $("resumeBanner").classList.add("hidden");
  roomCode = code;
  room = state;
  room.teams = room.teams || defaultTeams();
  const pool = await loadPool();
  sampler = new PoolSampler(pool, roomCode, room.poolCursor || 0);
  // The cursor was advanced past the active round's entry at round start, so
  // the entry backing the in-flight round is order[cursor - 1]. (Looking up
  // round.imageId doesn't work: after movement it's a neighbor image.)
  currentTruth = room.round && sampler.cursor > 0
    ? sampler.order[sampler.cursor - 1]
    : null;
  persistActive();

  switch (room.phase) {
    case "lobby":
      enterLobby();
      break;
    case "roundActive": {
      showScreen("h-round");
      makeViewer();
      try { await viewer.moveTo(room.round.imageId); }
      catch (e) { console.warn("resume: image failed to load", e); }
      $("hudRound").textContent =
        `Round ${room.round.number}/${room.settings.roundCount}`;
      $("hudTeam").textContent = roundTeamLabel();
      startTimer();
      break;
    }
    case "guessing":
      showScreen("h-guess");
      ensureGuessMap();
      if (guessMarker) { guessMarker.remove(); guessMarker = null; }
      $("btnConfirmGuess").disabled = true;
      renderPlacedPins(); // mid-showdown resume: restore locked-in pins
      updateGuessHint();
      renderSuperSureToggle(); // armed state is local; a refresh disarms
      startLockNowTicker();
      setTimeout(() => guessMap.invalidateSize(), 50);
      break;
    case "reveal":
      enterReveal();
      break;
    case "gameOver":
      showScreen("h-gameover");
      renderTotals($("finalTotals"));
      break;
    default:
      enterSetup();
  }
  if (room.phase !== "lobby") {
    if (unsubHeartbeat) unsubHeartbeat();
    unsubHeartbeat = subscribeHeartbeat(roomCode, (ts) => {
      if (ts) heartbeatSeen = true;
    });
  }
}

/* ================================================================
 * Boot
 * ================================================================ */

wireSeg("segRounds");
wireSeg("segSeconds");
wireSeg("segMove");
wireSeg("segTeams", (v) => renderTeamNameInputs(parseInt(v, 10)));

$("btnNewGame").addEventListener("click", newGame);
$("btnStartRound").addEventListener("click", startRound);
$("btnAbandon").addEventListener("click", abandonGame);
$("btnTvLink").addEventListener("click", () => {
  if (!roomCode) return;
  shareTvLink(screenLink(location.href, roomCode, "link"), roomCode, "couch", toast);
});
$("btnMakeGuess").addEventListener("click", openGuessMap);
$("btnSuperSure").addEventListener("click", toggleSuperSure);
$("btnConfirmGuess").addEventListener("click", confirmGuess);
$("btnNextRound").addEventListener("click", nextOrFinish);
$("btnHoldAdvance").addEventListener("click", holdAdvance);
$("btnShareResult").addEventListener("click", shareGameResult);
$("btnSaveLeaderboard").addEventListener("click", saveToLeaderboard);
$("btnNewGameOver").addEventListener("click", newGameFromOver);

onConnectionChange((isConnected) => {
  connected = isConnected;
  $("connPill").classList.toggle("hidden", isConnected);
  if (room && room.phase === "lobby") updateLobbyReadiness();
});

initSound("host"); // S4: muted by default on phones; 🔇 toggle persists
enterSetup();
janitor();
checkResume();
