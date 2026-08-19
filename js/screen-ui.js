// screen-ui.js — TV spectator display. A pure subscriber: renders whatever
// state arrives from Firebase. The ONLY thing it ever writes is its own
// presence heartbeat (spec §1, acceptance criterion 10).

import { MAPILLARY_TOKEN } from "../config.js";
import {
  subscribeRoom,
  writeScreenHeartbeat,
  onConnectionChange,
} from "./firebase.js";
import {
  isValidRoomCode,
  formatDistance,
  formatCountdown,
  teamIds,
  standings,
} from "./game.js";

const $ = (id) => document.getElementById(id);
const SCREENS = ["s-entry", "s-lobby", "s-round", "s-guess", "s-reveal", "s-gameover"];
const TEAM_COLORS = ["var(--team-1)", "var(--team-2)", "var(--team-3)", "var(--team-4)"];

function showScreen(id) {
  for (const s of SCREENS) $(s).classList.toggle("hidden", s !== id);
}

let roomCode = null;
let unsubRoom = null;
let heartbeatInterval = null;
let latestState = null;

let viewer = null;
let currentImageId = null;
let countdownInterval = null;

let revealMap = null;
let revealShownForRound = null;
let confettiDone = false;

let liveMap = null;     // guessing-phase world map (kept across rounds)
let liveMarker = null;  // the host's in-progress pin, mirrored live

/* ================================================================
 * Room entry
 * ================================================================ */

// Rooms joined since the last manual entry — breaks nextRoom pointer cycles
// (A -> B -> A would otherwise re-subscribe forever).
let followedCodes = new Set();

function joinRoom(code) {
  roomCode = code;
  followedCodes.add(code);
  $("entryErr").textContent = "";
  let sawState = false;

  unsubRoom = subscribeRoom(code, (state) => {
    if (!state) {
      if (sawState) leaveRoom("The room was closed.");
      else showEntryError("Room not found — check the code.");
      return;
    }
    if (!sawState) {
      sawState = true;
      startHeartbeat();
      // Keep the URL on the current room so a TV refresh rejoins it.
      try { history.replaceState(null, "", `?room=${code}`); } catch { /* file:// */ }
    }
    latestState = state;
    // Follow the host: when the finished game grows a nextRoom pointer
    // (written by the host on New Game), switch over automatically.
    if (state.phase === "gameOver" &&
        typeof state.nextRoom === "string" &&
        isValidRoomCode(state.nextRoom) &&
        !followedCodes.has(state.nextRoom)) {
      followRoom(state.nextRoom);
      return;
    }
    render(state);
  });
}

// Drop the old room's subscription and join the host's next game. If the
// target room doesn't exist, joinRoom falls back to the entry screen with
// a "Room not found" message.
function followRoom(code) {
  if (unsubRoom) { unsubRoom(); unsubRoom = null; }
  stopHeartbeat();
  stopCountdown();
  latestState = null;
  revealShownForRound = null;
  confettiDone = false;
  $("roomInput").value = code;
  joinRoom(code);
}

function leaveRoom(message) {
  if (unsubRoom) { unsubRoom(); unsubRoom = null; }
  stopHeartbeat();
  stopCountdown();
  destroyViewer();
  roomCode = null;
  latestState = null;
  revealShownForRound = null;
  confettiDone = false;
  followedCodes = new Set();
  try { history.replaceState(null, "", location.pathname); } catch { /* file:// */ }
  showScreen("s-entry");
  if (message) $("entryErr").textContent = message;
  $("roomInput").value = "";
  $("roomInput").focus();
}

function showEntryError(msg) {
  if (unsubRoom) { unsubRoom(); unsubRoom = null; }
  roomCode = null;
  showScreen("s-entry");
  $("entryErr").textContent = msg;
}

function startHeartbeat() {
  stopHeartbeat();
  const beat = () => writeScreenHeartbeat(roomCode).catch(() => {});
  beat();
  heartbeatInterval = setInterval(beat, 10_000);
}

