// daily-ui.js — the Daily Challenge page (roadmap S2; G1/G4/G5/G6/G8 expansion,
// spec §3.1/§3.4/§3.5/§3.6/§3.8). A solo, date-seeded run of five locations —
// the SAME five for everyone on a given day. No Firebase, no room, no teams:
// this page talks only to Mapillary, OSM tiles, and localStorage. Every
// decision (seed, day number, scoring, run fold, replay lock, streak/PB fold,
// ghost codec, medal grading) lives in daily.js / share.js / records.js /
// ghost.js (pure, tested); this module is DOM glue in the player-ui mold.
//
// GHOST DUEL PRIVACY (CLAUDE.md): a challenge link's payload is the sender's
// own guesses only. It rides the URL fragment, which we parse then STRIP
// (history.replaceState) at the top of this module — before any analytics init
// can observe the URL (§3.5.6). It never reaches Firebase/PostHog/replay/logs.

import {
  haversineKm,
  formatCountdown,
  formatDistance,
  revealResultLine,
  scoreForDistance,
  timeBonus,
  bonusWindowMs,
} from "./game.js";
import {
  DAILY_ROUNDS,
  dailyKey,
  dailySeed,
  dailyNumber,
  dailyKeyFromNumber,
  dailyRoundSeconds,
  dailyMoveAllowed,
  DAILY_RESULT_KEY,
  DAILY_RESULT_HARD_KEY,
  newDailyRun,
  recordDailyRound,
  dailyRunComplete,
  guessedRounds,
  bestDailyDistance,
  loadDailyResult,
  saveDailyResult,
} from "./daily.js";
import {
  withUtm, dailyShareText, dailyChallengeUrl, emojiRow, distanceEmoji,
} from "./share.js";
import {
  loadRecords, saveRecords, applyDailyResult, applyDuelResult,
  seedBestFromResult, medalForDistance,
} from "./records.js";
import {
  parseGhostFragment, decodeGhost, ghostExpired, poolMatches, poolCheck,
  buildGhostPayload, duelVerdict, ghostScores, runHasPins,
  dailyEntryRoute, duelFoldPlan,
} from "./ghost.js";
import { shareResult } from "./share-ui.js";
import {
  HINT_CARDS,
  claimHint,
  guessMapHintLines,
  lockNowEstimate,
  lockButtonLabel,
  LOCK_LABELS,
  panoHintCard,
} from "./hints.js";
import { oneShotHint, dismissHintCard, paintLockButton } from "./hints-ui.js";
import { countdownTick, celebrationSpec } from "./fx.js";
import {
  initSound, playSound, buzz, stampFlash, prefersReducedMotion, spawnConfetti,
} from "./fx-ui.js";
import { loadPool, PoolSampler } from "./pool.js";
import { scrubErrorMessage, basemapTileLayerConfig } from "./imagery.js";
import { track } from "./consent.js";
import { setActiveScreen } from "./chrome-ui.js";
import { createViewer, loadRoundImage } from "./viewer-ui.js";
import { toastWithReport, toastPlain } from "./report-ui.js";

/* ================================================================
 * Ghost fragment: parse, then STRIP immediately (§3.5.6 braces layer). This
 * runs at module eval, before PostHog is even loaded (consent.js only schedules
 * an async script injection), so no pageview can observe the payload.
 * ================================================================ */

const ghostPayload = (() => {
  try {
    const p = parseGhostFragment(location.hash);
    if (location.hash) {
      // Drop the fragment from the address bar and from history entirely.
      history.replaceState(null, "", location.pathname + location.search);
    }
    return p;
  } catch { return null; }
})();

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
  setActiveScreen(id);
}

let toastTimer = null;
function toast(msg, reportCtx) {
  const el = $("toast");
  if (reportCtx) toastWithReport(el, msg, reportCtx); else toastPlain(el, msg);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => el.classList.remove("show"), reportCtx ? 6000 : 2500);
}

let degradedNoticeShown = false;
function noticeDegradedImagery(skips) {
  if (degradedNoticeShown || skips < 2) return;
  degradedNoticeShown = true;
  toast("Some images wouldn’t load — we skipped ahead.", { surface: "daily" });
}

let degradedEl = null;
function showImageryDegraded() {
  if (!degradedEl) {
    degradedEl = document.createElement("div");
    degradedEl.className = "imagery-degraded";
    const p = document.createElement("p");
    p.textContent =
      "Couldn’t load today’s imagery. Nothing was counted — check your " +
      "connection and try again.";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-primary";
    btn.textContent = "Retry";
    btn.addEventListener("click", () => { hideImageryDegraded(); startRound(); });
    degradedEl.append(p, btn);
    document.body.appendChild(degradedEl);
  }
  degradedEl.classList.remove("hidden");
}
function hideImageryDegraded() {
  if (degradedEl) degradedEl.classList.add("hidden");
}

/* ================================================================
 * Session state — one run, no peers
 * ================================================================ */

const todayKey = dailyKey(new Date());
const todayNum = dailyNumber(todayKey);
const records = loadRecords(localStorage);

// Decode the ghost (if any). decode is total — never throws.
const ghost = ghostPayload ? decodeGhost(ghostPayload) : null;

