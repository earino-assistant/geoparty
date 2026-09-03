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
  formatElapsed,
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
  decideAnchorFailure,
  anchorRetryDelayMs,
  DAILY_RESULT_KEY,
  DAILY_RESULT_HARD_KEY,
  newDailyRun,
  recordDailyRound,
  dailyRunComplete,
  guessedRounds,
  bestDailyDistance,
  dailyExploreMs,
  loadDailyResult,
  saveDailyResult,
  buildInflight,
  inflightMatchesPool,
  placesFromCursors,
  resolveInflight,
  loadInflight,
  saveInflight,
  clearInflight,
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
import { scrubErrorMessage, poolDiagId } from "./imagery.js";
import { track } from "./consent.js";
import { setActiveScreen } from "./chrome-ui.js";
import { createViewer, loadRoundImage } from "./viewer-ui.js";
import { toastWithReport, toastPlain } from "./report-ui.js";
import { dailyRevealScene } from "./revealmap.js";
import { renderRevealScene } from "./revealmap-ui.js";
import { createRecapCarousel } from "./recap-ui.js";
import { recapCards, recapCardScene, recapCaption } from "./recap.js";

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
// The day's five places in seeded order (name + coords + image id) — the
// deterministic, skip-free basis for the OUTGOING ghost's poolCheck (§3.5.1)
// AND the done-screen recap's truths on a replay/verdict path. Populated
// lazily; peekDayIds derives the id list from it.
let peekPlacesCache = null;

// The places actually shown this run, in play order (skip-adjusted), captured
// at each lock-in so the recap can pair the player's saved pins with the truth
// they actually saw without recomputing. Reset on a hard-mode restart.
const playedPlaces = [];

// Mid-run persistence (docs/daily-persistence-spec.md). `cursors[i]` is the
// sampler cursor after round i advanced; `inflightPoolCheck` is the day's
// drift-guard hash, computed once per solo run before the first round;
// `resumeState` is the validated inflight parse when boot routes to resume /
// finalize (null otherwise). All three stay null/empty for duel/exhibition
// runs — those never persist (§5.4).
let cursors = [];
let inflightPoolCheck = null;
let resumeState = null;

let iv = null;
let guessMap = null;
let guessMarker = null;
let revealHandle = null;
// Recap (done-screen "Your five places"): the shared carousel handle (built
// by js/recap-ui.js — the one carousel builder for Daily + party game-over).
let recapHandle = null;
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
  // Mid-run persistence (§7): the calm intro's primary button carries the
  // resume affordance when a valid mid-run save exists — dispatch to it here
  // so the button wiring stays single. Owner directive 2026-08-29: once you've
  // started, you may only continue — there is no player-facing "Start over".
  if (resumeState) { await resumeChallenge(); return; }
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
        toast("This challenge was built on an older Daily — playing today's five solo instead.");
      }
    }
    if (!isExhibition) {
      track("daily_challenge_started", {
        day_number: runDayNum,
        hard: mode === "hard",
        vs_ghost: isDuel,
        streak: records.streak.count,
      });
    }
    // Mid-run persistence (§4): a solo run gets a drift-guard hash over the
    // day's first DAILY_ROUNDS skip-free seeded ids, computed once from the
    // in-memory pool (peekDayIds is cached, no network). Stashed for the
    // per-lock-in saves. Duel/exhibition runs never persist (§5.4).
    if (!isDuel && !isExhibition) {
      inflightPoolCheck = poolCheck(await peekDayIds(runKey));
    }
    await startRound();
  } catch (e) {
    console.error(scrubErrorMessage(e));
    $("dIntroErr").textContent = "Couldn't load today's places — try again.";
    $("btnDailyStart").disabled = false;
  }
}

// The seeded order's first DAILY_ROUNDS places (deterministic, skip-free) —
// name + coords + image id. The stable basis for the poolCheck on both sender
// and recipient (§3.5.1), for the ghost-verdict truths (instantVerdict), and
// for the recap's truths when the run wasn't played live this session.
async function peekDayPlaces(key) {
  if (peekPlacesCache && peekPlacesCache.key === key) return peekPlacesCache.places;
  const pool = await loadPool();
  const s = new PoolSampler(pool, dailySeed(key));
  const places = [];
  for (let i = 0; i < DAILY_ROUNDS; i++) {
    const e = s.peek();
    if (!e) break;
    places.push({ name: e.name, lat: e.lat, lng: e.lng, image_id: e.image_id });
    s.advance();
  }
  peekPlacesCache = { key, places };
  return places;
}