function stopHeartbeat() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
}

/* ================================================================
 * Render by phase
 * ================================================================ */

function render(state) {
  switch (state.phase) {
    case "lobby": renderLobby(state); break;
    case "roundActive": renderRound(state); break;
    case "guessing": renderGuessing(state); break; // live view of the host's pin
    case "reveal": renderReveal(state); break;
    case "gameOver": renderGameOver(state); break;
    default: break;
  }
  if (state.phase !== "reveal") revealShownForRound = null;
  if (state.phase !== "gameOver") confettiDone = false;
  if (state.phase !== "roundActive") stopCountdown();
  if (state.phase !== "guessing" && liveMarker) {
    // Drop the preview pin so the next round's guess view starts clean.
    liveMarker.remove();
    liveMarker = null;
  }
}

function renderLobby(state) {
  showScreen("s-lobby");
  const wrap = $("lobbyTeams");
  wrap.innerHTML = "";
  teamIds(state.teams).forEach((id, i) => {
    const chip = document.createElement("div");
    chip.className = "team-chip";
    chip.textContent = state.teams[id].name;
    chip.style.color = TEAM_COLORS[i % TEAM_COLORS.length];
    wrap.appendChild(chip);
  });
}

/* ---------------- Round: mirror the host's viewer ---------------- */

function ensureViewer() {
  if (viewer) return;
  viewer = new mapillary.Viewer({
    accessToken: MAPILLARY_TOKEN,
    container: "screenViewer",
    component: {
      // Display-only: no controls whatsoever (spec §6).
      cover: false,
      direction: false,
      sequence: false,
      keyboard: false,
      pointer: false,
      zoom: false,
      bearing: false,
    },
  });
}

function destroyViewer() {
  if (viewer) {
    try { viewer.remove(); } catch { /* already gone */ }
    viewer = null;
    currentImageId = null;
  }
}

function applyPose(pose) {
  if (!viewer || !pose) return;
  try {
    if (Array.isArray(pose.center)) viewer.setCenter(pose.center);
    if (typeof pose.zoom === "number") viewer.setZoom(pose.zoom);
  } catch { /* viewer between images; next pose write catches up */ }
}

function renderRound(state) {
  showScreen("s-round");
  ensureViewer();
  const round = state.round || {};

  if (round.imageId && round.imageId !== currentImageId) {
    const target = round.imageId;
    currentImageId = target;
    viewer.moveTo(target)
      .then(() => {
        // Apply the freshest pose we have once the image is in.
        if (latestState && latestState.round &&
            latestState.round.imageId === target) {
          applyPose(latestState.round.pose);
        }
      })
      .catch((e) => console.warn("screen: image load failed", e));
  } else {
    applyPose(round.pose);
  }

  $("tvRoundNo").textContent =
    `Round ${round.number || 1}` +
    (state.settings ? ` / ${state.settings.roundCount}` : "");
  const ids = teamIds(state.teams);
  const activeIdx = ids.indexOf(state.activeTeam);
  const teamEl = $("tvActiveTeam");
  if (ids.length > 1 && activeIdx >= 0) {
    teamEl.textContent = state.teams[state.activeTeam].name;
    teamEl.style.color = TEAM_COLORS[activeIdx % TEAM_COLORS.length];
  } else {
    teamEl.textContent = "";
  }
  startCountdown(round.endsAt);
}

// Countdown renders from endsAt minus our own clock (spec §4) — the timer is
// never ticked through Firebase.
function startCountdown(endsAt) {
  stopCountdown();
  const el = $("tvCountdown");
  if (!endsAt) { el.textContent = ""; return; }
  const tick = () => {
    const left = endsAt - Date.now();
    el.textContent = formatCountdown(left);
    el.classList.toggle("low", left < 15_000);
    if (left <= 0) stopCountdown();
  };
  tick();
  countdownInterval = setInterval(tick, 250);
}