// The run's mode + day are decided at boot (§3.5.2). A valid, in-window ghost
// routes the run to the LINK's day-seed and ruleset; otherwise it's a plain
// daily for today. duelStatus is resolved after the pool loads (poolCheck).
let mode = "normal";              // "normal" | "hard"
let isDuel = false;               // a live ghost duel this run
let isExhibition = false;         // a duel that must NOT save (day/mode mismatch)
let ghostLinkReason = null;       // set when a link was present but unusable
let runKey = todayKey;
let runDayNum = todayNum;

if (ghost && ghost.ok) {
  if (ghostExpired(ghost.dayNumber, todayNum)) {
    ghostLinkReason = "expired";
  } else {
    isDuel = true;
    mode = ghost.hard ? "hard" : "normal";
    runDayNum = ghost.dayNumber;
    runKey = dailyKeyFromNumber(ghost.dayNumber);
    // A run on a day that isn't the recipient's local today, or a hard duel we
    // won't let overwrite the hard slot, is an exhibition (plays, never saves).
    isExhibition = ghost.dayNumber !== todayNum;
  }
} else if (ghost && ghost.error) {
  ghostLinkReason = ghost.error;   // "malformed" | "version"
}

let sampler = null;
let run = newDailyRun(runKey, mode === "hard");
let current = null;
let roundStartedAt = 0;
let endsAt = 0;
let locked = false;
let stage = "explore";

// Ghost bookkeeping (duel runs). Each entry: { points, distanceKm, pin }.
const ghostRoundResults = [];
let ghostTotalSoFar = 0;
// The day's five image ids in seeded order (for the OUTGOING ghost's poolCheck,
// §3.5.1). Populated lazily from the seeded order (deterministic, skip-free).
let peekIdsCache = null;

let iv = null;
let viewer = null;
let guessMap = null;
let guessMarker = null;
let revealMap = null;
let tickInterval = null;
let lastTickSecond = null;

/* ================================================================
 * Start
 * ================================================================ */

// R1: instantVerdict is async and idempotent, but must run at most once even
// when the boot AND a "Take the challenge" tap that raced its load both route
// to it — a second run would re-render the verdict and re-enter the fold path.
let instantVerdictStarted = false;

// The saved completed run for THIS run's current mode/day, re-read live (mode
// can flip to hard mid-session). The replay lock reads from this.
function savedResultForRun() {
  return loadDailyResult(localStorage, runKey,
    mode === "hard" ? DAILY_RESULT_HARD_KEY : DAILY_RESULT_KEY);
}

// Route a completed board to its no-replay surface: the duel verdict (a valid
// ghost) or the plain done screen. Never starts a fresh round.
function resolveSavedRun(saved) {
  if (isDuel && ghost && ghost.ok) {
    if (instantVerdictStarted) return;
    instantVerdictStarted = true;
    instantVerdict(saved);
  } else {
    renderDone(saved, true, { streakCount: records.streak.count });
  }
}

async function startChallenge() {
  // R1: re-check the replay lock BEFORE anything async. A completed board for
  // this day+mode must never replay — not even when this tap raced the boot's
  // instant-verdict load, during which the intro/"Take the challenge" button
  // was briefly live. Same rule the boot used, so the answer is identical.
  const savedNow = savedResultForRun();
  if (dailyEntryRoute({
    hasSaved: !!savedNow, isExhibition, isDuel, ghostOk: !!(ghost && ghost.ok),
  }) !== "play") {
    resolveSavedRun(savedNow);
    return;
  }
  $("btnDailyStart").disabled = true;
  $("dIntroErr").textContent = "";
  try {
    const pool = await loadPool();
    sampler = new PoolSampler(pool, dailySeed(runKey));
    // Confirm a ghost duel's day still matches (poolCheck) before it counts.
    if (isDuel) {
      const ids = await peekDayIds(runKey);
      if (!poolMatches(ghost.poolCheck, ids)) {
        isDuel = false;
        isExhibition = false;
        ghostLinkReason = "pool";
        mode = "normal";
        runKey = todayKey;
        runDayNum = todayNum;
        run = newDailyRun(runKey, false);
        sampler = new PoolSampler(pool, dailySeed(runKey));
        track("ghost_link_invalid", { reason: "pool" });
        toast("This challenge was built on an older Daily — playing without the ghost.");
      }
    }
    track("daily_challenge_started", {
      day_number: runDayNum,
      hard: mode === "hard",
      vs_ghost: isDuel,
      streak: records.streak.count,
    });
    await startRound();
  } catch (e) {
    console.error(scrubErrorMessage(e));
    $("dIntroErr").textContent = "Couldn't load today's places — try again.";
    $("btnDailyStart").disabled = false;
  }
}

// The seeded order's first DAILY_ROUNDS image ids (deterministic, skip-free) —
// the stable basis for the poolCheck on both sender and recipient (§3.5.1).
async function peekDayIds(key) {
  if (peekIdsCache && peekIdsCache.key === key) return peekIdsCache.ids;
  const pool = await loadPool();
  const s = new PoolSampler(pool, dailySeed(key));
  const ids = [];
  for (let i = 0; i < DAILY_ROUNDS; i++) {
    const e = s.peek();
    if (!e) break;
    ids.push(e.image_id);
    s.advance();
  }
  peekIdsCache = { key, ids };
  return ids;
}

