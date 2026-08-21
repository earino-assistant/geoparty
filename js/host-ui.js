// host-ui.js — operator phone controller. The host is the single source of
// truth: it holds full game state locally and pushes it to Firebase.

import {
  readRoom,
  writeRoom,
  updateRoom,
  deleteRoom,
  subscribeHeartbeat,
  onConnectionChange,
} from "./firebase.js";
import {
  defaultNight, gameNight, champion,
  tallyLineText, crownHookText, championText, nightSummary,
} from "./night.js";
import {
  normalizeTwistSetting, drawTwist, twistRoundSeconds, twistMoveAllowed,
  twistedRoundScore, twistHudTag, twistRevealTag, twistCard,
} from "./twist.js";
import {
  canTransition,
  makeRoomCode,
  haversineKm,
  scoreForDistance,
  bonusWindowMs,
  timeBonus,
  resultRowText,
  formatCountdown,
  revealResultLine,
  revealBoardRows,
  boardRowText,
  teamForRound,
  teamIds,
  defaultTeams,
  initialRoomState,
  standings,
  isShowdownRound,
  showdownOrder,
  showdownResults,
  sanitizePose,
} from "./game.js";
import { panoMoved } from "./h2h.js";
import {
  superSureAvailable,
  resolveSuperSure,
  superSureSettlement,
  adjustedPoints,
} from "./supersure.js";
import {
  HINT_CARDS,
  SUPER_SURE_SHEET,
  LOCK_LABELS,
  guessMapHintLines,
  lockNowEstimate,
  lockButtonLabel,
  panoHintCard,
  shouldHintSuperSure,
  SUPER_SURE_HINT,
  SUPER_SURE_HINT_ID,
} from "./hints.js";
import {
  oneShotHint,
  showHintCard,
  dismissHintCard,
  paintLockButton,
} from "./hints-ui.js";
import { withUtm, partyShareText, foldBestMoment } from "./share.js";
import { shareResult, shareTvLink } from "./share-ui.js";
import { screenLink, tvBrowserLine } from "./tvlink.js";
import {
  foldHeartbeat,
  screenLive,
  phoneIsScreen,
  lobbyReadiness,
  couchRevealPins,
  crownLine,
} from "./couchscreen.js";
import {
  AUTO_ADVANCE_MS,
  autoAdvanceStatus,
  shouldAutoAdvance,
  advanceTarget,
  advanceSecondsLeft,
  countdownText,
  holdAdvancePatch,
} from "./autoadvance.js";
import { countdownTick, celebrationSpec } from "./fx.js";
import { initSound, playSound, buzz, stampFlash, spawnConfetti } from "./fx-ui.js";
import { loadPool, PoolSampler, normalizeDifficulty } from "./pool.js";
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
  // §4.1: the utility corners (🍪/🔊) leave while a play screen is up, and
  // a deferred first-run consent ask waits for a calm one (§6.5).
  setActiveScreen(id);
}

let toastTimer = null;
// `reportCtx` turns this into the REACTIVE report surface (plan §10.1 as
// reconciled with the UI/UX review): an inline action, only on the toasts
// that already fire for a broken/degraded imagery condition. The pano itself
// gains no permanent chrome.
function toast(msg, reportCtx) {
  const el = $("toast");
  if (reportCtx) toastWithReport(el, msg, reportCtx); else toastPlain(el, msg);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => el.classList.remove("show"), reportCtx ? 6000 : 2500);
}

// One degraded-imagery nudge per game: a party should never be nagged.
let degradedNoticeShown = false;
function noticeDegradedImagery(skips) {
  if (degradedNoticeShown || skips < 2) return;
  degradedNoticeShown = true;
  toast("Some images wouldn’t load — we skipped ahead.", { surface: "host" });
}

// Retryable imagery-degraded overlay (stabilization: review P2-1). A stub
// viewer (SDK blocked / no WebGL) or a transient timeout at round start hands
// back NO entry with `degraded: true`. That is NOT pool exhaustion, so the
// host must NOT finish the game and save a 0-score leaderboard row — nothing
// is pushed to Firebase, the room stays where it was, and the host retries.
// Injected (no HTML id lookup); carries no team name, so nothing new to mask.
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
      catch (e) { console.warn("janitor: could not delete", scrubErrorMessage(e)); }
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

let iv = null;            // instrumented viewer wrapper (viewer-ui.js)
let viewer = null;        // its raw MapillaryJS viewer (pose APIs unchanged)
let guessMap = null;      // Leaflet map
let guessMarker = null;
let superSureArmed = false; // active team's SUPER SURE toggle, this pin only
let timerInterval = null;
let unsubHeartbeat = null;
let screenBeat = null;    // S7 screen liveness (couchscreen.foldHeartbeat)
let prevRoomCode = null;  // finished room to leave a nextRoom pointer in,
                          // so a still-subscribed screen follows us over