function stopCountdown() {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
}

/* ---------------- Guessing: mirror the host's pin live ---------------- */

// The host streams the in-progress pin to round/liveGuess (throttled ≤4/s);
// we just reposition a marker. This is a preview of the aim, NOT the
// confirmed guess — that arrives as round/guess at reveal.

function ensureLiveMap() {
  if (liveMap) return false;
  liveMap = L.map("guessLiveMap", {
    zoomControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    touchZoom: false,
  }).setView([25, 10], 2);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(liveMap);
  return true;
}

function renderGuessing(state) {
  const wasHidden = $("s-guess").classList.contains("hidden");
  showScreen("s-guess");
  const created = ensureLiveMap();
  if (created || wasHidden) {
    // Leaflet needs a size pass whenever the container becomes visible.
    setTimeout(() => liveMap.invalidateSize({ pan: false }), 60);
  }

  const round = state.round || {};
  $("tvGuessRound").textContent =
    `Round ${round.number || 1}` +
    (state.settings ? ` / ${state.settings.roundCount}` : "");

  const lg = round.liveGuess;
  if (lg && typeof lg.lat === "number" && typeof lg.lng === "number") {
    $("tvGuessHint").classList.add("hidden");
    const pos = L.latLng(lg.lat, lg.lng);
    if (liveMarker) {
      liveMarker.setLatLng(pos);
    } else {
      liveMarker = L.circleMarker(pos, {
        radius: 14, color: "#fff", weight: 3,
        fillColor: "#ffcf3f", fillOpacity: 0.9,
      }).addTo(liveMap);
    }
  } else {
    $("tvGuessHint").classList.remove("hidden");
    if (liveMarker) { liveMarker.remove(); liveMarker = null; }
  }
}

/* ---------------- Reveal: the emotional peak ---------------- */

function renderReveal(state) {
  showScreen("s-reveal");
  const round = state.round || {};
  renderBoard(state);
  if (!round.truth || !round.guess || !round.score) return;
  if (revealShownForRound === round.number) return; // animate once per round
  revealShownForRound = round.number;

  // Place name pops in when the truth marker lands (see the animation below):
  // that's the "Yakutsk!!!" moment. Prepared hidden here.
  const placeEl = $("tvPlace");
  placeEl.textContent = round.truth.name || "";
  placeEl.classList.remove("show");

  if (revealMap) { revealMap.remove(); revealMap = null; }
  revealMap = L.map("revealMap", {
    zoomControl: false,
    attributionControl: true,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    touchZoom: false,
  });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(revealMap);

  const truth = L.latLng(round.truth.lat, round.truth.lng);
  const guess = L.latLng(round.guess.lat, round.guess.lng);
  L.circleMarker(guess, {
    radius: 12, color: "#fff", weight: 3, fillColor: "#555", fillOpacity: 1,
  }).addTo(revealMap).bindTooltip("Guess", { permanent: true, direction: "top" });
  const truthMarker = L.circleMarker(truth, {
    radius: 12, color: "#111", weight: 3, fillColor: "#ffcf3f", fillOpacity: 1,
  });

  revealMap.fitBounds(L.latLngBounds([truth, guess]).pad(0.25), { maxZoom: 10 });
  setTimeout(() => revealMap.invalidateSize({ pan: false }), 60);

  // Animate the guess-to-truth line drawing over ~1s, then count the score up
  // (spec §11 — get this beat right).
  const line = L.polyline([guess], { color: "#ffcf3f", weight: 4, dashArray: "8 10" })
    .addTo(revealMap);
  const DRAW_MS = 1000;
  let start = null;
  const step = (t) => {
    if (start === null) start = t;
    const f = Math.min(1, (t - start) / DRAW_MS);
    const eased = 1 - Math.pow(1 - f, 3);
    line.setLatLngs([
      guess,
      L.latLng(
        guess.lat + (truth.lat - guess.lat) * eased,
        guess.lng + (truth.lng - guess.lng) * eased
      ),
    ]);
    if (f < 1) {
      requestAnimationFrame(step);
    } else {
      truthMarker.addTo(revealMap)
        .bindTooltip("Answer", { permanent: true, direction: "top" });
      placeEl.classList.add("show");
      countUpPoints(round.score.points);
    }
  };
  $("tvDistance").textContent = formatDistance(round.score.distanceKm);
  $("tvPoints").textContent = "0";
  requestAnimationFrame(step);
}