/* ================================================================
 * Rounds
 * ================================================================ */

async function startRound() {
  locked = false;
  stage = "explore";
  lastTickSecond = null;
  if (guessMarker) { guessMarker.remove(); guessMarker = null; }
  if (guessMap) guessMap.setView([25, 10], 2);
  $("btnDLockIn").disabled = true;
  updateGuessBanner();
  updateLockButton();
  destroyRevealMap();
  showScreen("d-round");
  // #7: teach the arrows in a normal (movement-allowed) daily; Hard reads the
  // single frame, so it keeps the plain copy.
  oneShotHint("pano", panoHintCard(dailyMoveAllowed(mode === "hard")));
  if (!iv) makeViewer();
  hideImageryDegraded();
  // #5: assert the movement lever explicitly each round (Hard = no movement),
  // not only via the construction seed, and reassert so a transient activation
  // failure recovers instead of stranding the controls.
  if (iv && iv.setMoveAllowed) iv.setMoveAllowed(dailyMoveAllowed(mode === "hard"));
  iv.beginRound(run.rounds.length + 1);
  const { entry, skips, degraded } = await loadRoundImage(sampler, iv, "anchor");
  if (!entry) {
    if (degraded) {
      if (iv && iv.ok === false) destroyViewer();
      showImageryDegraded();
      return;
    }
    finishRun();
    return;
  }
  noticeDegradedImagery(skips);
  sampler.advance();
  current = entry;
  roundStartedAt = Date.now();
  const seconds = dailyRoundSeconds(mode === "hard");
  endsAt = roundStartedAt + seconds * 1000;
  const tag = mode === "hard" ? " ⚡" : "";
  $("dHudRound").textContent = `Round ${run.rounds.length + 1}/${DAILY_ROUNDS}${tag}`;
  startTick();
}

// G6: hard mode reads the single frame (no movement). The viewer's navigation
// components are the G2 Frozen lever too — built off here for a hard run.
function makeViewer() {
  const moveAllowed = dailyMoveAllowed(mode === "hard");
  iv = createViewer({
    surface: "daily",
    container: "dailyViewer",
    moveAllowed,
    component: {
      cover: false,
      direction: moveAllowed,
      sequence: moveAllowed,
      keyboard: moveAllowed,
      zoom: true,
      bearing: true,
    },
  });
  viewer = iv.viewer;
}

function destroyViewer() {
  if (iv) { iv.destroy(); iv = null; }
  viewer = null;
}

/* ---------------- Guess map ---------------- */

function ensureGuessMap() {
  if (guessMap) return;
  guessMap = L.map("dailyGuessMap", { worldCopyJump: true, zoomControl: false })
    .setView([25, 10], 2);
  const bm = basemapTileLayerConfig();
  L.tileLayer(bm.url, bm.options).addTo(guessMap);
  guessMap.on("click", (e) => {
    if (guessMarker) {
      guessMarker.setLatLng(e.latlng);
    } else {
      guessMarker = L.marker(e.latlng, { draggable: true }).addTo(guessMap);
      guessMarker.on("move", updateLockButton);
    }
    $("btnDLockIn").disabled = false;
    updateGuessBanner();
    updateLockButton();
  });
}

function openGuessMap() {
  if (locked) return;
  stage = "map";
  showScreen("d-guess");
  ensureGuessMap();
  $("btnDLockIn").disabled = !guessMarker;
  updateGuessBanner();
  oneShotHint("guessmap", {
    title: "Drop your pin",
    lines: guessMapHintLines("daily"),
  });
  updateLockButton();
  setTimeout(() => guessMap.invalidateSize(), 50);
}

function backToStreet() {
  if (locked) return;
  stage = "explore";
  showScreen("d-round");
  if (viewer) viewer.resize();
}

function updateGuessBanner() {
  $("dGuessHint").classList.toggle("hidden", !!guessMarker);
}

function updateLockButton() {
  const btn = $("btnDLockIn");
  if (locked || stage !== "map" || !guessMarker || !current) {
    paintLockButton(btn, lockButtonLabel(LOCK_LABELS.daily, null, false));
    return;
  }
  const g = guessMarker.getLatLng();
  const km = haversineKm(
    current.lat, current.lng,
    g.lat, L.Util.wrapNum(g.lng, [-180, 180], true));
  const elapsed = Math.max(0, Date.now() - roundStartedAt);
  paintLockButton(btn, lockButtonLabel(
    LOCK_LABELS.daily,
    lockNowEstimate(km, elapsed, dailyRoundSeconds(mode === "hard")),
    false));
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
  updateLockButton();
  const left = endsAt - Date.now();
  $("dHudTimer").textContent = formatCountdown(left);
  $("dGuessTimer").textContent = formatCountdown(left);
  const low = left > 0 && left <= 10_500;
  $("dHudTimer").classList.toggle("low", low);
  $("dGuessTimer").classList.toggle("low", low);
  const t = countdownTick(lastTickSecond, left);
  if (t) {
    lastTickSecond = t.second;
    playSound(t.urgent ? "tickUrgent" : "tick");
  }
  if (left <= 0) lockIn(true);
}