let nightToCarry = null;  // G3 Crown Night: the tally to seed the next game
                          // with (bumped for the game just won, reset after a
                          // champion) — threaded finishGame → newGame

function persistActive() {
  lsSet(LS_ACTIVE, { code: roomCode, createdAt: room.createdAt });
}

// Mirror a host-local state change to Firebase, fire-and-forget: RTDB write
// promises don't settle while disconnected, so the game flow must never
// await them (degraded single-screen mode, spec §12).
function push(patch) {
  updateRoom(roomCode, patch).catch((e) => {
    console.warn("Firebase write failed (continuing locally):", scrubErrorMessage(e));
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
    difficulty: normalizeDifficulty($("segDifficulty").dataset.value),
    twists: normalizeTwistSetting($("segTwists").dataset.value), // G2
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
    // G3 Crown Night: seed the room with the tally carried from the last game
    // in this chain (bumped for that win, or reset after a champion). Only a
    // "next game" continuation (prevRoomCode set) carries it; a fresh chain
    // starts at zero.
    room.night = (prevRoomCode && nightToCarry) ? nightToCarry : defaultNight();
    nightToCarry = null;
    sampler = new PoolSampler(pool, roomCode, 0, room.settings.difficulty);
    currentTruth = null;
    gameBest = null;
    writeRoom(roomCode, room).catch((e) =>
      console.warn("Firebase write failed (continuing locally):", scrubErrorMessage(e)));
    if (prevRoomCode && prevRoomCode !== roomCode) {
      // Queued after the new room's write on the same connection, so by the
      // time any subscriber of the old room sees the pointer, the new room
      // exists. The pointer lives inside the old room and is cleaned up
      // with it by the janitor.
      updateRoom(prevRoomCode, { nextRoom: roomCode }).catch((e) =>
        console.warn("nextRoom pointer write failed:", scrubErrorMessage(e)));
    }
    prevRoomCode = null;
    persistActive();
    const mine = lsGet(LS_MY_ROOMS, []);
    mine.push({ code: roomCode, createdAt: room.createdAt });
    lsSet(LS_MY_ROOMS, mine);
    track("game_created", {
      room: roomCode,
      mode: "couch",
      num_teams: teamIds(room.teams).length,
      num_rounds: room.settings.roundCount,
      round_seconds: room.settings.roundSeconds,
      difficulty: room.settings.difficulty,
    });
    enterLobby();
  } catch (e) {
    console.error(scrubErrorMessage(e));
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
  $("roomCodeHuge").classList.remove("skeleton"); // P1.7: real value has landed
  // §6.3: the TV seminar (QR + caption + send button + typing line, all at
  // once, under a note saying you don't need one) is now ONE collapsed
  // module. Collapsed is the honest default — a TV is optional.
  $("hTvAdd").open = false;
  // The Add a TV affordance: scan-and-cast QR (any spare device becomes the
  // screen), one-tap link share, and the typing fallback line — never a raw
  // URL. The line hides itself on file://, where nothing is typeable.
  drawQr($("qrCanvas"), screenLink(location.href, roomCode, "qr"));
  $("tvType").textContent = tvBrowserLine(location.href) || "";
  screenBeat = null;
  updateLobbyReadiness();
  startLobbyTicker();
  if (unsubHeartbeat) unsubHeartbeat();
  unsubHeartbeat = subscribeHeartbeat(roomCode, onHeartbeat);
}

/* S7: every heartbeat callback folds into the liveness state (skew-proof —
 * see couchscreen.js), then refreshes whichever surface the answer drives:
 * the lobby note, the reveal's phone-as-screen map, the game-over crown. */
function onHeartbeat(ts) {
  screenBeat = foldHeartbeat(screenBeat, ts, Date.now());
  if (room && room.phase === "lobby") updateLobbyReadiness();
  updateRevealSurface();
  updateCrown();
}

function updateLobbyReadiness() {
  const note = $("waitingNote");
  // S7: Start Round is NEVER gated on a screen — with no TV, this phone
  // shows the reveal itself. The note just says which mode the couch is in.
  const r = lobbyReadiness(screenLive(screenBeat, Date.now()), connected);
  note.textContent = r.note;
  note.classList.toggle("ok", r.ok);
  $("btnStartRound").disabled = !r.canStart;
}

// Liveness can only decay silently (a dead TV sends no callback), so the
// lobby note re-checks itself on a slow tick while the lobby is up.
let lobbyTicker = null;
function startLobbyTicker() {
  stopLobbyTicker();
  lobbyTicker = setInterval(() => {
    if (room && room.phase === "lobby") updateLobbyReadiness();
    else stopLobbyTicker();
  }, 5000);
}
function stopLobbyTicker() {
  if (lobbyTicker) { clearInterval(lobbyTicker); lobbyTicker = null; }
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
  stopLobbyTicker();
  destroyHostRevealMap();
  screenBeat = null;
  if (unsubHeartbeat) { unsubHeartbeat(); unsubHeartbeat = null; }
  try { await deleteRoom(roomCode); } catch (e) { console.warn(scrubErrorMessage(e)); }
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
  iv = createViewer({
    surface: "host",
    container: "hostViewer",
    moveAllowed,
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
  viewer = iv.viewer;
  // Construction failed (no WebGL, SDK blocked): viewer_init is already
  // reported and every moveTo rejects. Every `if (viewer)` guard below then
  // degrades exactly as it does when the viewer is gone.
  if (!viewer) return;
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
  if (iv) {
    iv.destroy();   // flushes the open pano_session, then viewer.remove()
    iv = null;
  }
  viewer = null;
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
      // A viewer read mid-navigation can hand back a NaN center/zoom; a NaN in
      // the patch would make Firebase reject the whole update. Drop the bad
      // pose (next tick catches up) rather than poison the write.
      const pose = sanitizePose({ bearing: pov.bearing, center, zoom });
      if (!pose) return;
      room.round.pose = pose;
      push({ "round/pose": pose });
    } catch { /* viewer mid-navigation; next tick catches up */ }
  }, 250);
}

async function startRound(advance) {
  // Captured so a retryable imagery failure can put the room back exactly
  // where it was (nothing is pushed before the entry is confirmed).
  const prevPhase = room.phase;
  if (!setPhase("roundActive")) return;
  stopAdvanceTicker();
  stopLobbyTicker();
  destroyHostRevealMap();
  // "auto" only from the S6 ticker; a click event lands here otherwise.
  const via = advance === "auto" ? "auto"
    : room.round ? "manual" : null; // round 1 follows no reveal
  const number = (room.round ? room.round.number : 0) + 1;
  // G2: the previous round's twist, so a fresh draw never repeats it.
  const prevTwist = room.round && room.round.twist ? room.round.twist.id : null;
  showScreen("h-round");
  if (!iv) makeViewer();
  iv.beginRound(number);

  // Sample the pool, skipping dead imagery silently (spec §9). The loop is
  // unchanged — it just lives in viewer-ui.js now, where each skip is timed,
  // classified and (once per pool entry) reported.
  const { entry, skips, degraded } = await loadRoundImage(sampler, iv, "anchor");
  if (!entry) {
    if (degraded) {
      // Retryable imagery failure (stub viewer / transient timeout), NOT pool
      // exhaustion: nothing was pushed, so put the room back where it was and
      // let the host retry. Never finishGame here (review P2-1) — that would
      // save a fabricated 0-score game to the leaderboard.
      room.phase = prevPhase;
      // A stub viewer is dropped so the retry rebuilds it (the SDK may load
      // late); a transient timeout keeps its working viewer.
      if (iv && iv.ok === false) destroyViewer();
      showImageryDegraded(() => startRound(advance));
      return;
    }
    toast("Location pool exhausted!", { surface: "host" });
    room.phase = "reveal"; // allow reveal -> gameOver transition
    finishGame();
    return;
  }
  noticeDegradedImagery(skips);
  currentTruth = entry;
  sampler.advance();

  const now = Date.now();
  const showdown = isShowdownRound(room.teams, room.settings, number);
  // G2: draw this round's twist — deterministic in (roomCode, roundNumber),
  // NEVER from standings (no scripted comebacks). Written into the round record
  // so every device reads it and no one redraws. Long Haul rides the tested
  // gentler curve on the normal location supply here; its dedicated expert-tier
  // sampler (§3.2 lhCursor) is a documented follow-up.
  const twistId = drawTwist({
    roomCode, roundNumber: number, roundCount: room.settings.roundCount,
    mode: "couch", moveAllowed: room.settings.moveAllowed,
    difficulty: room.settings.difficulty, twists: room.settings.twists,
    prevTwistId: prevTwist, isShowdown: showdown,
    numTeams: teamIds(room.teams).length,
    poolScored: true, longHaulExhausted: false,
  });
  const secs = twistRoundSeconds(room.settings, twistId);
  room.round = {
    number,
    imageId: entry.image_id,
    startedAt: now,
    // Speed clock anchor: equals startedAt for solo rounds; showdown
    // handoffs reset it so each team's time bonus reflects its own turn.
    turnStartedAt: now,
    endsAt: secs > 0 ? now + secs * 1000 : null,
    // #4: an explicit, neutral round-start pose (not just a bearing) — the TV
    // resets to a defined center/zoom for the new round instead of holding the
    // previous round's framing until the host's first live pose write lands.
    pose: { bearing: 0, center: [0.5, 0.5], zoom: 0 },
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
    twist: twistId ? { id: twistId } : null,   // G2
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
    // S7: splits couch game_created → round_started conversion by TV
    // presence — the KPI behind removing the screen gate.
    screen_attached: screenLive(screenBeat, Date.now()),
    ...(via ? { advance: via } : {}),
    ...(twistId ? { twist: twistId } : {}),   // G2
  });

  // G2 Frozen: disable street movement for the round via the viewer lever.
  if (iv && iv.setMoveAllowed) {
    iv.setMoveAllowed(twistMoveAllowed(room.settings, twistId));
  }
  $("hudRound").textContent = `Round ${number}/${room.settings.roundCount}` +
    (twistId ? ` · ${twistHudTag(twistId)}` : "");
  $("hudTeam").textContent = roundTeamLabel();
  // First-time education (M5): the showdown gets its one-rule interstitial;
  // an ordinary first pano teaches the loop's first move. One shot each.
  if (showdown) {
    oneShotHint("showdown", HINT_CARDS.showdown);
  } else {
    // #7: teach the arrows when this round allows movement.
    oneShotHint("pano", panoHintCard(twistMoveAllowed(room.settings, twistId)));
  }
  if (twistId) showTwistCard(twistId);   // G2 ritual interstitial
  startTimer();
}