function countUpPoints(points) {
  const el = $("tvPoints");
  const DUR = 1200;
  let start = null;
  const step = (t) => {
    if (start === null) start = t;
    const f = Math.min(1, (t - start) / DUR);
    const eased = 1 - Math.pow(1 - f, 2);
    el.textContent = Math.round(points * eased).toLocaleString();
    if (f < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderBoard(state) {
  const board = $("tvBoard");
  board.innerHTML = "";
  const ids = teamIds(state.teams);
  for (const t of standings(state.teams)) {
    const row = document.createElement("div");
    row.className = "row";
    const name = document.createElement("span");
    name.textContent = t.name;
    name.style.color = TEAM_COLORS[ids.indexOf(t.id) % TEAM_COLORS.length];
    const pts = document.createElement("span");
    pts.className = "pts";
    pts.textContent = t.total.toLocaleString();
    row.append(name, pts);
    board.appendChild(row);
  }
}

/* ---------------- Game over: podium + confetti ---------------- */

function renderGameOver(state) {
  showScreen("s-gameover");
  const podium = $("podium");
  podium.innerHTML = "";
  const ids = teamIds(state.teams);
  standings(state.teams).forEach((t, rank) => {
    const slot = document.createElement("div");
    slot.className = "slot";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = t.name;
    name.style.color = TEAM_COLORS[ids.indexOf(t.id) % TEAM_COLORS.length];
    const score = document.createElement("div");
    score.className = "score";
    score.textContent = t.total.toLocaleString();
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.textContent = rank + 1;
    slot.append(name, score, bar);
    podium.appendChild(slot);
  });
  if (!confettiDone) {
    confettiDone = true;
    spawnConfetti();
  }
}

function spawnConfetti() {
  const wrap = $("confetti");
  wrap.innerHTML = "";
  const colors = ["#ffcf3f", "#4dd6ff", "#ff6ec7", "#7dff8a", "#f4f4f6"];
  for (let i = 0; i < 90; i++) {
    const bit = document.createElement("i");
    bit.style.left = `${(i * 137.5) % 100}%`;
    bit.style.background = colors[i % colors.length];
    bit.style.animationDuration = `${3 + (i % 7) * 0.55}s`;
    bit.style.animationDelay = `${(i % 11) * 0.35}s`;
    wrap.appendChild(bit);
  }
}

/* ================================================================
 * Boot: URL param or manual entry (TV-remote friendly)
 * ================================================================ */

const input = $("roomInput");
input.addEventListener("input", () => {
  const code = input.value.toUpperCase().replace(/[^A-HJ-NP-Z]/g, "");
  input.value = code;
  $("entryErr").textContent = "";
  if (code.length === 4 && isValidRoomCode(code)) {
    followedCodes = new Set(); // manual entry starts a fresh follow chain
    joinRoom(code);
  }
});

// Game-over escape hatch: back to the room-code entry screen.
$("btnNewEntry").addEventListener("click", () => leaveRoom());

onConnectionChange((isConnected) => {
  $("connPill").classList.toggle("hidden", isConnected);
});

const urlCode = (new URLSearchParams(location.search).get("room") || "")
  .toUpperCase();
if (isValidRoomCode(urlCode)) {
  input.value = urlCode;
  joinRoom(urlCode);
} else {
  input.focus();
}