// The seeded order's image ids — the poolCheck basis (§3.5.1), derived from
// the places above so the two can never drift.
async function peekDayIds(key) {
  return (await peekDayPlaces(key)).map((p) => p.image_id);
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
  const loaded = await loadAnchorHealed();
  if (!loaded) return;   // routed to a terminal surface (stub retry / finishRun)
  const { entry, skips } = loaded;
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

// Load this round's anchor, healing past a poisoned entry (daily.js
// "poisoned-anchor skip", owner hotfix 2026-08-29). A transient anchor failure
// retries the SAME entry up to DAILY_ANCHOR_RETRY_MAX times (fast backoff) and
// then SKIPS it — advancing the seeded sampler and loading the next entry — so
// a persistently 500ing anchor can never strand the run at a terminal Retry
// screen mid-play. A viewer STUB (iv.ok === false) is a whole-device failure,
// not a per-entry one, so it still surfaces the retryable degraded screen (a
// skip there would grind the whole pool). Returns { entry, skips } on success,
// or null when it routed to a terminal surface (stub degraded screen, or
// finishRun on a genuinely exhausted pool) and the caller must return.
async function loadAnchorHealed() {
  let skips = 0;
  let retriesDone = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const r = await loadRoundImage(sampler, iv, "anchor");
    skips += r.skips;
    if (r.entry) return { entry: r.entry, skips };
    if (!r.degraded) { finishRun(); return null; }   // pool exhausted
    const decision = decideAnchorFailure({
      viewerStub: !!(iv && iv.ok === false), retriesDone,
    });
    if (decision === "stub") {
      if (iv && iv.ok === false) destroyViewer();
      showImageryDegraded();
      return null;
    }
    if (decision === "retry") {
      retriesDone += 1;
      // eslint-disable-next-line no-await-in-loop
      await anchorRetryBackoff(retriesDone);
      continue;   // same anchor — the sampler was NOT advanced
    }
    // "skip": heal past the poisoned location. It is NOT a played round — no
    // run.rounds entry and no cursor is pushed for it, so score / 5-round
    // accounting and the inflight cursors stay truthful (the next lock-in's
    // post-advance cursor already points past the skipped slot).
    const poisoned = sampler.peek();
    track("daily_anchor_skipped", {
      pool_entry: poisoned ? poolDiagId(poisoned.image_id) : "",
      attempts: retriesDone + 1,
    });
    sampler.advance();
    skips += 1;
    retriesDone = 0;
  }
}

// Fast-backoff sleep between same-anchor retries; the delay itself is the pure
// anchorRetryDelayMs(retryNumber) (daily.js).
function anchorRetryBackoff(retryNumber) {
  return new Promise((resolve) => setTimeout(resolve, anchorRetryDelayMs(retryNumber)));
}

// G6: hard mode reads the single frame (no movement). The viewer's navigation
// components are the G2 Frozen lever too — built off here for a hard run.
function makeViewer() {
  const moveAllowed = dailyMoveAllowed(mode === "hard");
  iv = createViewer({
    surface: "daily",
    container: "dailyViewer",
    moveAllowed,
    // §18 (docs/ios-blackout-review.md): the wrapper rebuilds a render-dead
    // viewer in place, silently on success. It only calls back on a failure the
    // player must know about — the map-guess path is still fully functional, so
    // the round is not lost.
    onRecovery: (result) => {
      if (result === "rebuild_failed" || result === "still_dead") {
        toast(
          "Street imagery crashed on this phone — you can still guess from the map.",
          { surface: "daily" });
      }
    },
    component: {
      cover: false,
      direction: moveAllowed,
      sequence: moveAllowed,
      keyboard: moveAllowed,
      zoom: true,
      bearing: true,
    },
  });
}