// G2: the twist card flip — a center overlay + scrim (the ritual-interstitial
// class), auto-dismissing in ~2.5s, tap to skip. Reduced-motion collapses to a
// static appear via the CSS reset. Injected (no HTML id), carries no team name.
let twistCardEl = null;
let twistCardTimer = null;
function showTwistCard(twistId) {
  const card = twistCard(twistId);
  if (!card) return;
  playSound("sting");
  if (!twistCardEl) {
    twistCardEl = document.createElement("div");
    twistCardEl.className = "twist-card-overlay";
    twistCardEl.addEventListener("click", hideTwistCard);
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
  twistCardTimer = setTimeout(hideTwistCard, 2500);
}
function hideTwistCard() {
  if (twistCardEl) twistCardEl.classList.add("hidden");
  clearTimeout(twistCardTimer);
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
      guessMarker.on("move", updateLockButton);
    }
    scheduleLiveGuessWrite();
    $("btnConfirmGuess").disabled = false;
    updateGuessHint();
    updateLockButton();
  });
}

// M3: the live "if you locked in now" pill. The host phone already holds
// the truth (currentTruth), so pricing the aimed pin is free and local.
// The round timer stops when the map opens, so the pill runs its own
// half-second ticker while the guessing phase lasts (the speed bonus keeps
// decaying on the confirm clock).
let lockNowTimer = null;
// Review §6.1: the estimate rides on the primary button instead of a
// floating pill stacked above a second floating pill. Same arithmetic,
// same local pricing — one element instead of three.
function updateLockButton() {
  const btn = $("btnConfirmGuess");
  btn.classList.toggle("armed", superSureArmed);
  if (!room || room.phase !== "guessing" || !room.round ||
      !guessMarker || !currentTruth) {
    paintLockButton(btn, lockButtonLabel(LOCK_LABELS.couch, null, superSureArmed));
    return;
  }
  const g = guessMarker.getLatLng();
  const km = haversineKm(currentTruth.lat, currentTruth.lng,
    g.lat, L.Util.wrapNum(g.lng, [-180, 180], true));
  const elapsed = Math.max(0, Date.now() -
    (room.round.turnStartedAt || room.round.startedAt || Date.now()));
  // C5: price the estimate through the SAME twist-aware scorer the confirm uses
  // (blitz ×1.5 on the total + its 20s window, Long Haul's gentler curve), so
  // the "if you locked in now" number matches what actually banks. twistId null
  // ⇒ twistedRoundScore reproduces lockNowEstimate exactly.
  const twistId = room.round.twist ? room.round.twist.id : null;
  const est = twistId
    ? twistedRoundScore(twistId, km, elapsed, room.settings)
    : lockNowEstimate(km, elapsed, room.settings.roundSeconds);
  paintLockButton(btn, lockButtonLabel(LOCK_LABELS.couch, est, superSureArmed));
}

