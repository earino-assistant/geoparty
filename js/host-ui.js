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
  formatDistance,
  formatCountdown,
  teamForRound,
  teamIds,
  defaultTeams,
  initialRoomState,
  standings,
} from "./game.js";
import { loadPool, PoolSampler } from "./pool.js";

/* ================================================================
 * Tiny QR encoder (inlined, MIT-style — the single allowed extra
 * dependency per spec §6). Byte mode, EC level L, versions 1–5
 * (single EC block each, up to 106 chars), fixed mask 0.
 * ================================================================ */

const QR_VERSIONS = [
  // [version, totalCodewords, dataCodewords] at EC level L
  [1, 26, 19],
  [2, 44, 34],
  [3, 70, 55],
  [4, 100, 80],
  [5, 134, 108],
];
const QR_ALIGN_CENTER = { 2: 18, 3: 22, 4: 26, 5: 30 };

const GF_EXP = new Array(512);
const GF_LOG = new Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();
const gfMul = (a, b) => (a && b ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0);

function rsGenerator(degree) {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], GF_EXP[i]);
    }
    g = next;
  }
  return g;
}

function rsEncode(data, degree) {
  const gen = rsGenerator(degree);
  const rem = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    if (factor) {
      for (let j = 0; j < gen.length - 1; j++) {
        rem[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return rem;
}

// BCH(15,5) format bits for (EC level, mask). EC level L = 1.
function qrFormatBits(ecLevel, mask) {
  const data = (ecLevel << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

// Returns a size×size matrix of 0/1, or null if text is too long.
function qrEncode(text) {
  const bytes = new TextEncoder().encode(text);
  const spec = QR_VERSIONS.find(([, , dc]) => bytes.length <= dc - 2);
  if (!spec) return null;
  const [version, , dataCw] = spec;
  const ecCw = spec[1] - dataCw;
  const size = 17 + 4 * version;

  // --- bit stream: mode 0100, 8-bit length, data, terminator, padding ---
  const bits = [];
  const pushBits = (val, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  pushBits(0b0100, 4);
  pushBits(bytes.length, 8);
  for (const b of bytes) pushBits(b, 8);
  pushBits(0, Math.min(4, dataCw * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }
  for (let pad = 0xec; data.length < dataCw; pad ^= 0xec ^ 0x11) data.push(pad);
  const codewords = data.concat(rsEncode(data, ecCw));

  // --- matrix: null = free for data; true/false = function modules ---
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const stampFinder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r, cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        m[rr][cc] =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      }
    }
  };
  stampFinder(0, 0);
  stampFinder(size - 7, 0);
  stampFinder(0, size - 7);

  const ac = QR_ALIGN_CENTER[version];
  if (ac) {
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        m[ac + r][ac + c] =
          r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
      }
    }
  }

  for (let i = 8; i < size - 8; i++) {
    if (m[i][6] === null) m[i][6] = i % 2 === 0;
    if (m[6][i] === null) m[6][i] = i % 2 === 0;
  }

  // Format info (EC L, mask 0), placed twice, plus the fixed dark module.
  const fmt = qrFormatBits(1, 0);
  for (let i = 0; i < 15; i++) {
    const bit = ((fmt >> i) & 1) === 1;
    if (i < 6) m[i][8] = bit;
    else if (i < 8) m[i + 1][8] = bit;
    else m[size - 15 + i][8] = bit;
    if (i < 8) m[8][size - 1 - i] = bit;
    else if (i < 9) m[8][15 - i] = bit;
    else m[8][14 - i] = bit;
  }
  m[size - 8][8] = true;

  // Zigzag data placement with mask 0: (row+col) % 2 === 0.
  let byteIdx = 0, bitIdx = 7, row = size - 1, inc = -1;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        if (m[row][col - c] !== null) continue;
        let dark =
          byteIdx < codewords.length &&
          ((codewords[byteIdx] >>> bitIdx) & 1) === 1;
        if ((row + (col - c)) % 2 === 0) dark = !dark;
        m[row][col - c] = dark;
        if (--bitIdx === -1) { byteIdx++; bitIdx = 7; }
      }
      row += inc;
      if (row < 0 || row >= size) { row -= inc; inc = -inc; break; }
    }
  }
  return m.map((r) => r.map((v) => (v ? 1 : 0)));
}

