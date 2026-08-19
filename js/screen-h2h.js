// screen-h2h.js — TV renderer for head-to-head mode. Same contract as the
// couch renderer: a pure subscriber. The TV aggregates up to four team
// feeds (round/live/<tid>) into a split-panel view during the round, then
// composes the all-pins reveal. It writes nothing (screen-ui.js owns the
// heartbeat, as always).

import { MAPILLARY_TOKEN } from "../config.js";
import { formatCountdown, resultRowText, teamIds, standings } from "./game.js";
import { submittedCount, submitRank, revealOrder, roundClosest } from "./h2h.js";
import { superSureLabel } from "./supersure.js";

const $ = (id) => document.getElementById(id);
const TEAM_HEX = ["#ffcf3f", "#4dd6ff", "#ff6ec7", "#7dff8a"];
const teamHex = (teams, id) => {
  const i = teamIds(teams).indexOf(id);
  return i >= 0 ? TEAM_HEX[i % TEAM_HEX.length] : TEAM_HEX[0];
};
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const H2H_SCREEN_IDS = ["s-h2h-lobby", "s-h2h-live", "s-h2h-reveal"];

/* ================================================================
 * Panel state. One panel per team, keyed by team id. Each holds its
 * own MapillaryJS viewer and (lazily) its own mini Leaflet map, and
 * remembers the last applied pose/view/pin so the ≤4/s feed only
 * touches the DOM when something actually changed.
 * ================================================================ */

let panels = {};        // tid -> panel record
let gridKey = null;     // teams+room fingerprint; rebuild when it changes
let roundSeen = null;   // round number the panels were reset for
let timerInterval = null;

let revealMap = null;
let revealShownFor = null;   // `${createdAt}:${round}` — animate once
let countInterval = null;

function panelStatus(p, text) {
  if (p.statusEl.textContent !== text) p.statusEl.textContent = text;
}