/* ---------------- Lock in -> reveal ---------------- */

function lockIn(auto = false) {
  if (locked || !current) return;
  let guess = null;
  if (guessMarker) {
    const g = guessMarker.getLatLng();
    guess = { lat: g.lat, lng: L.Util.wrapNum(g.lng, [-180, 180], true) };
  }
  if (!guess && !auto) return;
  locked = true;
  stopTick();
  if (guess) { playSound("stamp"); buzz(35); }
  const elapsedMs = Math.max(0, Date.now() - roundStartedAt);
  const distanceKm = guess
    ? haversineKm(current.lat, current.lng, guess.lat, guess.lng)
    : null;
  // v2 (§5.2): store the pin + elapsed so this run can later become a ghost.
  run = recordDailyRound(run, guess
    ? { distanceKm, elapsedMs, lat: guess.lat, lng: guess.lng } : null);
  if (auto) {
    toast(guess
      ? "Time! Your pin was locked in."
      : "Time! No pin — no points this round.");
  }
  renderReveal(guess);
}

function renderReveal(guess) {
  showScreen("d-reveal");
  playSound("sting");
  oneShotHint("reveal", HINT_CARDS.reveal);
  const r = run.rounds[run.rounds.length - 1];
  const idx = run.rounds.length - 1;
  $("dRevealHeading").textContent =
    `Round ${run.rounds.length} of ${DAILY_ROUNDS}`;
  $("dRevealPlace").textContent = current.name || "—";

  // G4: medal caption on the result line; the ACE stamp on a sub-1km pin.
  const medal = medalForDistance(r.distanceKm);
  $("dRevealResult").textContent = revealResultLine(
    r.distanceKm != null
      ? {
          guess: true, distanceKm: r.distanceKm, points: r.points,
          timeBonus: r.timeBonus, medalCaption: medal.caption,
        }
      : null);
  if (medal.ace) stampFlash(`🎯 ACE — ${formatDistance(r.distanceKm)}`);

  // G5: the ghost materializes and the running comparison replaces the total.
  let ghostRes = null;
  if (isDuel) {
    ghostRes = scoreGhostRound(idx);
    ghostRoundResults[idx] = ghostRes;
    ghostTotalSoFar += ghostRes.points;
    const you = r.points;
    const gp = ghostRes.points;
    const verdict = you > gp ? "you take the round"
      : gp > you ? "👻 takes the round" : "dead heat";
    $("dRevealDuel").textContent =
      `You +${you.toLocaleString()} · 👻 +${gp.toLocaleString()} — ${verdict}`;
    $("dRevealDuel").classList.remove("hidden");
    $("dRevealTotalLabel").textContent = "You";
    $("dRevealTotal").textContent =
      `${run.score.toLocaleString()} · 👻 ${ghostTotalSoFar.toLocaleString()}`;
  } else {
    $("dRevealDuel").classList.add("hidden");
    $("dRevealTotalLabel").textContent = "Total so far";
    $("dRevealTotal").textContent = run.score.toLocaleString();
  }

  $("btnDNext").textContent =
    dailyRunComplete(run) ? "See my score" : "Next round";
  renderRevealMap(guess, ghostRes);
}

// The ghost's result for the round just revealed, recomputed on THIS device
// against the actual truth (`current`) — the integrity posture (§3.5.4).
function scoreGhostRound(idx) {
  const gr = ghost.rounds[idx];
  if (!gr || !gr.pinned) return { points: 0, distanceKm: null, pin: null };
  const km = haversineKm(current.lat, current.lng, gr.lat, gr.lng);
  const dp = scoreForDistance(km);
  const tb = timeBonus(dp, gr.elapsedMs, bonusWindowMs(dailyRoundSeconds(ghost.hard)));
  return { points: dp + tb, distanceKm: km, pin: { lat: gr.lat, lng: gr.lng } };
}