function startLockNowTicker() {
  stopLockNowTicker();
  lockNowTimer = setInterval(updateLockButton, 500);
  updateLockButton();
}

function stopLockNowTicker() {
  if (lockNowTimer) { clearInterval(lockNowTimer); lockNowTimer = null; }
}

// The static "drop your pin" hint doubles as the whose-turn banner: solo
// rounds name the active team; showdown turns count down the pass-around.
function updateGuessHint() {
  const el = document.querySelector("#h-guess .guess-hint");
  if (!room || teamIds(room.teams).length <= 1) {
    // §6.1: with nothing but the instruction to convey, the banner leaves
    // as soon as the pin exists — a draggable pin teaches itself. In a
    // multi-team game the same banner is the whose-turn line, which stays.
    el.textContent = "Tap the map to drop your pin";
    el.classList.toggle("hidden", !!guessMarker);
    return;
  }
  el.classList.remove("hidden");
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
  renderSuperSureChip();
  // First guess map ever on this device: the scoring one-liner and the
  // SUPER SURE stakes, at the moment they matter (M5 + M3).
  oneShotHint("guessmap", {
    title: "Drop your pin",
    lines: guessMapHintLines("couch"),
  });
  startLockNowTicker();
  // Leaflet needs a size pass after the container becomes visible.
  setTimeout(() => guessMap.invalidateSize(), 50);
}