function drawQr(canvas, text) {
  const matrix = qrEncode(text);
  if (!matrix) { canvas.style.display = "none"; return; }
  const quiet = 4, scale = 8;
  const n = matrix.length + quiet * 2;
  canvas.width = canvas.height = n * scale;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  matrix.forEach((rowArr, r) =>
    rowArr.forEach((v, c) => {
      if (v) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    })
  );
}

/* ================================================================
 * DOM helpers
 * ================================================================ */

const $ = (id) => document.getElementById(id);
const SCREENS = ["h-setup", "h-lobby", "h-round", "h-guess", "h-reveal", "h-gameover"];

function showScreen(id) {
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
let connected = true;

let viewer = null;        // MapillaryJS viewer
let guessMap = null;      // Leaflet map
let guessMarker = null;
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
    room = initialRoomState(collectSettings(), collectTeams());
    sampler = new PoolSampler(pool, roomCode, 0);
    currentTruth = null;
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
  const screenUrl = new URL(`screen.html?room=${roomCode}`, location.href).href;
  $("screenUrl").textContent = screenUrl;
  drawQr($("qrCanvas"), screenUrl);
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
    note.textContent = "Screen connected — ready when you are.";
    note.classList.add("ok");
    $("btnStartRound").disabled = false;
  } else if (!connected) {
    // Degraded single-screen mode (spec §12): the party survives offline.
    note.textContent = "Offline — you can play in single-screen mode.";
    note.classList.remove("ok");
    $("btnStartRound").disabled = false;
  } else {
    note.textContent = "Waiting for a screen to join…";
    note.classList.remove("ok");
    $("btnStartRound").disabled = true;
  }
}

