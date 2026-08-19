// daily-ui.js — the Daily Challenge page (roadmap S2): a solo, date-seeded
// run of five locations — the SAME five for everyone on a given day, so
// scores are comparable and the S1 share card ("Beat me") means something.
// No Firebase, no room, no teams: this page talks only to Mapillary, OSM
// tiles, and localStorage. Every decision (seed, day number, scoring, run
// fold, replay lock) lives in daily.js / share.js (pure, tested); this
// module is DOM glue in the player-ui mold.

import { MAPILLARY_TOKEN } from "../config.js";
import {
  haversineKm,
  formatDistance,
  formatSeconds,
  formatCountdown,
} from "./game.js";
import {
  DAILY_ROUNDS,
  DAILY_ROUND_SECONDS,
  dailyKey,
  dailySeed,
  dailyNumber,
  newDailyRun,
  recordDailyRound,
  dailyRunComplete,
  guessedRounds,
  bestDailyDistance,
  loadDailyResult,
  saveDailyResult,
} from "./daily.js";
import { withUtm, dailyShareText, emojiRow } from "./share.js";
import { shareResult } from "./share-ui.js";
import {
  HINT_CARDS,
  guessMapHintLines,
  lockNowEstimate,
  lockNowLabel,
} from "./hints.js";
import { oneShotHint, dismissHintCard } from "./hints-ui.js";
import { loadPool, PoolSampler } from "./pool.js";
import { track } from "./consent.js";

/* ================================================================
 * DOM helpers (same shape as the other pages)
 * ================================================================ */

const $ = (id) => document.getElementById(id);
const SCREENS = ["d-intro", "d-round", "d-guess", "d-reveal", "d-done"];

let shownScreen = null;
function showScreen(id) {
  shownScreen = id;
  dismissHintCard();
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
 * Session state — one run, no peers
 * ================================================================ */

const todayKey = dailyKey(new Date());
const dayNum = dailyNumber(todayKey);

let sampler = null;        // seeded from the date — same order for everyone
let run = newDailyRun(todayKey);
let current = null;        // pool entry backing the active round
let roundStartedAt = 0;
let endsAt = 0;
let locked = false;
let stage = "explore";     // "explore" (pano) | "map"

let viewer = null;
let guessMap = null;
let guessMarker = null;
let revealMap = null;
let tickInterval = null;

/* ================================================================
 * Start
 * ================================================================ */

async function startChallenge() {
  $("btnDailyStart").disabled = true;
  $("dIntroErr").textContent = "";
  try {
    const pool = await loadPool();
    // PoolSampler's seed parameter is any string; the date seed makes the
    // shuffled order a property of the DAY, not of a room or a device.
    sampler = new PoolSampler(pool, dailySeed(todayKey));
    track("daily_challenge_started", { day_number: dayNum });
    await startRound();
  } catch (e) {
    console.error(e);
    $("dIntroErr").textContent = "Couldn't load today's places — try again.";
    $("btnDailyStart").disabled = false;
  }
}

/* ================================================================
 * Rounds
 * ================================================================ */

async function startRound() {
  locked = false;
  stage = "explore";
  if (guessMarker) { guessMarker.remove(); guessMarker = null; }
  if (guessMap) guessMap.setView([25, 10], 2);
  destroyRevealMap();
  showScreen("d-round");
  oneShotHint("pano", HINT_CARDS.pano);
  if (!viewer) makeViewer();
  // Same dead-image skip as the party hosts: everyone shares the seeded
  // order, so everyone skips the same dead entries to the same five spots.
  let entry = sampler.peek();
  let loadedOk = false;
  while (entry && !loadedOk) {
    try {
      await viewer.moveTo(entry.image_id);
      loadedOk = true;
    } catch (e) {
      console.warn(`daily: pool image ${entry.image_id} failed, skipping`, e);
      entry = sampler.advance();
    }
  }
  if (!entry) { finishRun(); return; } // pool exhausted — score what we have
  sampler.advance();
  current = entry;
  roundStartedAt = Date.now();
  endsAt = roundStartedAt + DAILY_ROUND_SECONDS * 1000;
  $("dHudRound").textContent = `Round ${run.rounds.length + 1}/${DAILY_ROUNDS}`;
  startTick();
}

// Full navigation, matching regular play with moveAllowed on: everyone
// gets the same rules (look around AND move down the street), so scores
// stay comparable — movement is part of the fixed ruleset, like scoring.
function makeViewer() {
  viewer = new mapillary.Viewer({
    accessToken: MAPILLARY_TOKEN,
    container: "dailyViewer",
    component: {
      cover: false,
      direction: true,
      sequence: true,
      keyboard: true,
      zoom: true,
      bearing: true,
    },
  });
}

function destroyViewer() {
  if (viewer) {
    try { viewer.remove(); } catch { /* already gone */ }
    viewer = null;
  }
}

/* ---------------- Guess map ---------------- */

function ensureGuessMap() {
  if (guessMap) return;
  guessMap = L.map("dailyGuessMap", { worldCopyJump: true, zoomControl: false })
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
      guessMarker.on("move", updateLockNowHint);
    }
    $("btnDLockIn").disabled = false;
    $("dGuessHint").textContent = "Drag to adjust, then lock it in";
    updateLockNowHint();
  });
}