/* ---------------- SUPER SURE: the active team's once-per-game bet ------ */

// Couch version of the h2h toggle: it belongs to whichever team holds the
// phone (the active team), and the TV never mirrors it — the bet stays
// hidden from the couch until the reveal.
/* De-cluttered per §2.6/§6.1, exactly as on the h2h phone: a 🔥 chip in
 * the action bar that opens the ONE sheet explaining the bet, absent once
 * the bet is spent, with the armed state shown on the primary button's own
 * label. The arm/disarm toasts are gone — mechanic rules never live in a
 * 2.5 s toast. The TV still never mirrors any of it: the bet stays hidden
 * from the couch until the reveal. */
function openSuperSureSheet() {
  if (!room || !superSureAvailable(room.teams, room.activeTeam)) return;
  track("super_sure_sheet_opened", { mode: "couch" });
  showHintCard({
    title: SUPER_SURE_SHEET.title,
    lines: SUPER_SURE_SHEET.lines,
    actions: superSureArmed
      ? [{ label: "Disarm", primary: false, onClick: () => setSuperSure(false) },
         { label: "Keep it armed", onClick: () => setSuperSure(true) }]
      : [{ label: SUPER_SURE_SHEET.cancelLabel, primary: false },
         { label: SUPER_SURE_SHEET.armLabel, onClick: () => setSuperSure(true) }],
  });
}

function setSuperSure(armed) {
  if (!room || !superSureAvailable(room.teams, room.activeTeam)) return;
  superSureArmed = !!armed;
  renderSuperSureChip();
  updateLockButton();
}

function renderSuperSureChip() {
  const btn = $("btnSuperSure");
  const available = !!room && superSureAvailable(room.teams, room.activeTeam);
  btn.classList.toggle("hidden", !available); // spent = gone, not disabled
  btn.classList.toggle("armed", available && superSureArmed);
  btn.setAttribute("aria-pressed", String(available && superSureArmed));
  // #7: one-shot nudge toward the 🔥 chip, only on the couch guess map, from
  // round 2 on while unspent — points at the chip, never re-explains it.
  if (!$("h-guess").classList.contains("hidden") && room && room.round &&
      shouldHintSuperSure({
        mode: "couch", roundNumber: room.round.number, available,
      })) {
    oneShotHint(SUPER_SURE_HINT_ID, SUPER_SURE_HINT);
  }
}