async function abandonGame() {
  stopTimer();
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

async function startRound() {
  if (!setPhase("roundActive")) return;
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
  room.round = {
    number,
    imageId: entry.image_id,
    startedAt: now,
    endsAt: secs > 0 ? now + secs * 1000 : null,
    pose: { bearing: 0 },
    truth: null,
    liveGuess: null,
    guess: null,
    score: null,
  };
  room.activeTeam = teamForRound(room.teams, number);
  room.poolCursor = sampler.cursor;
  push({
    phase: "roundActive",
    round: room.round,
    activeTeam: room.activeTeam,
    poolCursor: room.poolCursor,
  });

  $("hudRound").textContent = `Round ${number}/${room.settings.roundCount}`;
  $("hudTeam").textContent =
    teamIds(room.teams).length > 1 ? room.teams[room.activeTeam].name : "";
  startTimer();
}

function startTimer() {
  stopTimer();
  const tick = () => {
    if (!room || !room.round) return;
    const endsAt = room.round.endsAt;
    if (!endsAt) {
      $("hudTimer").textContent = "∞";
      return;
    }
    const left = endsAt - Date.now();
    $("hudTimer").textContent = formatCountdown(left);
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

function ensureGuessMap() {
  if (guessMap) return;
  guessMap = L.map("guessMap", { worldCopyJump: true, zoomControl: false })
    .setView([25, 10], 2);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(guessMap);
  guessMap.on("click", (e) => {
    if (guessMarker) {
      guessMarker.setLatLng(e.latlng);
    } else {
      guessMarker = L.marker(e.latlng, { draggable: true }).addTo(guessMap);
      // "move" fires both while dragging and on setLatLng, so this one
      // listener keeps the live preview in sync for taps and drags alike.
      guessMarker.on("move", scheduleLiveGuessWrite);
    }
    scheduleLiveGuessWrite();
    $("btnConfirmGuess").disabled = false;
  });
}

function openGuessMap() {
  if (!setPhase("guessing")) return;
  stopTimer();
  cancelLiveGuessWrite();
  if (room.round) room.round.liveGuess = null;
  push({ phase: "guessing", "round/liveGuess": null });
  showScreen("h-guess");
  ensureGuessMap();
  if (guessMarker) { guessMarker.remove(); guessMarker = null; }
  $("btnConfirmGuess").disabled = true;
  guessMap.setView([25, 10], 2);
  // Leaflet needs a size pass after the container becomes visible.
  setTimeout(() => guessMap.invalidateSize(), 50);
}

function confirmGuess() {
  if (!guessMarker || !currentTruth) return;
  if (!setPhase("reveal")) return;
  cancelLiveGuessWrite(); // no trailing preview write after the phase flips
  const g = guessMarker.getLatLng();
  // `name` rides along so the screen (a pure subscriber) can show the place
  // name at reveal without loading the pool itself. Older pool entries may
  // lack it; RTDB rejects `undefined`, hence the null fallback.
  const truth = {
    lat: currentTruth.lat,
    lng: currentTruth.lng,
    name: currentTruth.name || null,
  };
  const guess = { lat: g.lat, lng: L.Util.wrapNum(g.lng, [-180, 180], true) };
  const distanceKm = haversineKm(truth.lat, truth.lng, guess.lat, guess.lng);
  const points = scoreForDistance(distanceKm);

  room.round.truth = truth;
  room.round.guess = guess;
  room.round.liveGuess = null; // preview served its purpose
  room.round.score = { points, distanceKm };
  room.teams[room.activeTeam].total += points;

  push({
    phase: "reveal",
    "round/liveGuess": null,
    "round/truth": truth,
    "round/guess": guess,
    "round/score": room.round.score,
    [`teams/${room.activeTeam}/total`]: room.teams[room.activeTeam].total,
  });
  enterReveal();
}

/* ================================================================
 * Reveal & game over
 * ================================================================ */

function enterReveal() {
  showScreen("h-reveal");
  const { number } = room.round;
  const { points, distanceKm } = room.round.score;
  $("revealHeading").textContent = `Round ${number} of ${room.settings.roundCount}`;
  $("revealPlace").textContent =
    (room.round.truth && room.round.truth.name) || "—";
  $("revealDistance").textContent = formatDistance(distanceKm);
  $("revealPoints").textContent = points.toLocaleString();
  renderTotals($("revealTotals"));
  $("btnNextRound").textContent =
    number >= room.settings.roundCount ? "Finish" : "Next Round";
}

function renderTotals(listEl) {
  listEl.innerHTML = "";
  for (const t of standings(room.teams)) {
    const li = document.createElement("li");
    if (t.id === room.activeTeam) li.classList.add("active");
    const name = document.createElement("span");
    name.textContent = t.name;
    const pts = document.createElement("span");
    pts.textContent = t.total.toLocaleString();
    li.append(name, pts);
    listEl.appendChild(li);
  }
}

function nextOrFinish() {
  if (room.round.number >= room.settings.roundCount) {
    finishGame();
  } else {
    startRound();
  }
}

function finishGame() {
  if (!setPhase("gameOver")) return;
  stopTimer();
  push({ phase: "gameOver" });
  destroyViewer();
  showScreen("h-gameover");
  renderTotals($("finalTotals"));
  $("btnSaveLeaderboard").disabled = false;
  $("btnSaveLeaderboard").textContent = "Save to leaderboard";
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
  prevRoomCode = roomCode;
  if (unsubHeartbeat) { unsubHeartbeat(); unsubHeartbeat = null; }
  localStorage.removeItem(LS_ACTIVE);
  room = null;
  roomCode = null;
  currentTruth = null;
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
      $("hudTeam").textContent =
        teamIds(room.teams).length > 1 ? room.teams[room.activeTeam].name : "";
      startTimer();
      break;
    }
    case "guessing":
      showScreen("h-guess");
      ensureGuessMap();
      if (guessMarker) { guessMarker.remove(); guessMarker = null; }
      $("btnConfirmGuess").disabled = true;
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
$("btnMakeGuess").addEventListener("click", openGuessMap);
$("btnConfirmGuess").addEventListener("click", confirmGuess);
$("btnNextRound").addEventListener("click", nextOrFinish);
$("btnSaveLeaderboard").addEventListener("click", saveToLeaderboard);
$("btnNewGameOver").addEventListener("click", newGameFromOver);

onConnectionChange((isConnected) => {
  connected = isConnected;
  $("connPill").classList.toggle("hidden", isConnected);
  if (room && room.phase === "lobby") updateLobbyReadiness();
});

enterSetup();
janitor();
checkResume();