function openGuessMap() {
  if (locked) return;
  stage = "map";
  showScreen("d-guess");
  ensureGuessMap();
  $("btnDLockIn").disabled = !guessMarker;
  $("dGuessHint").textContent = guessMarker
    ? "Drag to adjust, then lock it in"
    : "Tap the map to drop your pin";
  // First guess map ever on this device: the scoring one-liner (M5) — the
  // daily is solo, so no rival-pins or SUPER SURE lines.
  oneShotHint("guessmap", {
    title: "Drop your pin",
    lines: guessMapHintLines("daily", false),
  });
  updateLockNowHint();
  setTimeout(() => guessMap.invalidateSize(), 50);
}

function backToStreet() {
  if (locked) return;
  stage = "explore";
  showScreen("d-round");
  if (viewer) viewer.resize();
}

// M3's "if you locked in now" pill — same pure estimator as the party
// phones, priced locally against the current entry's coordinates.
function updateLockNowHint() {
  const el = $("dLockNowHint");
  if (locked || stage !== "map" || !guessMarker || !current) {
    el.textContent = "";
    return;
  }
  const g = guessMarker.getLatLng();
  const km = haversineKm(
    current.lat, current.lng,
    g.lat, L.Util.wrapNum(g.lng, [-180, 180], true));
  const elapsed = Math.max(0, Date.now() - roundStartedAt);
  el.textContent =
    lockNowLabel(lockNowEstimate(km, elapsed, DAILY_ROUND_SECONDS), false);
}

/* ---------------- Ticker: countdown + auto-lock ---------------- */

function startTick() {
  stopTick();
  tickInterval = setInterval(tick, 250);
  tick();
}

function stopTick() {
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
}

function tick() {
  if (locked) return;
  updateLockNowHint();
  const left = endsAt - Date.now();
  $("dHudTimer").textContent = formatCountdown(left);
  $("dGuessTimer").textContent = formatCountdown(left);
  if (left <= 0) lockIn(true); // pin if placed, forfeit if not
}

/* ---------------- Lock in -> reveal ---------------- */

function lockIn(auto = false) {
  if (locked || !current) return;
  let guess = null;
  if (guessMarker) {
    const g = guessMarker.getLatLng();
    guess = { lat: g.lat, lng: L.Util.wrapNum(g.lng, [-180, 180], true) };
  }
  if (!guess && !auto) return; // manual lock needs a pin; timeout may forfeit
  locked = true;
  stopTick();
  const elapsedMs = Math.max(0, Date.now() - roundStartedAt);
  const distanceKm = guess
    ? haversineKm(current.lat, current.lng, guess.lat, guess.lng)
    : null;
  run = recordDailyRound(run, guess ? { distanceKm, elapsedMs } : null);
  if (auto) {
    toast(guess
      ? "Time! Your pin was locked in."
      : "Time! No pin — no points this round.");
  }
  renderReveal(guess, elapsedMs);
}

