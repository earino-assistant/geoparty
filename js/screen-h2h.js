// screen-h2h.js — TV renderer for head-to-head mode. Same contract as the
// couch renderer: a pure subscriber. The TV aggregates up to four team
// feeds (round/live/<tid>) into a split-panel view during the round, then
// composes the all-pins reveal. It writes nothing (screen-ui.js owns the
// heartbeat, as always).

import { createViewer } from "./viewer-ui.js";
import { scrubErrorMessage } from "./imagery.js";
import { formatCountdown, formatDistance, resultRowText, teamIds, standings, sanitizePose } from "./game.js";
import { submittedCount, submitRank, revealOrder, roundClosest, revealAceKm } from "./h2h.js";
import { twistHudTag, twistHidesRivalPins, twistCardForRound } from "./twist.js";
import { tallyLineText } from "./night.js";
import { revealDecoys } from "./decoy.js";
import {
  autoAdvanceStatus,
  advanceTarget,
  countdownText,
} from "./autoadvance.js";
import { phoneJoinLine } from "./tvlink.js";
import { countdownTick } from "./fx.js";
import { playSound, prefersReducedMotion, stampFlash } from "./fx-ui.js";
import { medalForDistance } from "./records.js";
import { teamHex, tvCascadeRevealScene } from "./revealmap.js";
import { renderRevealScene } from "./revealmap-ui.js";

const $ = (id) => document.getElementById(id);

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

let revealHandle = null;
let revealShownFor = null;   // `${createdAt}:${round}` — animate once
let countInterval = null;
let countTicked = null;      // S4: last 3-2-1 second the TV ticked for
let twistCardShownFor = null;   // C1/R2: round number the h2h TV twist card fired for
let twistCardEl = null;
let twistCardTimer = null;