function destroyViewer() {
  if (iv) { iv.destroy(); iv = null; }
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
  // §3.4/G5: resize through the façade, never a raw `iv.viewer` alias — after a
  // §18 rebuild that alias would point at a removed viewer.
  if (iv) iv.resize();
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

/* ---------------- Ticker ----------------
 * Two shapes, one interval. Hard mode is a timed challenge (owner decision
 * 2026-09-03): a countdown with the low-time urgency class, the urgent tick
 * sound, and auto-lock at the buzzer — unchanged. The normal Daily is NOT
 * timed: a plain count-up elapsed readout, no urgency state, no tick sound,
 * and no auto-lock — the player explores and locks in whenever they're ready.
 * The decaying speed bonus (which floors at zero, never a penalty) still pays
 * out at submit either way; it doesn't need a deadline. */

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
  if (mode === "hard") {
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
    return;
  }
  // Normal Daily: informational count-up from round start. No deadline, no
  // "time's up", no urgency state.
  const elapsed = Math.max(0, Date.now() - roundStartedAt);
  $("dHudTimer").textContent = formatElapsed(elapsed);
  $("dGuessTimer").textContent = formatElapsed(elapsed);
  $("dHudTimer").classList.remove("low");
  $("dGuessTimer").classList.remove("low");
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
  // Record the truth actually shown this round (skip-adjusted play order), so
  // the done-screen recap can pair pins to places with no recompute (index i
  // aligns with run.rounds[i]).
  playedPlaces.push({ name: current.name, lat: current.lat, lng: current.lng });
  // Mid-run persistence (§4): a solo run commits its progress at every
  // lock-in (≤ DAILY_ROUNDS writes/day). The sampler cursor here is the
  // post-advance position, so cursors.at(-1) is exactly where a resume
  // rebuilds the sampler. Duel/exhibition runs never write (§5.4). A
  // storage failure is swallowed — the run continues un-persisted.
  if (!isDuel && !isExhibition) {
    cursors.push(sampler.cursor);
    saveInflight(localStorage, buildInflight(run, cursors, inflightPoolCheck));
  }
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
  $("dRevealPlace").textContent = current.name || "Somewhere mysterious";

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
      : gp > you ? "the ghost takes the round" : "you and the ghost tied";
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

// G5/C4: the reveal map — the player's guess pin + line, then the ghost's
// distinct dashed 👻 marker materializing ~400 ms later with a fade (two
// beats, not one — spec §3.5.3; reduced motion just appears), then the gold
// truth. All of it is now a declarative scene built by js/revealmap.js and
// executed by js/revealmap-ui.js (shared with the phone/TV reveals). Maps
// stay replay-blocked.
function renderRevealMap(guess, ghostRes) {
  destroyRevealMap();
  revealHandle = renderRevealScene("dRevealMap", dailyRevealScene({
    truth: current,
    guess,
    ghost: ghostRes && ghostRes.pin
      ? { pin: ghostRes.pin, distanceKm: ghostRes.distanceKm } : null,
    reducedMotion: prefersReducedMotion(),
  }));
}

function destroyRevealMap() {
  revealHandle?.destroy();
  revealHandle = null;
}

function nextOrFinish() {
  if (dailyRunComplete(run)) { finishRun(); return; }
  startRound();
}

/* ---------------- Done ---------------- */

// The solo completion fold (docs/daily-persistence-spec.md §6): save the run
// to its board slot and fold records/streak/PB. Shared by the live finishRun
// path and the finalize-rescue boot path so a crash-at-the-finish run folds
// identically. Returns the applyDailyResult result (records/streak/graceUsed/
// pb). Does NOT saveRecords — the caller does that (finishRun folds duels
// first). Does NOT touch the inflight slot — the caller sequences the clear.
function foldDailyRecords(completedRun) {
  saveDailyResult(localStorage, completedRun);
  const applied = applyDailyResult(records, completedRun,
    { day: runDayNum, key: runKey });
  Object.assign(records, applied.records);
  return applied;
}

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
    const applied = foldDailyRecords(run);
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
    // Mid-run persistence (§4/§6): clear the inflight slot only AFTER the save
    // + records fold succeed, so a crash inside finishRun leaves a *complete*
    // inflight that the finalize boot route can still rescue. Solo only —
    // duel/exhibition runs never wrote the slot.
    if (!isDuel && !isExhibition) clearInflight(localStorage);
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
      explore_ms: dailyExploreMs(run),
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
    const places = await peekDayPlaces(runKey);
    const truths = places.map((p) => ({ lat: p.lat, lng: p.lng }));
    const ids = places.map((p) => p.image_id);
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
  // Hard mode keeps its "*" marker; a ⚡ rides next to it as the visible gloss
  // (the intro day badge carries the title/aria "Hard Mode" where it's born).
  const star = result.hard ? "*⚡" : "";
  const doneEl = $("d-done");
  const titleEl = $("dDoneTitle");
  titleEl.textContent = alreadyPlayed
    ? `You played Daily #${runDayNum}${star} ✓`
    : `Daily #${runDayNum}${star} — you did it! 🎉`;
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
    aceEl.textContent = `🎯 ${ordinal(records.aces.monthCount)} ACE this month`;
    aceEl.classList.remove("hidden");
  }

  // G5 duel verdict block.
  renderDuelDone(extra.verdict, result);
  // C4: on a duel run the primary share IS the return challenge — label it so
  // (spec §3.5.4). A non-duel run keeps its HTML default ("Share result").
  if (extra.verdict) $("btnDShare").textContent = "Share your run";

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

  // "Your five places" recap — best-effort; a failure here must never break
  // the done screen (async, self-wrapped in try/catch, fire-and-forget).
  renderRecap(result, alreadyPlayed);
}