function disposePanels() {
  for (const tid of Object.keys(panels)) {
    const p = panels[tid];
    if (p.viewer) { try { p.viewer.remove(); } catch { /* gone */ } }
    if (p.map) { try { p.map.remove(); } catch { /* gone */ } }
  }
  panels = {};
  gridKey = null;
  roundSeen = null;
  const grid = $("h2hGrid");
  if (grid) grid.innerHTML = "";
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function stopCount() {
  if (countInterval) { clearInterval(countInterval); countInterval = null; }
}

// Full teardown — called when the TV leaves the room or a couch-mode
// state arrives (mode can change across a nextRoom follow).
export function disposeH2H() {
  disposePanels();
  stopTimer();
  stopCount();
  if (revealMap) { try { revealMap.remove(); } catch { /* gone */ } revealMap = null; }
  revealShownFor = null;
  const note = $("tvNextHost");
  if (note) note.classList.add("hidden");
}

/* ================================================================
 * Dispatch
 * ================================================================ */

export function renderH2H(state, showScreen) {
  switch (state.phase) {
    case "lobby": renderLobby(state, showScreen); break;
    case "roundActive": renderLive(state, showScreen); break;
    case "reveal": renderReveal(state, showScreen); break;
    default: break;
  }
  if (state.phase !== "roundActive") stopTimer();
  if (state.phase !== "reveal") { stopCount(); revealShownFor = null; }
}

// Game-over hook: screen-ui reuses the couch podium; this adds the
// crown-handoff line underneath ("Team X runs the next game").
export function renderH2HGameOverNote(state) {
  disposePanels();
  stopTimer();
  stopCount();
  const note = $("tvNextHost");
  if (!note) return;
  const winner = state.hostTeam && state.teams && state.teams[state.hostTeam];
  if (winner) {
    note.textContent = `👑 ${winner.name} won — their phone runs the next game`;
    note.style.color = teamHex(state.teams, state.hostTeam);
    note.classList.remove("hidden");
  } else {
    note.classList.add("hidden");
  }
}

/* ---------------- Lobby ---------------- */

function renderLobby(state, showScreen) {
  disposePanels(); // fresh game (or a re-lobby): panels rebuild on round 1
  showScreen("s-h2h-lobby");
  const code = codeFromUrl();
  $("h2hLobbyCode").textContent = code || "";
  $("h2hLobbyUrl").textContent = code
    ? `Phones join at ${new URL(`player.html?room=${code}`, location.href).href}`
    : "";
  const wrap = $("h2hLobbyTeams");
  wrap.innerHTML = "";
  const ids = teamIds(state.teams);
  ids.forEach((id) => {
    const chip = document.createElement("div");
    chip.className = "team-chip";
    chip.textContent =
      state.teams[id].name + (id === state.hostTeam ? " 👑" : "");
    chip.style.color = teamHex(state.teams, id);
    wrap.appendChild(chip);
  });
  $("h2hLobbyNote").textContent = ids.length < 2
    ? "Every team plays on their own phone — scan the host's QR to join"
    : `${ids.length} teams ready — waiting for the host to start`;
}

// The screen knows its room code only from its own URL (kept fresh by
// screen-ui's history.replaceState on join) — state itself has no code.
function codeFromUrl() {
  return (new URLSearchParams(location.search).get("room") || "").toUpperCase();
}

/* ---------------- Live: the split-panel race ----------------
 *
 * Layout scales 1→4 (CSS drives off data-n):
 *   1 team  — full screen (same as couch, effectively)
 *   2 teams — side-by-side halves
 *   3 teams — two up top, one centered below at the same size, so no
 *             panel is privileged and nothing is stretched thin
 *   4 teams — quad
 * Every panel is border-lit in its team color with a name chip and a
 * status line ("exploring" / "on the map" / "LOCKED IN #2"), so the
 * audience can track four stories at once without squinting.
 */

function ensureGrid(state) {
  const ids = teamIds(state.teams);
  const key = `${state.createdAt}|${ids.join(",")}`;
  if (key === gridKey) return;
  disposePanels();
  gridKey = key;
  const grid = $("h2hGrid");
  grid.dataset.n = String(ids.length);
  ids.forEach((tid) => {
    const color = teamHex(state.teams, tid);
    const root = document.createElement("div");
    root.className = "h2h-panel";
    root.style.setProperty("--team-color", color);

    const viewerEl = document.createElement("div");
    viewerEl.className = "h2h-viewer";
    viewerEl.id = `h2hViewer-${tid}`;
    const mapEl = document.createElement("div");
    mapEl.className = "h2h-map hidden";
    mapEl.id = `h2hMap-${tid}`;

    const label = document.createElement("div");
    label.className = "h2h-label";
    const dot = document.createElement("span");
    dot.className = "dot";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = state.teams[tid].name;
    const status = document.createElement("span");
    status.className = "status";
    status.textContent = "exploring";
    label.append(dot, name, status);

    const lock = document.createElement("div");
    lock.className = "h2h-lock hidden";
    const stamp = document.createElement("div");
    stamp.className = "stamp";
    stamp.textContent = "LOCKED IN";
    const rank = document.createElement("div");
    rank.className = "rank";
    lock.append(stamp, rank);

    root.append(viewerEl, mapEl, label, lock);
    grid.appendChild(root);

    panels[tid] = {
      root, viewerEl, mapEl, statusEl: status, lockEl: lock, rankEl: rank,
      viewer: null, map: null, marker: null,
      imageId: null, poseKey: null, viewKey: null, pinKey: null,
      mapShown: false, locked: false, color,
    };
  });
  // Viewers after layout so MapillaryJS sizes to the real panel box. Seed
  // each with the round's pano immediately — the team's own live feed takes
  // over from its first throttled write.
  const seedImage = (state.round && state.round.imageId) || null;
  requestAnimationFrame(() => {
    for (const tid of ids) {
      const p = panels[tid];
      if (!p || p.viewer) continue;
      p.viewer = new mapillary.Viewer({
        accessToken: MAPILLARY_TOKEN,
        container: p.viewerEl.id,
        component: {
          // Display-only, same as the couch screen viewer (spec §6).
          cover: false, direction: false, sequence: false,
          keyboard: false, pointer: false, zoom: false, bearing: false,
        },
      });
      if (seedImage) {
        p.imageId = seedImage;
        p.viewer.moveTo(seedImage)
          .catch((e) => console.warn(`panel ${tid}: seed image failed`, e));
      }
    }
  });
}

function ensurePanelMap(p) {
  if (p.map) return;
  p.map = L.map(p.mapEl.id, {
    zoomControl: false, dragging: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false,
    attributionControl: false,
  }).setView([25, 10], 2);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
  }).addTo(p.map);
}