// R2 (C1): the full-screen twist interstitial on the h2h TV — the same
// `.twist-card-overlay` ritual family (card flip + scrim + S4 sting) the couch
// TV, host phone, 3-2-1 and Showdown card use, once per round, auto-dismissing
// in ~2.5s. Blind Duel shows its card here like any other twist. Reduced motion
// collapses the flip to a fade via the overlay's CSS — no JS branch needed.
function showTvTwistCard(card) {
  playSound("sting");
  if (!twistCardEl) {
    twistCardEl = document.createElement("div");
    twistCardEl.className = "twist-card-overlay";
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

function panelStatus(p, text) {
  if (p.statusEl.textContent !== text) p.statusEl.textContent = text;
}

function disposePanels() {
  for (const tid of Object.keys(panels)) {
    const p = panels[tid];
    if (p.iv) { p.iv.destroy(); p.iv = null; }
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
  countTicked = null;
}

// Full teardown — called when the TV leaves the room or a couch-mode
// state arrives (mode can change across a nextRoom follow).
export function disposeH2H() {
  disposePanels();
  stopTimer();
  stopCount();
  stopAdvanceNote();
  revealHandle?.destroy();
  revealHandle = null;
  revealShownFor = null;
  twistCardShownFor = null;
  if (twistCardEl) twistCardEl.classList.add("hidden");
  clearTimeout(twistCardTimer);
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
  if (state.phase !== "reveal") {
    stopCount();
    stopAdvanceNote();
    revealShownFor = null;
  }
}

/* S6: the shared soft-auto-advance countdown, rendered TV-side. The TV
 * writes nothing — it just ticks `autoAdvanceAt − Date.now()` like every
 * other deadline. A held (nulled) or lapsed deadline blanks the note. */
let advanceInterval = null;
let advanceState = null;

function updateAdvanceNote() {
  const state = advanceState;
  const el = $("h2hAdvanceNote");
  if (!el) return;
  if (!state || state.phase !== "reveal" || !state.round) {
    el.textContent = "";
    return;
  }
  const status = autoAdvanceStatus(state.round.autoAdvanceAt, Date.now());
  const target = advanceTarget(
    state.round.number, state.settings ? state.settings.roundCount : 0);
  el.textContent = countdownText(status, target) || "";
}

function renderAdvanceNote(state) {
  advanceState = state;
  if (!advanceInterval) advanceInterval = setInterval(updateAdvanceNote, 250);
  updateAdvanceNote();
}

function stopAdvanceNote() {
  if (advanceInterval) { clearInterval(advanceInterval); advanceInterval = null; }
  advanceState = null;
  const el = $("h2hAdvanceNote");
  if (el) el.textContent = "";
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
  $("h2hLobbyCode").classList.toggle("skeleton", !code); // P1.7
  // Readable from the couch: the short site address + code, never a raw
  // URL dump (tvlink.js owns that rule).
  $("h2hLobbyUrl").textContent = code ? phoneJoinLine(location.href, code) : "";
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
  const base = ids.length < 2
    ? "Every team plays on their own phone — scan the host's QR to join"
    : `${ids.length} teams ready — waiting for the host to start`;
  // G3 (C5): the night tally rides the nextRoom chain into game ≥ 2's lobby —
  // one muted line, folded into the existing status (§3.3). Team names ride it,
  // and #h2hLobbyNote already carries data-ph-mask.
  const tally = tallyLineText(state.night, state.teams);
  $("h2hLobbyNote").textContent = tally ? `${tally} · ${base}` : base;
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
      iv: null, viewer: null, map: null, marker: null,
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
      if (!p || p.iv) continue;
      p.iv = createViewer({
        surface: "tv_panel",
        container: p.viewerEl.id,
        moveAllowed: false,
        component: {
          // Display-only, same as the couch screen viewer (spec §6).
          cover: false, direction: false, sequence: false,
          keyboard: false, pointer: false, zoom: false, bearing: false,
        },
      });
      p.viewer = p.iv.viewer;   // null when construction failed
      p.iv.beginRound((state.round && state.round.number) || 1);
      if (seedImage) {
        p.imageId = seedImage;
        p.iv.moveTo(seedImage, "seed")
          .catch((e) => console.warn(
            `panel ${tid}: seed image failed —`, scrubErrorMessage(e)));
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
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
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
    (state.settings ? ` / ${state.settings.roundCount}` : "") +
    (round.twist ? ` · ${twistHudTag(round.twist.id)}` : "");   // G2
  // R2 (C1): the twist ritual is a full-screen card flip on the h2h TV too, not
  // just the HUD tag — once per round (Blind Duel included), reduced-motion → fade.
  const twistCard = twistCardForRound(round, twistCardShownFor);
  if (twistCard) {
    twistCardShownFor = twistCard.roundNumber;
    showTvTwistCard(twistCard);
  }
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
  if (p.iv && targetImage && targetImage !== p.imageId) {
    p.imageId = targetImage;
    p.iv.moveTo(targetImage, "follow")
      // Scrubbed: a raw SDK rejection carries the image id (review P1-1).
      .catch((e) => console.warn(
        `panel ${tid}: image load failed —`, scrubErrorMessage(e)));
  }

  if (stage === "map") {
    showPanelMap(p);
    panelStatus(p, "on the map 📍");
    const v = feed && feed.view;
    if (v && typeof v.lat === "number" && typeof v.zoom === "number") {
      const key = `${v.lat.toFixed(4)},${v.lng.toFixed(4)},${v.zoom}`;
      if (key !== p.viewKey) {
        p.viewKey = key;
        p.map.setView([v.lat, v.lng], v.zoom,
          { animate: !prefersReducedMotion(), duration: 0.5 });
      }
    }
    // Blind Duel (G2, spec §3.2): the TV must never contradict the card or the
    // hidden-information constitution — rival live pins are invisible this round.
    // Force the "no pin" path so a marker planted before the twist was known
    // also gets cleared. The map view + "on the map 📍" status still update.
    const blind = twistHidesRivalPins(round.twist && round.twist.id);
    const pin = blind ? null : (feed && feed.pin);
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
    // Guard against a non-finite pose (a racing/legacy writer): setCenter on a
    // NaN center throws in the SDK.
    const pose = sanitizePose(feed && feed.pose);
    if (p.viewer && pose) {
      const key = `${pose.bearing}|${JSON.stringify(pose.center)}|${pose.zoom}`;
      if (key !== p.poseKey) {
        p.poseKey = key;
        try {
          p.viewer.setCenter(pose.center);
          p.viewer.setZoom(pose.zoom);
        } catch { /* viewer between images; next write catches up */ }
      }
    }
  }
}

// Round countdown from endsAt minus our own clock (never ticked through
// Firebase) — same rule as couch.
// S4 tick memory: renderLive restarts this timer on every state render
// (team feeds echo ≤4/s each), so the last-ticked second lives outside the
// interval and resets only when the deadline changes (a new round).
let lastTicked = null;
let lastTickEndsAt = null;

function startTimer(endsAt) {
  stopTimer();
  const el = $("h2hCountdown");
  if (!endsAt) { el.textContent = ""; return; }
  if (endsAt !== lastTickEndsAt) {
    lastTickEndsAt = endsAt;
    lastTicked = null;
  }
  const tick = () => {
    const left = endsAt - Date.now();
    el.textContent = formatCountdown(left);
    el.classList.toggle("low", left < 15_000);
    const t = countdownTick(lastTicked, left);
    if (t) {
      lastTicked = t.second;
      playSound(t.urgent ? "tickUrgent" : "tick");
    }
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

  // S4: the 3-2-1 gets an urgent tick per second — the heads-up cue.
  const countBeat = (left) => {
    const t = countdownTick(countTicked, left, 5);
    if (t) { countTicked = t.second; playSound("tickUrgent"); }
  };

  const msLeft = (round.revealAt || 0) - Date.now();
  if (msLeft > 150) {
    if (revealShownFor === key) return;
    overlay.classList.remove("hidden");
    $("h2hCountNum").textContent = String(Math.ceil(msLeft / 1000));
    countBeat(msLeft);
    if (!countInterval) {
      countInterval = setInterval(() => {
        const left = (round.revealAt || 0) - Date.now();
        if (left <= 150) {
          stopCount();
          renderReveal(state, showScreen);
          return;
        }
        $("h2hCountNum").textContent = String(Math.ceil(left / 1000));
        countBeat(left);
      }, 100);
    }
    return;
  }

  stopCount();
  overlay.classList.add("hidden");
  renderAdvanceNote(state); // S6: runs every call so holds blank it live
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

  const order = revealOrder(round); // farthest first, forfeits leading
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

  // The truth marker + "Answer" now land in the scene finale; finish() keeps
  // only the off-map beats: place-name pop, sting, crown, ACE burst.
  const finish = () => {
    placeEl.classList.add("show");
    playSound("sting"); // S4: the truth lands — every head turns up
    if (closestId && rows[closestId]) {
      rows[closestId].classList.add("closest");
      rows[closestId].firstChild.textContent =
        `👑 ${state.teams[closestId].name}`;
    }
    // R3 (C2): the ACE burst rides the closest pin landing in the farthest-first
    // cascade — fires only when the closest pin is a sub-1km ACE. Ceremony only,
    // no points change; reduced-motion collapses the stamp via CSS.
    const aceKm = revealAceKm(round);
    if (medalForDistance(aceKm).ace) stampFlash(`🎯 ACE — ${formatDistance(aceKm)}`);
  };

  // The cascade (decoys 🎭 first, then farthest-first pins with SUPER SURE
  // halos, then the gold answer) is a shared scene now. Each pin's row is
  // appended as its line lands (or immediately for a forfeit beat).
  revealHandle?.destroy();
  revealHandle = renderRevealScene("h2hRevealMap", tvCascadeRevealScene({
    truth: round.truth,
    entries: order,
    decoys: revealDecoys(round),
    teams: state.teams,
    reducedMotion: prefersReducedMotion(),
  }), {
    onStep: ({ index }) => addRow(order[index]),
    onFinish: finish,
  });
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