function renderDuelDone(verdict, result) {
  const box = $("dDoneDuel");
  box.textContent = "";
  if (!verdict) { box.classList.add("hidden"); return; }
  const head = document.createElement("div");
  head.className = "done-duel-head";
  head.textContent = verdict.outcome === "won" ? "You beat the ghost! 🏆"
    : verdict.outcome === "lost" ? "The ghost got you 👻" : "You and the ghost tied";
  const margin = document.createElement("div");
  margin.className = "done-duel-margin";
  margin.textContent = verdict.outcome === "tie"
    ? `${verdict.yourTotal.toLocaleString()} apiece`
    : `${verdict.yourTotal.toLocaleString()} to ${verdict.ghostTotal.toLocaleString()} — by ${verdict.margin.toLocaleString()} pts`;
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

/* ================================================================
 * "Your five places" recap (done screen). A swipeable per-round carousel,
 * each card the same reveal scene as the live round (guess pin, truth, the
 * 👻 cue on a duel) plus the city name. The truths are recomputed from the
 * seed (fresh play) or taken from playedPlaces — never persisted into the
 * saved run. All decision logic is pure in js/recap.js; this is the thin
 * Leaflet/observer glue.
 * ================================================================ */

// One daily_recap_engaged per render, latched on the first real engagement
// (a carousel card scrolled = "swipe"). The latch itself lives inside the
// createRecapCarousel handle; this only fires the event.
function engageRecap() {
  track("daily_recap_engaged", {
    day_number: runDayNum, source: "swipe", vs_ghost: isDuel, hard: mode === "hard",
  });
}

// Tear down any live recap carousel. Safe to call repeatedly (renderRecap
// re-entry, a hard-mode restart). Never throws.
function destroyRecap() {
  try { recapHandle?.destroy(); } catch { /* gone */ }
  recapHandle = null;
}

async function renderRecap(result, alreadyPlayed) {
  const box = $("dDoneRecap");
  try {
    destroyRecap();
    // The static "Your five places" title must not wait on async place
    // reconstruction — show the recap frame in the same beat as the done
    // screen so the header never blinks in late (worst on the re-opened
    // ghost-link path, where peekDayPlaces below actually awaits). Only the
    // carousel cards fill in once places resolve. The no-cards / error paths
    // re-hide the box, so a zero-card run never leaves a lonely header.
    box.classList.remove("hidden");
    // Fresh play: the places we actually showed (skip-adjusted, aligned to
    // result.rounds). Replay / ghost-verdict: recompute from the seed (the
    // skew guard in recapCards drops any card the pool has drifted under).
    const places = alreadyPlayed
      ? await peekDayPlaces(runKey)
      : playedPlaces.slice();
    const cards = recapCards({
      places, rounds: result.rounds, ghostRounds: ghostRoundResults,
    });
    // Carousel: one card per round, maps lazy-initialised as they scroll in.
    // createRecapCarousel hides the box itself on zero cards.
    const reduced = prefersReducedMotion();
    recapHandle = createRecapCarousel({
      box, carousel: $("dRecapCarousel"), cards,
      sceneFor: (c) => recapCardScene(c, reduced),
      captionFor: recapCaption,
      onEngage: engageRecap,
    });
  } catch (e) {
    console.error(scrubErrorMessage(e));
    try { destroyRecap(); } catch { /* nothing left to lose */ }
    box.classList.add("hidden");
  }
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
      toast("This run has no saved pins — sharing your score card without the challenge link.");
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
  // The recap belongs to the finished normal run; a hard restart starts a
  // fresh five, so tear it down and clear the captured play order.
  destroyRecap();
  playedPlaces.length = 0;
  // Mid-run persistence: a hard restart is a fresh solo run — the normal run
  // already cleared its slot at completion. Reset the in-flight bookkeeping so
  // the hard run persists under its own cursors/pool-check (run.hard = true).
  cursors = [];
  inflightPoolCheck = null;
  resumeState = null;
  destroyViewer();
  renderIntro();
  startChallenge();
}

/* ================================================================
 * Mid-run persistence — resume + finalize + start-over
 * (docs/daily-persistence-spec.md §5.2/§6/§7). Glue only; every decision
 * (validate, drift-guard, reconstruct places, route) is a pure daily.js /
 * ghost.js call made at boot before any viewer exists.
 * ================================================================ */

// Resume tap (§5.2): confirm the day's pool still matches the save, restore
// the run + sampler + play order, then re-enter the ordinary round flow. Does
// NOT re-fire daily_challenge_started (it fired before the reload; the funnel
// stays 1 started : 1 completed).
async function resumeChallenge() {
  $("btnDailyStart").disabled = true;
  $("dIntroErr").textContent = "";
  const held = resumeState;
  try {
    const pool = await loadPool();
    const poolCheckNow = poolCheck(await peekDayIds(runKey));
    const order = new PoolSampler(pool, dailySeed(held.run.key)).order;
    const places = inflightMatchesPool(held, poolCheckNow)
      ? placesFromCursors(order, held.cursors)
      : null;
    if (!places) {
      // Pool drift, or a cursor beyond the (shrunk) order: the persisted
      // indices can't be trusted. Discard and start today's five fresh.
      clearInflight(localStorage);
      track("daily_resumed", {
        day_number: runDayNum, rounds_done: held.run.rounds.length,
        hard: !!held.run.hard, action: "discarded",
      });
      resumeState = null;
      // F1 (Fable P1): the module-level `run` was built at boot with the
      // then-current mode; a HARD-run drift discard reaches startChallenge's
      // fresh path with `mode === "hard"` but a stale normal-flagged `run`
      // (hard:false), so re-mint it for the effective mode BEFORE the fresh
      // path uses it. Otherwise the fresh run runs the 30s-vs-60s clock wrong,
      // re-persists hard:false, and clobbers the NORMAL result slot at save
      // time. This is the ONE forced-fresh path left (an invalid/drifted save),
      // and it is silent — not a player-facing restart (owner directive).
      run = newDailyRun(runKey, mode === "hard");
      toast("Couldn't restore your earlier rounds — starting today's five fresh.");
      await startChallenge();   // resumeState is null now → the fresh path
      return;
    }
    // Restore the run and the sampler at the last locked-in cursor; startRound
    // re-derives and re-shows the image the player was on, with a full clock.
    run = held.run;
    mode = held.run.hard ? "hard" : "normal";
    cursors = held.cursors.slice();
    inflightPoolCheck = poolCheckNow;
    sampler = new PoolSampler(pool, dailySeed(held.run.key), cursors[cursors.length - 1]);
    playedPlaces.length = 0;
    playedPlaces.push(...places);
    const roundsDone = held.run.rounds.length;
    resumeState = null;
    track("daily_resumed", {
      day_number: runDayNum, rounds_done: roundsDone,
      hard: !!held.run.hard, action: "resume",
    });
    toast(`Picked up where you left off — round ${roundsDone + 1} of ${DAILY_ROUNDS}.`);
    await startRound();
  } catch (e) {
    console.error(scrubErrorMessage(e));
    // Any unexpected throw degrades to today's ordinary behavior (§8): the
    // resume affordance stays live so the player can retry continuing (the
    // only action offered — owner directive, no "Start over").
    resumeState = held;
    $("dIntroErr").textContent = "Couldn't load today's places — try again.";
    $("btnDailyStart").disabled = false;
  }
}

// Finalize rescue (§6): a crash on the round-5 reveal (or inside finishRun
// before the save) leaves a *complete* inflight and no saved result. Fold it
// exactly as finishRun's solo path does — save, records/streak/PB, the
// completed event — clear the slot, and render the full fresh-completion
// celebration (they did finish it). Rule 5.1-2 (a saved result discards the
// inflight) is what makes this fold un-repeatable across reloads.
async function finalizeInflight() {
  const held = resumeState;
  try {
    const completedRun = held.run;
    mode = completedRun.hard ? "hard" : "normal";
    run = completedRun;
    const applied = foldDailyRecords(completedRun);
    saveRecords(localStorage, records);
    clearInflight(localStorage);
    resumeState = null;
    const aces = completedRun.rounds.filter(
      (r) => typeof r.distanceKm === "number" && r.distanceKm < 1).length;
    const notable = applied.pb || aces > 0 ||
      (!completedRun.hard && applied.streak > 0 && applied.streak % 7 === 0);
    playSound(notable ? "championFanfare" : "fanfare");
    track("daily_challenge_completed", {
      day_number: runDayNum,
      score: completedRun.score,
      rounds_played: guessedRounds(completedRun),
      best_distance_km: bestDailyDistance(completedRun),
      hard: !!completedRun.hard,
      vs_ghost: false,
      streak: completedRun.hard ? records.streak.count : applied.streak,
      pb: applied.pb,
      aces,
      explore_ms: dailyExploreMs(completedRun),
    });
    track("daily_resumed", {
      day_number: runDayNum, rounds_done: DAILY_ROUNDS,
      hard: !!completedRun.hard, action: "resume",
    });
    // Rebuild the play order for the recap (best-effort: a failure here just
    // leaves the recap empty, never breaks the done screen).
    try {
      const pool = await loadPool();
      const order = new PoolSampler(pool, dailySeed(completedRun.key)).order;
      const places = placesFromCursors(order, held.cursors);
      if (places) { playedPlaces.length = 0; playedPlaces.push(...places); }
    } catch { /* recap just won't populate */ }
    renderDone(completedRun, false, {
      streakCount: applied.streak, graceUsed: applied.graceUsed,
      pb: applied.pb, aces, notable,
    });
  } catch (e) {
    console.error(scrubErrorMessage(e));
    // A broken finalize must never strand the player at a dead intro (§8).
    resumeState = null;
    $("btnDailyStart").disabled = false;
    $("btnDailyStart").textContent = mode === "hard"
      ? "Play hard mode ⚡" : "Play Today's Daily";
    showScreen("d-intro");
  }
}

// Owner directive 2026-08-29: "if you started you should only be allowed to
// continue." The player-facing "Start over" (a daily_resumed action=restart)
// has been REMOVED from the resume surface — the only forced-fresh path left is
// the silent invalid/drifted-save discard in resumeChallenge above
// (action=discarded), which is not a player-initiated restart.

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
      ? "Play hard mode ⚡" : "Play Today's Daily";
  }

  // Mid-run persistence (§7): a resume intro relabels the primary button as
  // the resume affordance (the label IS the indicator). The round number comes
  // from the save, not the (still empty) run object. Never on a duel
  // (resumeState is null for duel/exhibition). Owner directive 2026-08-29: the
  // resume surface offers exactly ONE action (continue) — there is no
  // "Start over" secondary any more.
  if (resumeState) {
    const roundsDone = resumeState.run.rounds.length;
    $("btnDailyStart").textContent =
      `Resume — round ${roundsDone + 1} of ${DAILY_ROUNDS}`;
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
  const numEl = $("dDailyNum");
  numEl.textContent = `#${runDayNum}${mode === "hard" ? "*" : ""}`;
  if (mode === "hard") {                       // gloss the "*" where it's born
    numEl.title = "Hard Mode";
    numEl.setAttribute("aria-label", `Daily #${runDayNum}, Hard Mode`);
  } else {
    numEl.removeAttribute("title");
    numEl.removeAttribute("aria-label");
  }
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

// Mid-run persistence (docs/daily-persistence-spec.md §5): read the inflight
// slot once, at boot, before any viewer exists. A solo mid-run save may belong
// to the HARD board (hard is entered only after the normal run completed, §4),
// so restore that board BEFORE reading the replay lock — otherwise the still-
// present normal result would shadow a legitimately in-flight hard run. Duel/
// exhibition runs never consult a solo save (§5.4) and must not destroy it
// (§5.1 rule 1): a usable duel link is routed by dailyEntryRoute, which
// outranks the slot and leaves it untouched.
const inflightState = loadInflight(localStorage, todayKey);
if (!isDuel && !isExhibition && inflightState && inflightState.run.hard) {
  mode = "hard";
}

// Replay lock: a completed run for the EFFECTIVE board (normal, or hard when a
// hard save is in flight) already exists.
const savedForRun = savedResultForRun();

// resolveInflight arbitrates the slot against that same-board saved result: a
// saved result discards the slot — the double-fold guard that keeps the
// finalize fold un-repeatable.
const inflightDisposition = resolveInflight({
  inflight: inflightState, hasSavedResult: !!savedForRun,
});
if (!isDuel && !isExhibition &&
    (inflightDisposition === "resume" || inflightDisposition === "finalize")) {
  resumeState = inflightState;
} else if (!isDuel && !isExhibition && inflightDisposition === "discard") {
  // F3 (Fable P3): a solo "discard" means a saved result already superseded
  // this slot — a crash that landed after saveDailyResult but before
  // clearInflight — or the slot was empty/stale. Either way the bytes must not
  // linger: a hard-flagged leftover would otherwise force the hard-board done
  // view at every boot for the rest of the day. Clear it through the same
  // storage seam. Duel/exhibition boots must NEVER touch the slot (§5.1 rule
  // 1), so they fall through here untouched.
  clearInflight(localStorage);
}

renderIntro();

if (ghostLinkReason === "malformed") {
  toast("That challenge link got damaged in transit — today's Daily is right here.");
} else if (ghostLinkReason === "version") {
  toast("This challenge needs a newer GeoParty — reload this page, then open the link again.");
} else if (ghostLinkReason === "expired") {
  toast("This challenge expired — the Daily is a fresh five every day.");
}

const bootRoute = dailyEntryRoute({
  hasSaved: !!savedForRun, isExhibition, isDuel, ghostOk: !!(ghost && ghost.ok),
  inflight: resumeState
    ? (inflightDisposition === "finalize" ? "complete" : "partial")
    : null,
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
  $("btnDailyStart").textContent = "Loading your challenge…";
  resolveSavedRun(savedForRun);
} else if (bootRoute === "done") {
  // Already played this board today, no usable duel — the plain done screen.
  resolveSavedRun(savedForRun);
} else if (bootRoute === "finalize") {
  // Mid-run persistence (§6): a complete inflight with no saved result — a
  // crash at the finish line. Fold it and show the full done screen. Neutralize
  // the intro button while the async fold runs (like the instant-verdict path).
  showScreen("d-intro");
  $("btnDailyStart").disabled = true;
  $("btnDailyStart").textContent = "Finishing your run…";
  finalizeInflight();
} else {
  // "resume" and "play" both land on the intro; the resume affordance is the
  // relabeled primary button — the single "continue" action (rendered by
  // renderIntro above).
  showScreen("d-intro");
}