function confirmGuess() {
  if (!guessMarker || !currentTruth) return;
  const g = guessMarker.getLatLng();
  const guess = { lat: g.lat, lng: L.Util.wrapNum(g.lng, [-180, 180], true) };
  const distanceKm = haversineKm(currentTruth.lat, currentTruth.lng, guess.lat, guess.lng);
  // Speed clock: round start (or this team's showdown turn start) to this
  // confirm tap. turnStartedAt may be absent on rounds started pre-update.
  const submittedAt = Date.now();
  const elapsedMs = Math.max(
    0, submittedAt - (room.round.turnStartedAt || room.round.startedAt));
  // G2: one scorer for twisted and plain rounds (blitz ×1.5 on the total,
  // Long Haul's gentler curve, 20s blitz window) — twistId null ⇒ plain.
  const twistId = room.round && room.round.twist ? room.round.twist.id : null;
  const ts = twistedRoundScore(twistId, distanceKm, elapsedMs, room.settings);
  const distancePoints = ts.distancePoints;
  const speedBonus = ts.timeBonus;
  const points = ts.points;
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
    // Couch: round/imageId follows the host's movement, so drifting off
    // the pool entry's anchor image means the pano was navigated.
    moved: panoMoved(currentTruth.image_id, room.round.imageId),
    // G2/G7 (R4): the round number and its twist join couch guesses to the
    // room+round, exactly like h2h — so distance/time-by-twist and the
    // decoy-round rival-behavior analyses cover couch too. twist is omitted on
    // a plain round ("absent = none"); couch has no decoy surface, so no flag.
    round_number: room.round.number,
    ...(twistId ? { twist: twistId } : {}),
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
    twistTag: twistRevealTag(twistId),   // G2: shown on the reveal result line
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
    renderSuperSureChip();
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
  updateRevealSurface(); // S7: a TV going stale mid-reveal hands over here
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

/* S7 couch without a TV: with no live screen the host phone IS the shared
 * display — the reveal grows the all-pins map the TV would have shown
 * (guess→truth lines, team colors, SUPER SURE halos, the answer marker).
 * Re-checked on every heartbeat callback and advance tick, so a TV that
 * attaches mid-reveal takes the beat back (its renderer runs off the same
 * state) and one that went stale hands it to the phone. */
let hostRevealMap = null;
let hostRevealMapFor = null; // "<room>:<round>" the map was built for

function destroyHostRevealMap() {
  if (hostRevealMap) {
    try { hostRevealMap.remove(); } catch { /* already gone */ }
    hostRevealMap = null;
  }
  hostRevealMapFor = null;
  $("hostRevealMap").classList.add("hidden");
}

function updateRevealSurface() {
  if (!room || room.phase !== "reveal" || !room.round) return;
  if (phoneIsScreen(screenBeat, Date.now())) renderHostRevealMap();
  else destroyHostRevealMap();
}

function renderHostRevealMap() {
  const round = room.round;
  if (!round.truth) return;
  const key = `${roomCode}:${round.number}`;
  if (hostRevealMapFor === key) return; // built already this reveal
  destroyHostRevealMap();
  hostRevealMapFor = key;
  $("hostRevealMap").classList.remove("hidden");
  hostRevealMap = L.map("hostRevealMap", {
    zoomControl: false, dragging: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false,
  });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(hostRevealMap);
  const truth = L.latLng(round.truth.lat, round.truth.lng);
  const pins = couchRevealPins(round, room.activeTeam);
  hostRevealMap.fitBounds(
    L.latLngBounds([truth, ...pins.map((p) => L.latLng(p.lat, p.lng))])
      .pad(0.25),
    { maxZoom: 10 }
  );
  for (const p of pins) {
    const guess = L.latLng(p.lat, p.lng);
    const color = teamHex(room.teams, p.id);
    L.polyline([guess, truth], { color, weight: 3, dashArray: "6 8" })
      .addTo(hostRevealMap);
    L.circleMarker(guess, {
      radius: 8, color: "#fff", weight: 2, fillColor: color, fillOpacity: 1,
    }).addTo(hostRevealMap)
      .bindTooltip(escapeHtml(room.teams[p.id].name), { direction: "top" });
    if (p.superSure) {
      // The bet steps out of hiding: verdict halo on the pin (reveal-only).
      L.circleMarker(guess, {
        radius: 14, color: "#ffcf3f", weight: 3, fill: false,
        dashArray: "4 6", interactive: false,
      }).addTo(hostRevealMap)
        .bindTooltip(
          p.superSureOutcome === "won" ? "SUPER SURE ×2" : "SUPER SURE — 0",
          { permanent: true, direction: "bottom", className: "ss-tooltip" });
    }
  }
  L.circleMarker(truth, {
    radius: 10, color: "#111", weight: 3, fillColor: "#ffcf3f", fillOpacity: 1,
  }).addTo(hostRevealMap)
    .bindTooltip("Answer", { permanent: true, direction: "top" });
  setTimeout(
    () => hostRevealMap && hostRevealMap.invalidateSize({ pan: false }), 60);
}

let revealTracked = null; // "<room>:<round>" — resume re-enters the reveal
function enterReveal() {
  stopLockNowTicker();
  showScreen("h-reveal");
  updateRevealSurface(); // S7: the map grows when this phone is the screen
  // One hint per moment: the first phone-as-screen reveal teaches the
  // hold-it-up move; otherwise the first reveal ever labels the breakdown
  // once (M5) — the injected speed line below carries the numbers.
  if (!hostRevealMap || !oneShotHint("phonescreen", HINT_CARDS.phonescreen)) {
    oneShotHint("reveal", HINT_CARDS.reveal);
  }
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

  /* §6.4, shared with the h2h phone: the three stat cards and their two
   * injected sub-lines collapse into ONE result line, and the totals list
   * becomes ONE board carrying each team's round delta next to its running
   * total. Solo rounds price the active team's pin; the showdown keeps its
   * closest-first per-team list (every team guessed the same spot, so the
   * per-team detail is the content) and the board carries the standings. */
  const resultEl = $("revealResult");
  let list = $("hostShowdownResults");
  if (showdown) {
    resultEl.textContent = "";
    resultEl.classList.add("hidden");
    if (!list) {
      list = document.createElement("ul");
      list.id = "hostShowdownResults";
      list.className = "totals-list showdown-results";
      list.dataset.phMask = "";   // team names — replay masking (plan §9.4)
      resultEl.after(list);
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
    resultEl.classList.remove("hidden");
    // Pass the round's guess so the full personal line renders (and carries the
    // G2 twist tag on `score.twistTag`).
    resultEl.textContent = revealResultLine(
      score ? { ...score, guess: score.guess || room.round.guess } : score);
    resultEl.classList.toggle(
      "lost", !!(score && score.superSure && score.superSureOutcome !== "won"));
  }

  // The merged board: this round's delta → the running total, per team.
  const results = showdown
    ? (room.round.results || {})
    : (room.round.score ? { [room.activeTeam]: room.round.score } : {});
  const board = $("revealBoard");
  board.innerHTML = "";
  for (const row of revealBoardRows(room.teams, results)) {
    const li = document.createElement("li");
    if (row.crown) li.classList.add("active");
    const name = document.createElement("span");
    name.textContent = (row.crown ? "👑 " : "") + row.name;
    const val = document.createElement("span");
    val.textContent = boardRowText(row);
    li.append(name, val);
    board.appendChild(li);
  }

  $("btnNextRound").textContent =
    number >= room.settings.roundCount ? "Finish" : "Next round";
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

// S7: with no TV podium, the host phone crowns the winner itself. A screen
// attaching at game over (its confetti podium renders) hides it again via
// onHeartbeat. Single-team co-op games have no rivalry to crown (null).
function updateCrown() {
  if (!room || room.phase !== "gameOver") return;
  const line = phoneIsScreen(screenBeat, Date.now())
    ? crownLine(room.teams)
    : null;
  const el = $("hostCrown");
  el.textContent = line || "";
  el.classList.toggle("hidden", !line);
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
  // G3 Crown Night: the winner takes this game's crown. Ties break on the
  // deterministic seeded flip so the crown always has one owner (the podium
  // still shows the true tie). `night` is display-only here; the authoritative
  // carry into the next game is threaded via nightToCarry. gameNight() resolves
  // the bump + carry in one pure call so a host refresh recomputes the SAME
  // crown (R2 — refresh-safety; see the gameOver resume path).
  const ng = gameNight(room.night || defaultNight(), room.teams, roomCode);
  const bumped = ng.bumped;
  nightToCarry = ng.carry;
  if (ng.champ) {
    track("night_champion", { mode: "couch", games: bumped.games });
  }
  destroyViewer();
  destroyHostRevealMap();
  showScreen("h-gameover");
  // "Your Color Takes the Room" (P1.5): the couch host phone runs the party
  // rather than competing, so it has no "did I win" — it celebrates on
  // behalf of whichever team the standings crown, mirroring the player/daily
  // call sites (fx.js#celebrationSpec) one surface later than they shipped.
  const isChampion = !!champion(bumped);
  const plan = celebrationSpec({
    won: true,
    champion: isChampion,
    teamColor: teamHex(room.teams, winner.id),
    seed: `${roomCode}:${bumped.games}`,
    surface: "host",
  });
  const gameOverEl = $("h-gameover");
  gameOverEl.style.setProperty("--win", plan.winVar);
  gameOverEl.classList.add("is-win");
  gameOverEl.classList.toggle("is-champion", isChampion);
  $("hGameOverTitle").classList.add("win-headline");
  playSound(plan.sound); // S4
  spawnConfetti($("hConfetti"), {
    seed: plan.seed, tier: plan.tier, accentColor: plan.accentColor,
    spread: plan.spread, count: plan.count,
  });
  updateCrown(); // S7: no TV podium — this phone crowns the winner
  renderTotals($("finalTotals"));
  renderNightTally(bumped);
  // §2.9: it is localStorage — there is no reason to make a human press a
  // database button. The game saves itself and says so in one quiet line,
  // and the setup screen's "Past games" disclosure is where it resurfaces.
  saveToLeaderboard();
}

// G3: the night tally + champion ceremony on the couch game-over screen (and
// the "Game N?" hook on the next-game button). Team names ride these nodes, so
// #hNightTally / #hChampion carry data-ph-mask in host.html.
function renderNightTally(night) {
  const tallyEl = $("hNightTally");
  const champEl = $("hChampion");
  const champId = champion(night);
  if (champId) {
    const name = (room.teams[champId] && room.teams[champId].name) || champId;
    champEl.textContent = championText(name);
    champEl.classList.remove("hidden");
    tallyEl.classList.add("hidden");
    // No fanfare here: finishGame() already plays the single game-over fanfare
    // (C5 — a champion game must not double up), and the resume path renders the
    // tally silently on a refresh.
  } else {
    champEl.classList.add("hidden");
    const line = tallyLineText(night, room.teams);
    tallyEl.textContent = line;
    tallyEl.classList.toggle("hidden", !line);
  }
  const hook = $("hNightHook");
  if (hook && nightSummary(night, room.teams).length) {
    hook.textContent = crownHookText(night, room.teams, night.games + 1);
    hook.classList.remove("hidden");
  } else if (hook) {
    hook.classList.add("hidden");
  }
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

/* Auto-save at game over (§2.9). Idempotency is keyed on the room code
 * stored alongside each entry rather than an in-memory flag, so a refresh
 * that resumes straight back into gameOver re-renders the note without
 * writing the standings a second time. */
function saveToLeaderboard() {
  const board = lsGet(LS_LEADERBOARD, []);
  if (!board.some((e) => e && e.room === roomCode)) {
    const date = new Date().toISOString().slice(0, 10);
    for (const t of standings(room.teams)) {
      board.push({
        room: roomCode,
        teamName: t.name,
        totalScore: t.total,
        rounds: room.settings.roundCount,
        date,
      });
    }
    lsSet(LS_LEADERBOARD, board);
  }
  $("hSavedNote").textContent = "Saved to your past games ✓";
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
  // Legacy rooms (created before the difficulty setting) carry none and get
  // the legacy order back; passing undefined through keeps them intact.
  sampler = new PoolSampler(pool, roomCode, room.poolCursor || 0,
    room.settings.difficulty || null);
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
      // C5: a resume rebuilds the viewer from the game-wide moveAllowed, so a
      // Frozen round would silently re-enable street movement. Re-apply the
      // round's twist lever after the viewer exists (makeViewer's guard was a
      // no-op while iv was null at round start).
      if (iv && iv.setMoveAllowed) {
        const twistId = room.round.twist ? room.round.twist.id : null;
        iv.setMoveAllowed(twistMoveAllowed(room.settings, twistId));
      }
      iv.beginRound(room.round.number);
      try { await iv.moveTo(room.round.imageId, "resume"); }
      catch (e) {
        // Raw SDK rejections carry the image id / a tokened URL, and console
        // capture rides into replays — log only the scrubbed message (P1-1).
        console.warn("resume: image failed to load —", scrubErrorMessage(e));
        toast("Imagery didn’t load — guess from the map.",
          { surface: "host" });
      }
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
      renderSuperSureChip(); // armed state is local; a refresh disarms
      startLockNowTicker();
      setTimeout(() => guessMap.invalidateSize(), 50);
      break;
    case "reveal":
      enterReveal();
      break;
    case "gameOver": {
      showScreen("h-gameover");
      updateCrown(); // S7 — re-checked when the first heartbeat lands
      renderTotals($("finalTotals"));
      // R2: a host refresh between games must not lose the night. RTDB holds
      // only the pre-bump seeded night (finishGame writes no tally), so
      // recompute this game's crown deterministically with gameNight() — the
      // same pure call finishGame used, so the tally + champion render exactly
      // as before the reload. Re-thread the carry (nightToCarry) and mark the
      // chain (prevRoomCode) so tapping "New game" still carries the tally.
      const ng = gameNight(room.night || defaultNight(), room.teams, roomCode);
      nightToCarry = ng.carry;
      prevRoomCode = roomCode;
      renderNightTally(ng.bumped);
      saveToLeaderboard(); // idempotent per room (§2.9)
      break;
    }
    default:
      enterSetup();
  }
  if (room.phase !== "lobby") {
    if (unsubHeartbeat) unsubHeartbeat();
    screenBeat = null;
    unsubHeartbeat = subscribeHeartbeat(roomCode, onHeartbeat);
  }
}

/* ================================================================
 * Boot
 * ================================================================ */

wireSeg("segRounds");
wireSeg("segSeconds");
wireSeg("segMove");
wireSeg("segDifficulty");
wireSeg("segTwists");
wireSeg("segTeams", (v) => renderTeamNameInputs(parseInt(v, 10)));

$("btnNewGame").addEventListener("click", newGame);
$("btnStartRound").addEventListener("click", startRound);
$("btnAbandon").addEventListener("click", abandonGame);
$("btnTvLink").addEventListener("click", () => {
  if (!roomCode) return;
  shareTvLink(screenLink(location.href, roomCode, "link"), roomCode, "couch", toast);
});
$("btnMakeGuess").addEventListener("click", openGuessMap);
$("btnSuperSure").addEventListener("click", openSuperSureSheet);
$("btnConfirmGuess").addEventListener("click", confirmGuess);
$("btnNextRound").addEventListener("click", nextOrFinish);
$("btnHoldAdvance").addEventListener("click", holdAdvance);
$("btnShareResult").addEventListener("click", shareGameResult);
$("btnNewGameOver").addEventListener("click", newGameFromOver);
// §6: the game-over "How to play" link.
$("hHowto").addEventListener("click", () =>
  track("howto_opened", { source: "gameover" }));

onConnectionChange((isConnected) => {
  connected = isConnected;
  $("connPill").classList.toggle("hidden", isConnected);
  if (room && room.phase === "lobby") updateLobbyReadiness();
});

// #5: an orientation change (or the pano coming back on screen) can leave the
// host pano sized to its old box and its nav components dropped. Re-size the
// viewer and re-assert the movement lever whenever the round screen is up.
function refreshHostViewer() {
  if (!iv || $("h-round").classList.contains("hidden")) return;
  iv.resize();
  if (iv.reassertMove) iv.reassertMove();
}
if (typeof window !== "undefined") {
  window.addEventListener("orientationchange", refreshHostViewer);
  window.addEventListener("resize", refreshHostViewer);
}

initSound("host"); // S4: muted by default on phones; 🔇 toggle persists
enterSetup();
janitor();
checkResume();