// Same animated drop-pin the couch screen uses, in the team's color.
function livePinIcon(color) {
  return L.divIcon({
    className: "tv-live-pin-wrap",
    html: `<div class="pin-parts" style="--pin-color:${color}">` +
      '<div class="pin-ripple"></div><div class="tv-live-pin"></div></div>',
    iconSize: [0, 0],
  });
}

function renderLive(state, showScreen) {
  const wasHidden = $("s-h2h-live").classList.contains("hidden");
  showScreen("s-h2h-live");
  ensureGrid(state);
  const round = state.round || {};
  const ids = teamIds(state.teams);

  if (round.number !== roundSeen) {
    roundSeen = round.number;
    for (const tid of ids) resetPanelForRound(panels[tid]);
  }
  if (wasHidden) {
    for (const tid of ids) {
      const p = panels[tid];
      if (p && p.viewer) { try { p.viewer.resize(); } catch { /* ok */ } }
      if (p && p.map && p.mapShown) p.map.invalidateSize({ pan: false });
    }
  }

  $("h2hRoundNo").textContent =
    `Round ${round.number || 1}` +
    (state.settings ? ` / ${state.settings.roundCount}` : "");
  startTimer(round.endsAt);

  const n = submittedCount(round);
  $("h2hProgress").textContent =
    n > 0 ? `${n} / ${ids.length} locked in` : "";

  const live = round.live || {};
  const results = round.results || {};
  for (const tid of ids) {
    applyTeamFeed(panels[tid], state, round, live[tid], results[tid], tid);
  }
}

function resetPanelForRound(p) {
  if (!p) return;
  p.locked = false;
  p.lockEl.classList.add("hidden");
  p.root.classList.remove("locked");
  p.poseKey = p.viewKey = p.pinKey = null;
  if (p.marker) { p.marker.remove(); p.marker = null; }
  showPanelViewer(p);
  panelStatus(p, "exploring");
}

function showPanelViewer(p) {
  if (!p.mapShown) return;
  p.mapEl.classList.add("hidden");
  p.viewerEl.classList.remove("hidden");
  p.mapShown = false;
  if (p.viewer) { try { p.viewer.resize(); } catch { /* ok */ } }
}

function showPanelMap(p) {
  if (p.mapShown) return;
  ensurePanelMap(p);
  p.viewerEl.classList.add("hidden");
  p.mapEl.classList.remove("hidden");
  p.mapShown = true;
  setTimeout(() => p.map && p.map.invalidateSize({ pan: false }), 60);
}