function renderReveal(guess, elapsedMs) {
  showScreen("d-reveal");
  oneShotHint("reveal", HINT_CARDS.reveal);
  const r = run.rounds[run.rounds.length - 1];
  $("dRevealHeading").textContent =
    `Round ${run.rounds.length} of ${DAILY_ROUNDS}`;
  $("dRevealPlace").textContent = current.name || "—";
  $("dRevealDistance").textContent =
    r.distanceKm != null ? formatDistance(r.distanceKm) : "no pin";
  $("dRevealPoints").textContent = `+${r.points.toLocaleString()}`;
  $("dRevealSpeed").textContent = r.distanceKm != null
    ? `${r.distancePoints.toLocaleString()} distance` +
      ` + ⚡${r.timeBonus.toLocaleString()} speed` +
      ` · answered in ${formatSeconds(elapsedMs)}`
    : "";
  $("dRevealTotal").textContent = run.score.toLocaleString();
  $("btnDNext").textContent =
    dailyRunComplete(run) ? "See My Score" : "Next Round";
  renderRevealMap(guess);
}

function renderRevealMap(guess) {
  destroyRevealMap();
  revealMap = L.map("dRevealMap", {
    zoomControl: false, dragging: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false,
  });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(revealMap);
  const truth = L.latLng(current.lat, current.lng);
  if (guess) {
    const pin = L.latLng(guess.lat, guess.lng);
    revealMap.fitBounds(L.latLngBounds([truth, pin]).pad(0.25), { maxZoom: 10 });
    L.polyline([pin, truth], { color: "#4dd6ff", weight: 3, dashArray: "6 8" })
      .addTo(revealMap);
    L.circleMarker(pin, {
      radius: 8, color: "#fff", weight: 2, fillColor: "#4dd6ff", fillOpacity: 1,
    }).addTo(revealMap);
  } else {
    revealMap.setView(truth, 4);
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
}

function nextOrFinish() {
  if (dailyRunComplete(run)) { finishRun(); return; }
  startRound();
}

/* ---------------- Done ---------------- */

function finishRun() {
  stopTick();
  destroyViewer();
  saveDailyResult(localStorage, run);
  // best_distance_km is absent for an all-forfeit run (sanitizer drops the
  // null) — rounds_played: 0 already tells that story.
  track("daily_challenge_completed", {
    day_number: dayNum,
    score: run.score,
    rounds_played: guessedRounds(run),
    best_distance_km: bestDailyDistance(run),
  });
  renderDone(run, false);
}

function renderDone(result, alreadyPlayed) {
  showScreen("d-done");
  $("dDoneTitle").textContent = alreadyPlayed
    ? `You played Daily #${dayNum} ✓`
    : `Daily #${dayNum} done!`;
  $("dDoneScore").textContent = result.score.toLocaleString();
  $("dDoneEmoji").textContent = emojiRow(result.rounds);
  if (alreadyPlayed) {
    $("dDoneNote").textContent =
      "One run per day keeps scores honest — a fresh five tomorrow.";
  }
  $("btnDShare").onclick = () =>
    shareResult(
      dailyShareText({
        dayNumber: dayNum,
        score: result.score,
        rounds: result.rounds,
        // The card links straight into the challenge, UTM-tagged so
        // arrivals (and the rooms they go on to create) attribute to it.
        url: withUtm(new URL("daily.html", location.href).href, "daily"),
      }),
      "daily",
      toast
    );
}

/* ================================================================
 * Boot
 * ================================================================ */

$("btnDailyStart").addEventListener("click", startChallenge);
$("btnDOpenMap").addEventListener("click", openGuessMap);
$("btnDBackToStreet").addEventListener("click", backToStreet);
$("btnDLockIn").addEventListener("click", () => lockIn(false));
$("btnDNext").addEventListener("click", nextOrFinish);

$("dDailyNum").textContent = `#${dayNum}`;
$("dDailyDate").textContent = new Date().toLocaleDateString(undefined, {
  weekday: "long", month: "long", day: "numeric",
});

// Replay lock: today's run already exists on this device — show it (with
// the share card ready) instead of a second scored attempt.
const played = loadDailyResult(localStorage, todayKey);
if (played) {
  renderDone(played, true);
} else {
  showScreen("d-intro");
}