function renderRevealMap(guess, ghostRes) {
  destroyRevealMap();
  revealMap = L.map("dRevealMap", {
    zoomControl: false, dragging: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false,
  });
  const bm = basemapTileLayerConfig();
  L.tileLayer(bm.url, bm.options).addTo(revealMap);
  const truth = L.latLng(current.lat, current.lng);
  const bounds = [truth];
  if (guess) {
    const pin = L.latLng(guess.lat, guess.lng);
    bounds.push(pin);
    L.polyline([pin, truth], { color: "#4dd6ff", weight: 3, dashArray: "6 8" })
      .addTo(revealMap);
    L.circleMarker(pin, {
      radius: 8, color: "#fff", weight: 2, fillColor: "#4dd6ff", fillOpacity: 1,
    }).addTo(revealMap);
  }
  // G5/C4: the ghost marker — distinct (dashed, muted, 👻) with a dashed line
  // to the truth so its miss reads at a glance (mirrors the player's
  // guess→truth line). It MATERIALIZES ~400 ms after your pin with a fade, so
  // the two pins read as two beats, not one (spec §3.5.3). Reduced-motion: it
  // just appears. The pin is included in `bounds` synchronously so fitBounds
  // frames it even though the marker is added on a delay. Maps stay
  // replay-blocked.
  if (ghostRes && ghostRes.pin) {
    const gpin = L.latLng(ghostRes.pin.lat, ghostRes.pin.lng);
    bounds.push(gpin);
    const reduced = prefersReducedMotion();
    const addGhost = () => {
      if (!revealMap) return;
      L.polyline([gpin, truth], { color: "#c9a2ff", weight: 2, dashArray: "3 5" })
        .addTo(revealMap);
      const circle = L.circleMarker(gpin, {
        radius: 8, color: "#c9a2ff", weight: 2, dashArray: "3 3",
        fillColor: "#2a2140", fillOpacity: 0.85,
      }).addTo(revealMap);
      const chip = L.marker(gpin, {
        icon: L.divIcon({ className: "ghost-chip", html: `👻 ${formatDistance(ghostRes.distanceKm)}` }),
      }).addTo(revealMap);
      if (!reduced) {
        const els = [circle.getElement && circle.getElement(),
          chip.getElement && chip.getElement()].filter(Boolean);
        for (const el of els) {
          el.style.opacity = "0";
          el.style.transition = "opacity 350ms ease";
        }
        requestAnimationFrame(() => requestAnimationFrame(() => {
          for (const el of els) el.style.opacity = "1";
        }));
      }
    };
    if (reduced) addGhost();
    else setTimeout(addGhost, 400);
  }
  if (bounds.length > 1) {
    revealMap.fitBounds(L.latLngBounds(bounds).pad(0.25), { maxZoom: 10 });
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

async function finishRun() {
  stopTick();
  destroyViewer();

  // R1 idempotency: a duel whose day+mode is already resolved (an earlier
  // instant-verdict, or a replay that raced the boot guard) folds NOTHING
  // again — no duplicate W/L, ACE/PB fold, saved-run overwrite, verdict/
  // completed event, or dishonest return link. The verdict still renders.
  const plan = duelFoldPlan({
    isDuel, isExhibition, alreadyResolved: duelAlreadyResolved(runDayNum, mode),
  });

  // The duel verdict (recipient's device), computed once at the end.
  let verdict = null;
  if (isDuel) {
    const yourPoints = run.rounds.map((r) => r.points);
    const ghostPoints = run.rounds.map((_, i) =>
      (ghostRoundResults[i] || { points: 0 }).points);
    verdict = duelVerdict(yourPoints, ghostPoints);
    if (plan.emitDuel) {
      track("ghost_duel_completed", {
        day_number: runDayNum,
        outcome: verdict.outcome,
        margin: verdict.margin,
        hard: mode === "hard",
      });
    }
  }

  // Records + replay lock — exhibitions save NOTHING (§3.5.2 case 6).
  let streakCount = records.streak.count;
  let graceUsed = false;
  let pb = false;
  const aces = run.rounds.filter(
    (r) => typeof r.distanceKm === "number" && r.distanceKm < 1).length;
  if (plan.foldRecords) {
    saveDailyResult(localStorage, run);
    const applied = applyDailyResult(records, run, { day: runDayNum, key: runKey });
    Object.assign(records, applied.records);
    streakCount = applied.streak;
    graceUsed = applied.graceUsed;
    pb = applied.pb;
    if (plan.foldDuel) {
      const dueled = applyDuelResult(records, verdict.outcome === "won");
      Object.assign(records, dueled.records);
      // Mark this day+mode resolved so re-tapping the link later (which routes
      // to the instant-verdict path) can't re-fold the duels counter.
      markDuelResolved(runDayNum, mode);
    }
    saveRecords(localStorage, records);
  }

  // "Your Color Takes the Room": a notable run (a PB, an ACE, or the streak
  // landing on a week boundary) earns the bigger championFanfare instead of
  // the plain one — never on an exhibition, which changed nothing real.
  const notable = !isExhibition &&
    (pb || aces > 0 || (!run.hard && streakCount > 0 && streakCount % 7 === 0));
  playSound(notable ? "championFanfare" : "fanfare");

  if (plan.emitCompleted) {
    track("daily_challenge_completed", {
      day_number: runDayNum,
      score: run.score,
      rounds_played: guessedRounds(run),
      best_distance_km: bestDailyDistance(run),
      hard: mode === "hard",
      vs_ghost: isDuel,
      streak: mode === "hard" ? records.streak.count : streakCount,
      pb,
      aces,
    });
  }

  renderDone(run, false, { verdict, streakCount, graceUsed, pb, aces, notable });
}

// "3rd", "21st" — the ACE counter's ordinal (spec §3.4). Handles the 11–13
// teens exception.
function ordinal(n) {
  const v = Math.abs(n) % 100;
  const s = ["th", "st", "nd", "rd"];
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

// Idempotency guard for the duels counter + ghost_duel_completed: a duel for a
// given day+mode is folded and reported exactly ONCE per device, even though a
// challenge link can be re-tapped (re-loading the fragment) any number of times.
// Without this, re-opening a completed duel link would inflate the device's
// lifetime W/L and re-emit the verdict event on every open.
function duelResolvedKey(dayNum, m) { return `geoparty_duel_done_${dayNum}_${m}`; }
function duelAlreadyResolved(dayNum, m) {
  try { return localStorage.getItem(duelResolvedKey(dayNum, m)) === "1"; }
  catch { return false; }
}
function markDuelResolved(dayNum, m) {
  try { localStorage.setItem(duelResolvedKey(dayNum, m), "1"); }
  catch { /* private mode: not remembered, so it may re-fold — acceptable */ }
}

// C3: resolve an already-played duel to its verdict with no replay (§3.5.2
// case 5). Recompute the ghost's per-round scores on THIS device against the
// day's actual truths (integrity: no wire-trusted score), compare to the
// recipient's saved per-round points, emit ghost_duel_completed, and show the
// verdict done screen. poolCheck degrades to the plain result, exactly like the
// play path. Never throws to the user — any failure falls back to plain done.
async function instantVerdict(saved) {
  try {
    const pool = await loadPool();
    const s = new PoolSampler(pool, dailySeed(runKey));
    const truths = [];
    const ids = [];
    for (let i = 0; i < DAILY_ROUNDS; i++) {
      const e = s.peek();
      if (!e) break;
      truths.push({ lat: e.lat, lng: e.lng });
      ids.push(e.image_id);
      s.advance();
    }
    if (!poolMatches(ghost.poolCheck, ids)) {
      track("ghost_link_invalid", { reason: "pool" });
      toast("This challenge was built on an older Daily — showing your result.");
      renderDone(saved, true, { streakCount: records.streak.count });
      return;
    }
    const gScores = ghostScores(truths, ghost);
    for (let i = 0; i < gScores.length; i++) {
      ghostRoundResults[i] = {
        points: gScores[i].points,
        distanceKm: gScores[i].distanceKm,
        pin: gScores[i].pinned ? ghost.rounds[i] : null,
      };
    }
    const yourPoints = saved.rounds.map((r) => r.points || 0);
    const ghostPoints = gScores.map((r) => r.points);
    const verdict = duelVerdict(yourPoints, ghostPoints);
    // Fold + report ONCE per day+mode (idempotent across link re-taps). The
    // verdict always renders; only the counter and the event are gated.
    if (!duelAlreadyResolved(runDayNum, mode)) {
      track("ghost_duel_completed", {
        day_number: runDayNum,
        outcome: verdict.outcome,
        margin: verdict.margin,
        hard: mode === "hard",
      });
      const dueled = applyDuelResult(records, verdict.outcome === "won");
      Object.assign(records, dueled.records);
      saveRecords(localStorage, records);
      markDuelResolved(runDayNum, mode);
    }
    renderDone(saved, true, { verdict, streakCount: records.streak.count });
  } catch (e) {
    console.error(scrubErrorMessage(e));
    renderDone(saved, true, { streakCount: records.streak.count });
  }
}

function renderDone(result, alreadyPlayed, extra = {}) {
  showScreen("d-done");
  const star = result.hard ? "*" : "";
  const doneEl = $("d-done");
  const titleEl = $("dDoneTitle");
  titleEl.textContent = alreadyPlayed
    ? `You played Daily #${runDayNum}${star} ✓`
    : `Daily #${runDayNum}${star} done!`;
  $("dDoneScore").textContent = result.score.toLocaleString();
  $("dDoneEmoji").textContent = emojiRow(result.rounds);

  // "Your Color Takes the Room": only a genuinely fresh, non-exhibition run
  // gets the celebration — replaying an already-played day or an exhibition
  // duel earns neither confetti nor the punched-up headline (no winLine:
  // the Daily is solo, so there's no room's-worth of team names to remix).
  const fresh = !alreadyPlayed && !isExhibition;
  const plan = fresh ? celebrationSpec({
    won: true,
    champion: !!extra.notable,
    teamColor: null,
    seed: `daily:${runDayNum}:${result.score}`,
    surface: "daily",
  }) : null;
  if (plan) {
    doneEl.style.setProperty("--win", plan.winVar);
    doneEl.classList.add("is-win");
    doneEl.classList.toggle("is-champion", plan.tier === "champion");
    titleEl.classList.add("win-headline");
    spawnConfetti($("dConfetti"), {
      seed: plan.seed, tier: plan.tier, accentColor: plan.accentColor,
      spread: plan.spread, count: plan.count,
    });
  } else {
    doneEl.style.removeProperty("--win");
    doneEl.classList.remove("is-win", "is-champion");
    titleEl.classList.remove("win-headline");
  }

  // G1/G8 lines (never on an exhibition — it changed nothing).
  const streakEl = $("dDoneStreak");
  const pbEl = $("dDonePB");
  streakEl.classList.add("hidden");
  pbEl.classList.add("hidden");
  if (!isExhibition && !result.hard && (extra.streakCount || 0) >= 1) {
    streakEl.textContent = extra.graceUsed
      ? `Missed a day — your streak survived. 🔥 ${extra.streakCount}`
      : `🔥 ${extra.streakCount} — day streak`;
    streakEl.classList.remove("hidden");
  }
  if (!isExhibition && extra.pb) pbEl.classList.remove("hidden");

  // G4 (C5): the ACE counter line — "🎯 3rd ace this month" — renders when this
  // run earned at least one ACE and it counted (never on an exhibition). The
  // count comes from records.aces.monthCount, already folded at completion.
  const aceEl = $("dDoneAce");
  aceEl.classList.add("hidden");
  if (!isExhibition && (extra.aces || 0) > 0) {
    aceEl.textContent = `🎯 ${ordinal(records.aces.monthCount)} ace this month`;
    aceEl.classList.remove("hidden");
  }

  // G5 duel verdict block.
  renderDuelDone(extra.verdict, result);
  // C4: on a duel run the primary share IS the return challenge — label it so
  // (spec §3.5.4). A non-duel run keeps its HTML default ("Share result").
  if (extra.verdict) $("btnDShare").textContent = "Send your verdict";

  // Exhibition footnote (an exhibition that ends in an ad for the ritual).
  if (isExhibition) {
    $("dDoneNote").textContent =
      "That was another day's five — today's Daily is still waiting for you.";
  } else if (alreadyPlayed) {
    $("dDoneNote").textContent =
      "One run per day keeps scores honest — a fresh five tomorrow.";
  }

  // G6 hard-mode entry: after a normal run is done, once, if hard isn't played.
  const hardDone = $("dHardDone");
  const showHard = !result.hard && !isExhibition &&
    !loadDailyResult(localStorage, todayKey, DAILY_RESULT_HARD_KEY) &&
    runDayNum === todayNum;
  hardDone.classList.toggle("hidden", !showHard);

  wireShare(result, extra.verdict);
}

function renderDuelDone(verdict, result) {
  const box = $("dDoneDuel");
  box.textContent = "";
  if (!verdict) { box.classList.add("hidden"); return; }
  const head = document.createElement("div");
  head.className = "done-duel-head";
  head.textContent = verdict.outcome === "won" ? "You won the duel! 🏆"
    : verdict.outcome === "lost" ? "The ghost got you 👻" : "Dead heat.";
  const margin = document.createElement("div");
  margin.className = "done-duel-margin";
  margin.textContent = verdict.outcome === "tie"
    ? `${verdict.yourTotal.toLocaleString()} apiece`
    : `${verdict.yourTotal.toLocaleString()} to ${verdict.ghostTotal.toLocaleString()} — by ${verdict.margin.toLocaleString()}`;
  const strip = document.createElement("div");
  strip.className = "done-duel-strip";
  const yours = document.createElement("div");
  yours.textContent = `You  ${emojiRow(result.rounds)}`;
  const theirs = document.createElement("div");
  theirs.textContent = `👻  ${ghostRoundResults.map((g) => distanceEmoji(g && g.distanceKm != null ? g.distanceKm : undefined)).join("")}`;
  strip.append(yours, theirs);
  box.append(head, margin, strip);
  box.classList.remove("hidden");
}

// The share is a Ghost Duel challenge link by DEFAULT once G5 ships (§3.5.1) —
// the return challenge is the default share, not a separate mechanic.
function wireShare(result, verdict) {
  $("btnDShare").onclick = async () => {
    let payload = null;
    // R5: a run with no saved per-round pins (a pre-v2 save, or an all-forfeit
    // run) must NEVER produce an all-forfeit ghost link — it's not a duel. Gate
    // the payload on runHasPins and share the plain card with an honest toast.
    const hasPins = runHasPins(result);
    if (hasPins) {
      try {
        const ids = await peekDayIds(runKey);
        payload = buildGhostPayload(result, ids, runDayNum);
      } catch { /* offline: fall back to a plain card below */ }
    }
    const base = new URL("daily.html", location.href).href;
    const url = payload ? dailyChallengeUrl(base, payload, "daily")
      : withUtm(base, "daily");
    const text = dailyShareText({
      dayNumber: runDayNum,
      score: result.score,
      rounds: result.rounds,
      url,
      streak: (!result.hard && !isExhibition) ? records.streak.count : 0,
      hard: !!result.hard,
      challenge: !!payload,
      verdict: verdict ? { outcome: verdict.outcome, margin: verdict.margin } : null,
    });
    shareResult(text, "daily", toast, { challenge: !!payload });
    if (!hasPins) {
      toast("This run has no saved pins — sharing a plain card, no ghost duel.");
    }
  };
}

/* ================================================================
 * Hard mode entry (G6) — restart the page state into a hard run.
 * ================================================================ */

function startHardMode() {
  mode = "hard";
  isDuel = false;
  isExhibition = false;
  runKey = todayKey;
  runDayNum = todayNum;
  run = newDailyRun(runKey, true);
  ghostRoundResults.length = 0;
  ghostTotalSoFar = 0;
  destroyViewer();
  renderIntro();
  startChallenge();
}

/* ================================================================
 * Intro / boot
 * ================================================================ */

function renderIntro() {
  // Challenge eyebrow + explainer (G5), or the plain intro.
  const eyebrow = $("dChallengeEyebrow");
  const explain = $("dChallengeExplain");
  const rules = document.querySelector("#d-intro .daily-rules:not(#dChallengeExplain)");
  if (isDuel) {
    const hardTag = mode === "hard" ? "* ⚡" : "";
    eyebrow.textContent = `⚔️ CHALLENGE — Daily #${runDayNum}${hardTag}`;
    eyebrow.classList.remove("hidden");
    explain.textContent =
      "A friend sent you their run. Their ghost pin appears at every reveal — " +
      "same five places, same rules.";
    explain.classList.remove("hidden");
    if (rules) rules.classList.add("hidden");
    $("btnDailyStart").textContent = "Take the challenge";
  } else {
    eyebrow.classList.add("hidden");
    explain.classList.add("hidden");
    if (rules) rules.classList.remove("hidden");
    $("btnDailyStart").textContent = mode === "hard"
      ? "Play Hard Mode ⚡" : "Play Today's Daily";
  }

  // Records line (G1/G8) — streak + PB, normal board on a normal intro.
  const recLine = $("dIntroRecords");
  const parts = [];
  const board = mode === "hard" ? records.hard : records.daily;
  if (board.bestScore) {
    parts.push(`Your best: ${board.bestScore.score.toLocaleString()} (Daily #${board.bestScore.day})`);
  }
  if (mode !== "hard" && records.streak.count >= 1) {
    parts.push(`🔥 ${records.streak.count}`);
    // R6 (spec §3.1): the first streak surface on a device carries one honest
    // line — never an accusation, just the truth that a streak is device-local.
    // One-shot via the hints mechanism (geoparty_hint_streak).
    if (claimHint(localStorage, "streak")) {
      parts.push("Streaks live in this browser — same phone, same streak");
    }
  }
  recLine.textContent = parts.join(" · ");

  $("dHardIntro").classList.add("hidden");   // hard is offered on the done screen
  $("dDailyNum").textContent = `#${runDayNum}${mode === "hard" ? "*" : ""}`;
  $("dDailyDate").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric",
  });
}

/* ================================================================
 * Boot
 * ================================================================ */

initSound("daily");
$("btnDailyStart").addEventListener("click", startChallenge);
$("btnDOpenMap").addEventListener("click", openGuessMap);
$("btnDBackToStreet").addEventListener("click", backToStreet);
$("btnDLockIn").addEventListener("click", () => lockIn(false));
$("btnDNext").addEventListener("click", nextOrFinish);
$("btnDHardStart").addEventListener("click", startHardMode);
$("btnDHardDone").addEventListener("click", startHardMode);
// §6: the done-screen "How to play" link.
$("dHowto").addEventListener("click", () =>
  track("howto_opened", { source: "gameover" }));

// Report a link that arrived broken (before any run), and seed the PB from an
// existing same-device result so day-one players don't see "no best" (§3.8).
// R3: every boot-known failure reason is reported exactly once — malformed,
// version AND expired (the "pool" reason has its own site in startChallenge /
// instantVerdict, after the day's ids load). This block runs once at boot.
if (ghostLinkReason === "malformed" || ghostLinkReason === "version" ||
    ghostLinkReason === "expired") {
  track("ghost_link_invalid", { reason: ghostLinkReason });
}
{
  const seedNormal = loadDailyResult(localStorage, todayKey, DAILY_RESULT_KEY);
  if (seedNormal) Object.assign(records, seedBestFromResult(records, seedNormal, todayNum, false));
  const seedHard = loadDailyResult(localStorage, todayKey, DAILY_RESULT_HARD_KEY);
  if (seedHard) Object.assign(records, seedBestFromResult(records, seedHard, todayNum, true));
}

renderIntro();

// Replay lock: a saved run for THIS run's mode/day already exists.
const savedForRun = savedResultForRun();

if (ghostLinkReason === "malformed") {
  toast("That challenge link got damaged in transit — today's Daily is right here.");
} else if (ghostLinkReason === "version") {
  toast("This challenge needs a newer GeoParty — play today's Daily meanwhile.");
} else if (ghostLinkReason === "expired") {
  toast("This challenge expired — the Daily is a fresh five every day.");
}

const bootRoute = dailyEntryRoute({
  hasSaved: !!savedForRun, isExhibition, isDuel, ghostOk: !!(ghost && ghost.ok),
});
if (bootRoute === "instant-verdict") {
  // C3 (spec §3.5.2 case 5): the recipient already completed this board today,
  // so their saved run IS their side of the duel — skip gameplay straight to
  // the verdict, no replay. The recompute is async (needs the day's truths);
  // R1: until it resolves, neutralize the intro so a "Take the challenge" tap
  // can't start a replay of the board we already completed — startChallenge
  // re-checks the same lock, and this button is disabled meanwhile too.
  showScreen("d-intro");
  $("btnDailyStart").disabled = true;
  $("btnDailyStart").textContent = "Loading your duel…";
  resolveSavedRun(savedForRun);
} else if (bootRoute === "done") {
  // Already played this board today, no usable duel — the plain done screen.
  resolveSavedRun(savedForRun);
} else {
  showScreen("d-intro");
}