function applyTeamFeed(p, state, round, feed, result, tid) {
  if (!p) return;

  // Locked teams freeze: overlay + rank badge, feed ignored. Their final
  // pin stays off the TV until the reveal — that's the suspense.
  if (result) {
    if (!p.locked) {
      p.locked = true;
      const rank = submitRank(round, tid);
      p.rankEl.textContent = rank ? `#${rank} in` : "";
      p.lockEl.classList.remove("hidden");
      p.root.classList.add("locked");
      panelStatus(p, "locked in");
    }
    return;
  }
  if (p.locked) resetPanelForRound(p); // forfeit overwritten by a late submit

  const stage = (feed && feed.stage) || "explore";
  const targetImage = (feed && feed.imageId) || round.imageId;

  // The pano follows this team's own image (movement diverges per team).
  if (p.viewer && targetImage && targetImage !== p.imageId) {
    p.imageId = targetImage;
    p.viewer.moveTo(targetImage)
      .catch((e) => console.warn(`panel ${tid}: image load failed`, e));
  }

  if (stage === "map") {
    showPanelMap(p);
    panelStatus(p, "on the map 📍");
    const v = feed && feed.view;
    if (v && typeof v.lat === "number" && typeof v.zoom === "number") {
      const key = `${v.lat.toFixed(4)},${v.lng.toFixed(4)},${v.zoom}`;
      if (key !== p.viewKey) {
        p.viewKey = key;
        p.map.setView([v.lat, v.lng], v.zoom, { animate: true, duration: 0.5 });
      }
    }
    const pin = feed && feed.pin;
    if (pin && typeof pin.lat === "number") {
      const key = `${pin.lat.toFixed(4)},${pin.lng.toFixed(4)}`;
      if (key !== p.pinKey) {
        p.pinKey = key;
        const pos = L.latLng(pin.lat, pin.lng);
        if (p.marker) p.marker.setLatLng(pos);
        else {
          p.marker = L.marker(pos, {
            icon: livePinIcon(p.color), interactive: false, keyboard: false,
          }).addTo(p.map);
        }
      }
    } else if (p.marker) {
      p.marker.remove();
      p.marker = null;
      p.pinKey = null;
    }
  } else {
    showPanelViewer(p);
    panelStatus(p, "exploring");
    const pose = feed && feed.pose;
    if (p.viewer && pose) {
      const key = `${pose.bearing}|${JSON.stringify(pose.center)}|${pose.zoom}`;
      if (key !== p.poseKey) {
        p.poseKey = key;
        try {
          if (Array.isArray(pose.center)) p.viewer.setCenter(pose.center);
          if (typeof pose.zoom === "number") p.viewer.setZoom(pose.zoom);
        } catch { /* viewer between images; next write catches up */ }
      }
    }
  }
}

// Round countdown from endsAt minus our own clock (never ticked through
// Firebase) — same rule as couch.
function startTimer(endsAt) {
  stopTimer();
  const el = $("h2hCountdown");
  if (!endsAt) { el.textContent = ""; return; }
  const tick = () => {
    const left = endsAt - Date.now();
    el.textContent = formatCountdown(left);
    el.classList.toggle("low", left < 15_000);
    if (left <= 0) stopTimer();
  };
  tick();
  timerInterval = setInterval(tick, 250);
}

/* ---------------- Reveal: countdown, then the all-pins beat ----------
 *
 * The phone that completed the submission set stamped round/revealAt a few
 * seconds in the future. Until then the TV holds a giant 3-2-1 over the
 * darkened panels ("ALL TEAMS LOCKED IN") — the cue for every head to turn
 * up. Then the full-screen map: lines draw farthest-first so the animation
 * eliminates teams toward the winner, the truth lands, the place name pops,
 * the closest team is crowned, and the leaderboard stands beside it.
 */

function renderReveal(state, showScreen) {
  showScreen("s-h2h-reveal");
  const round = state.round || {};
  const key = `${state.createdAt}:${round.number}`;
  const overlay = $("h2hCountOverlay");

  const msLeft = (round.revealAt || 0) - Date.now();
  if (msLeft > 150) {
    if (revealShownFor === key) return;
    overlay.classList.remove("hidden");
    $("h2hCountNum").textContent = String(Math.ceil(msLeft / 1000));
    if (!countInterval) {
      countInterval = setInterval(() => {
        const left = (round.revealAt || 0) - Date.now();
        if (left <= 150) {
          stopCount();
          renderReveal(state, showScreen);
          return;
        }
        $("h2hCountNum").textContent = String(Math.ceil(left / 1000));
      }, 100);
    }
    return;
  }

  stopCount();
  overlay.classList.add("hidden");
  if (revealShownFor === key) return; // animate once per round
  if (!round.truth || !round.results) return;
  revealShownFor = key;
  runRevealAnimation(state, round);
}

