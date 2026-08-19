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
  formatSeconds,
  resultRowText,
  teamIds,
  standings,
  showdownResults,
} from "./game.js";
import {
  H2H_SCREEN_IDS,
  renderH2H,
  renderH2HGameOverNote,
  disposeH2H,
} from "./screen-h2h.js";

const $ = (id) => document.getElementById(id);
const SCREENS = [
  "s-entry", "s-lobby", "s-round", "s-guess", "s-reveal", "s-gameover",
  ...H2H_SCREEN_IDS,
];
const TEAM_COLORS = ["var(--team-1)", "var(--team-2)", "var(--team-3)", "var(--team-4)"];
// Same palette as concrete hex: Leaflet paints SVG markers with these, and
// CSS var() strings don't resolve inside SVG presentation attributes.
const TEAM_HEX = ["#ffcf3f", "#4dd6ff", "#ff6ec7", "#7dff8a"];

const teamHex = (teams, id) => {
  const i = teamIds(teams).indexOf(id);
  return i >= 0 ? TEAM_HEX[i % TEAM_HEX.length] : TEAM_HEX[0];
};

// Leaflet tooltip content is HTML; team names are user input.
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

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

let liveMap = null;      // guessing-phase world map (kept across rounds)
let liveMarker = null;   // the host's in-progress pin, mirrored live
let liveViewKey = null;  // last host view applied, so we only animate on change
let livePinPulseAt = 0;  // last ripple time — pulses are rationed, not per-write
let livePinColor = null; // active team's color on the live pin
let placedLayer = null;  // showdown: pins already locked in, team-colored
let placedKey = null;    // results fingerprint, so we redraw only on change

/* ================================================================
 * Room entry
 * ================================================================ */

// Rooms joined since the last manual entry — breaks nextRoom pointer cycles
// (A -> B -> A would otherwise re-subscribe forever).
let followedCodes = new Set();