function runRevealAnimation(state, round) {
  const placeEl = $("h2hPlace");
  placeEl.textContent = round.truth.name || "";
  placeEl.classList.remove("show");

  renderTotalsBoard(state);
  const boardEl = $("h2hRoundBoard");
  boardEl.innerHTML = "";

  if (revealMap) { revealMap.remove(); revealMap = null; }
  revealMap = L.map("h2hRevealMap", {
    zoomControl: false, attributionControl: true, dragging: false,
    scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false,
    keyboard: false, touchZoom: false,
  });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(revealMap);

  const truth = L.latLng(round.truth.lat, round.truth.lng);
  const order = revealOrder(round); // farthest first, forfeits leading
  const guessPts = order.filter((r) => r.guess)
    .map((r) => L.latLng(r.guess.lat, r.guess.lng));
  revealMap.fitBounds(
    L.latLngBounds([truth, ...guessPts]).pad(0.25), { maxZoom: 10 }
  );
  setTimeout(() => revealMap.invalidateSize({ pan: false }), 60);

  const closestId = roundClosest(round);
  const rows = {};
  const addRow = (r) => {
    const row = document.createElement("div");
    row.className = "row";
    const name = document.createElement("span");
    name.textContent = state.teams[r.id].name;
    name.style.color = teamHex(state.teams, r.id);
    const val = document.createElement("span");
    val.className = "pts";
    val.textContent = resultRowText(r);
    row.append(name, val);
    rows[r.id] = row;
    boardEl.appendChild(row);
  };

  const finish = () => {
    L.circleMarker(truth, {
      radius: 12, color: "#111", weight: 3, fillColor: "#ffcf3f", fillOpacity: 1,
    }).addTo(revealMap)
      .bindTooltip("Answer", { permanent: true, direction: "top" });
    placeEl.classList.add("show");
    if (closestId && rows[closestId]) {
      rows[closestId].classList.add("closest");
      rows[closestId].firstChild.textContent =
        `👑 ${state.teams[closestId].name}`;
    }
  };

  const DRAW_MS = 800;
  const drawNext = (i) => {
    if (i >= order.length) { finish(); return; }
    const r = order[i];
    if (!r.guess) { addRow(r); setTimeout(() => drawNext(i + 1), 250); return; }
    const guess = L.latLng(r.guess.lat, r.guess.lng);
    const color = teamHex(state.teams, r.id);
    L.circleMarker(guess, {
      radius: 10, color: "#fff", weight: 3, fillColor: color, fillOpacity: 1,
    }).addTo(revealMap)
      .bindTooltip(escapeHtml(state.teams[r.id].name),
        { permanent: true, direction: "top" });
    // A super-sure pin steps out of hiding here (and only here): verdict
    // halo on the map, verdict text in the round board via resultRowText.
    if (r.superSure) {
      L.circleMarker(guess, {
        radius: 16, color: "#ffcf3f", weight: 3, fill: false,
        dashArray: "4 6", interactive: false,
      }).addTo(revealMap)
        .bindTooltip(superSureLabel(r),
          { permanent: true, direction: "bottom", className: "ss-tooltip" });
    }
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
      addRow(r);
      setTimeout(() => drawNext(i + 1), 300);
    };
    requestAnimationFrame(step);
  };
  drawNext(0);
}

function renderTotalsBoard(state) {
  const board = $("h2hTotals");
  board.innerHTML = "";
  for (const t of standings(state.teams)) {
    const row = document.createElement("div");
    row.className = "row";
    const name = document.createElement("span");
    name.textContent = t.name;
    name.style.color = teamHex(state.teams, t.id);
    const pts = document.createElement("span");
    pts.className = "pts";
    pts.textContent = t.total.toLocaleString();
    row.append(name, pts);
    board.appendChild(row);
  }
}