function joinRoom(code) {
  // A prior subscription can still be live here (e.g. the user re-typed a
  // code while the first room's "not found" was in flight) — drop it, or
  // its callbacks keep firing against the new roomCode.
  if (unsubRoom) { unsubRoom(); unsubRoom = null; }
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
  disposeH2H();
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
  disposeH2H();
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
  // Head-to-head rooms carry mode: "h2h" and render through their own
  // module — except game over, which reuses the couch podium + confetti
  // with the crown-handoff note added. Couch rooms are untouched by this
  // branch (their states have no mode field).
  if (state.mode === "h2h") {
    if (state.phase === "gameOver") {
      renderGameOver(state);
      renderH2HGameOverNote(state);
    } else {
      confettiDone = false;
      renderH2H(state, showScreen);
    }
    return;
  }
  disposeH2H(); // a couch state after an h2h room (nextRoom can cross modes)

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
  if (state.phase !== "guessing") {
    liveViewKey = null;
    if (placedLayer) placedLayer.clearLayers();
    placedKey = null;
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
  if (round.showdown && ids.length > 1) {
    teamEl.textContent = "FINAL SHOWDOWN — every team plays!";
    teamEl.style.color = "var(--accent)";
    teamEl.classList.add("showdown");
  } else if (ids.length > 1 && activeIdx >= 0) {
    teamEl.textContent = state.teams[state.activeTeam].name;
    teamEl.style.color = TEAM_COLORS[activeIdx % TEAM_COLORS.length];
    teamEl.classList.remove("showdown");
  } else {
    teamEl.textContent = "";
    teamEl.classList.remove("showdown");
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

// The pin is a divIcon so CSS can animate it: it drops in with a bounce the
// first time the host places it, and fires a ripple pulse when it moves.
// Anchored at its center to match the circleMarker it replaced. The pin
// wears the active team's color via a CSS custom property.
function livePinIcon(color) {
  return L.divIcon({
    className: "tv-live-pin-wrap",
    html: `<div class="pin-parts" style="--pin-color:${color}">` +
      '<div class="pin-ripple"></div><div class="tv-live-pin"></div></div>',
    iconSize: [0, 0],
  });
}

// Whose-turn corner label on the guess map (injected — HTML untouched).
let guessTeamEl = null;
function ensureGuessTeamEl() {
  if (!guessTeamEl) {
    guessTeamEl = document.createElement("div");
    guessTeamEl.className = "tv-hud-corner tv-guess-team";
    $("s-guess").appendChild(guessTeamEl);
  }
  return guessTeamEl;
}

// Showdown pins already locked in, in team colors with name tags — the
// couch watches the board fill up as the phone goes around.
function renderPlacedPins(state, round) {
  const results = (round.showdown && round.results) || {};
  const key = Object.keys(results).sort().join(",");
  if (key === placedKey) return;
  placedKey = key;
  if (!placedLayer) placedLayer = L.layerGroup().addTo(liveMap);
  placedLayer.clearLayers();
  for (const id of Object.keys(results)) {
    const r = results[id];
    L.circleMarker([r.guess.lat, r.guess.lng], {
      radius: 10,
      color: "#fff",
      weight: 3,
      fillColor: teamHex(state.teams, id),
      fillOpacity: 1,
      interactive: false,
    })
      .addTo(placedLayer)
      .bindTooltip(escapeHtml(state.teams[id].name),
        { permanent: true, direction: "top" });
  }
}

// Ripple on move — but rationed: liveGuess streams at ≤4/s and a ring per
// write would be strobing, so pulses are spaced out to feel intentional.
const PIN_PULSE_MIN_MS = 900;
function pulseLivePin() {
  if (!liveMarker) return;
  const el = liveMarker.getElement();
  const ring = el && el.querySelector(".pin-ripple");
  if (!ring) return;
  ring.classList.remove("go");
  void ring.offsetWidth; // reflow so the animation restarts from frame 0
  ring.classList.add("go");
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
  const ids = teamIds(state.teams);
  $("tvGuessRound").textContent = round.showdown
    ? "FINAL SHOWDOWN"
    : `Round ${round.number || 1}` +
      (state.settings ? ` / ${state.settings.roundCount}` : "");

  // Whose turn is it? Solo rounds name the team; showdown turns count down
  // the pass-around ("Blue is guessing · 2/3").
  const teamEl = ensureGuessTeamEl();
  const activeIdx = ids.indexOf(state.activeTeam);
  if (ids.length > 1 && activeIdx >= 0) {
    const name = state.teams[state.activeTeam].name;
    if (round.showdown && Array.isArray(round.order)) {
      const turn = round.order.indexOf(state.activeTeam) + 1;
      teamEl.textContent = `${name} is guessing · ${turn}/${round.order.length}`;
    } else {
      teamEl.textContent = `${name} is guessing`;
    }
    teamEl.style.color = TEAM_COLORS[activeIdx % TEAM_COLORS.length];
  } else {
    teamEl.textContent = "";
  }

  renderPlacedPins(state, round);

  // Follow the host's framing: round/liveView mirrors their guess map's
  // center + zoom. Applied only when it actually changes, with a short
  // glide so the TV tracks smoothly rather than teleporting.
  const lv = round.liveView;
  if (lv && typeof lv.lat === "number" && typeof lv.lng === "number" &&
      typeof lv.zoom === "number") {
    const key = `${lv.lat.toFixed(5)},${lv.lng.toFixed(5)},${lv.zoom}`;
    if (key !== liveViewKey) {
      liveViewKey = key;
      liveMap.setView([lv.lat, lv.lng], lv.zoom, { animate: true, duration: 0.6 });
    }
  }

  const lg = round.liveGuess;
  const pinColor = ids.length > 1 && activeIdx >= 0
    ? TEAM_HEX[activeIdx % TEAM_HEX.length]
    : TEAM_HEX[0];
  if (lg && typeof lg.lat === "number" && typeof lg.lng === "number") {
    $("tvGuessHint").classList.add("hidden");
    const pos = L.latLng(lg.lat, lg.lng);
    if (liveMarker) {
      if (pinColor !== livePinColor) {
        // New team took over mid-showdown: recolor (replays the drop bounce,
        // which reads as the new team's pin arriving).
        livePinColor = pinColor;
        liveMarker.setIcon(livePinIcon(pinColor));
      }
      const moved = liveMarker.getLatLng().distanceTo(pos) > 1; // metres
      liveMarker.setLatLng(pos);
      if (moved && Date.now() - livePinPulseAt >= PIN_PULSE_MIN_MS) {
        livePinPulseAt = Date.now();
        pulseLivePin();
      }
    } else {
      livePinColor = pinColor;
      liveMarker = L.marker(pos, {
        icon: livePinIcon(pinColor),
        interactive: false,
        keyboard: false,
      }).addTo(liveMap);
      // The drop-in bounce plays via CSS on the fresh element; hold the
      // ripple until the pin "lands" so the two beats read as one gesture.
      livePinPulseAt = Date.now();
      const el = liveMarker.getElement();
      const ring = el && el.querySelector(".pin-ripple");
      if (ring) {
        ring.style.animationDelay = "0.42s";
        ring.classList.add("go");
        setTimeout(() => { ring.style.animationDelay = ""; }, 1300);
      }
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
  if (round.showdown) {
    renderShowdownReveal(state, round);
    return;
  }
  // Solo reveal: make sure the stat tiles are back if the previous reveal
  // this screen showed was a showdown (e.g. a new game just started).
  document.querySelectorAll("#s-reveal .reveal-num")
    .forEach((el) => el.classList.remove("hidden"));
  const sd = $("tvShowdown");
  if (sd) sd.remove();
  $("tvBoard").classList.remove("captioned");
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
      showSpeedNote(round.score); // speed lands with the score count-up
    }
  };
  $("tvDistance").textContent = formatDistance(round.score.distanceKm);
  $("tvPoints").textContent = "0";
  ensureSpeedNote().textContent = "";
  requestAnimationFrame(step);
}

/* Showdown reveal: every team's pin on one map. Lines draw one after
 * another in guess order — the leader's first, the underdog's last — then
 * the answer lands, the place name pops, and the closest team is crowned. */

function ensureShowdownBoard() {
  let el = $("tvShowdown");
  if (!el) {
    el = document.createElement("div");
    el.id = "tvShowdown";
    el.className = "reveal-board tv-showdown";
    el.dataset.caption = "This round";
    $("tvBoard").before(el);
  }
  el.innerHTML = "";
  return el;
}

function renderShowdownReveal(state, round) {
  const results = round.results || {};
  const order = (Array.isArray(round.order) ? round.order : Object.keys(results))
    .filter((id) => results[id]);
  if (!round.truth || order.length === 0) return;
  if (revealShownForRound === round.number) return; // animate once per round
  revealShownForRound = round.number;

  // The two big stat tiles make way for the per-team result board.
  document.querySelectorAll("#s-reveal .reveal-num")
    .forEach((el) => el.classList.add("hidden"));
  const boardEl = ensureShowdownBoard();
  $("tvBoard").dataset.caption = "Totals";
  $("tvBoard").classList.add("captioned");

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
  const guessPts = order.map(
    (id) => L.latLng(results[id].guess.lat, results[id].guess.lng)
  );
  revealMap.fitBounds(
    L.latLngBounds([truth, ...guessPts]).pad(0.25), { maxZoom: 10 }
  );
  setTimeout(() => revealMap.invalidateSize({ pan: false }), 60);

  const closestId = showdownResults(round)[0].id;
  const rows = {};

  const finish = () => {
    L.circleMarker(truth, {
      radius: 12, color: "#111", weight: 3, fillColor: "#ffcf3f", fillOpacity: 1,
    }).addTo(revealMap)
      .bindTooltip("Answer", { permanent: true, direction: "top" });
    placeEl.classList.add("show");
    const row = rows[closestId];
    if (row) {
      row.classList.add("closest");
      row.firstChild.textContent = `👑 ${state.teams[closestId].name}`;
    }
  };

  const DRAW_MS = 800;
  const drawNext = (i) => {
    if (i >= order.length) { finish(); return; }
    const id = order[i];
    const r = results[id];
    const guess = L.latLng(r.guess.lat, r.guess.lng);
    const color = teamHex(state.teams, id);
    L.circleMarker(guess, {
      radius: 10, color: "#fff", weight: 3, fillColor: color, fillOpacity: 1,
    }).addTo(revealMap)
      .bindTooltip(escapeHtml(state.teams[id].name),
        { permanent: true, direction: "top" });
    const line = L.polyline([guess], { color, weight: 4, dashArray: "8 10" })
      .addTo(revealMap);
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
      if (f < 1) { requestAnimationFrame(step); return; }
      const row = document.createElement("div");
      row.className = "row";
      const name = document.createElement("span");
      name.textContent = state.teams[id].name;
      name.style.color = color;
      const val = document.createElement("span");
      val.className = "pts";
      val.textContent = resultRowText(r);
      row.append(name, val);
      rows[id] = row;
      boardEl.appendChild(row);
      setTimeout(() => drawNext(i + 1), 300);
    };
    requestAnimationFrame(step);
  };
  drawNext(0);
}

// Speed line under the points tile (injected — HTML untouched): the
// "answered in 23s (⚡+400)" beat of the reveal.
function ensureSpeedNote() {
  let note = $("tvSpeedNote");
  if (!note) {
    note = document.createElement("div");
    note.id = "tvSpeedNote";
    note.className = "time-note";
    $("tvPoints").closest(".reveal-num").appendChild(note);
  }
  return note;
}

function showSpeedNote(score) {
  const note = ensureSpeedNote();
  if (typeof score.elapsedMs === "number") {
    note.textContent =
      `answered in ${formatSeconds(score.elapsedMs)}` +
      ` (⚡+${(score.timeBonus || 0).toLocaleString()})`;
    note.classList.toggle("zero", !score.timeBonus);
  } else {
    note.textContent = "";
  }
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
