// viewer-ui.js — the instrumented MapillaryJS wrapper (field-observability
// plan §6). Thin browser glue: it constructs viewers, times every moveTo,
// classifies every rejection through js/imagery.js (pure, tested), and turns
// the result into a consent-gated PostHog event/exception.
//
// Migration invariant: NO BEHAVIOR CHANGE. Every caller's catch, skip, toast
// and fallback stays exactly as it was — the wrapper only observes. The one
// deliberate addition the plan specifies is the per-purpose timeout race
// (§6.1): a moveTo that never settles now rejects instead of hanging, and a
// late SDK completion still corrects the record with
// `imagery_load {ok:true, after_timeout:true}`.
//
// Everything decision-shaped lives in imagery.js; everything capture-shaped
// goes through consent.js, so nothing here can fire before opt-in.

import { MAPILLARY_TOKEN } from "../config.js";
import { track, trackError, startRecording } from "./consent.js";
import { makeImageryError } from "./analytics.js";
import {
  classifyImageryError,
  errorMessage,
  poolDiagId,
  isDeadEntryClass,
  imageryTimeoutMs,
  createExceptionBudget,
  createDedup,
  createImageryLog,
  createPanoSession,
  foldPanoEvent,
  panoSessionProps,
  extractEdgeCounts,
  classifySessionHealth,
  shouldForceRecordingForLoad,
  isFailureClass,
  chaosAllowed,
  createEdgeRecovery,
  decideEdgeRecovery,
  edgeRecoveryStopped,
  classifyEdgeRecoveryOutcome,
  directionComponentConfig,
  EDGE_RECOVERY_MAX_ATTEMPTS,
  EDGE_RECOVERY_GRACE_MS,
  EDGE_RECOVERY_RECHECK_MS,
  EDGE_RECOVERY_BACKOFF_MS,
} from "./imagery.js";

// Keep in sync with the pinned <script> tag in *.html (unpkg mapillary-js).
const MAPILLARY_SDK = "4.1.2";

const now = () => (typeof performance !== "undefined" && performance.now
  ? performance.now()
  : Date.now());

/* ================================================================
 * Session-scoped observability state (one per page load)
 * ================================================================ */

// `let`, not `const`, ONLY so __resetSessionForTests can rebuild them between
// tests (the singletons are otherwise never reassigned in production). Every
// consumer reads the live module binding, so a reset is seen immediately.
let budget = createExceptionBudget();          // §7.4 caps
let deadDedup = createDedup();                 // one image_dead per entry
let log = createImageryLog(20);                // report ring buffer
let facts = freshFacts();                      // §9.1 health inputs

function freshFacts() {
  return {
    viewerInits: [], loads: [], panos: [], exceptions: [],
    reports: 0, roundsIncomplete: false,
  };
}

// Test-only: the module holds one session's worth of accumulated facts by
// design (one page load = one session). Node's test runner shares a module
// instance across a whole file, so without this the facts/budget/dedup would
// carry across tests and make assertions order-dependent (review P2-3).
// Named to make its test-only purpose unmistakable; never called in prod.
export function __resetSessionForTests() {
  budget = createExceptionBudget();
  deadDedup = createDedup();
  log = createImageryLog(20);
  facts = freshFacts();
}

const FACT_MAX = 60; // bounded: a long party must not grow this unboundedly
function pushFact(list, item) {
  list.push(item);
  while (list.length > FACT_MAX) list.shift();
}

// Read by report-ui.js to build the diagnostic bundle.
export function imagerySession() {
  return {
    log,
    facts,
    health: () => classifySessionHealth(facts),
    netType: netType(),
    online: isOnline(),
  };
}

export function noteReportSent() { facts.reports += 1; }

// `facts.roundsIncomplete` (§9.1's "rounds progress normally" clause) has no
// client-side setter on purpose: an in-flight round would always set it, and
// a player who simply quit is product abandonment, not an imagery failure.
// The rule lives in classifySessionHealth for the dashboard-side definition
// (panel 12), where round completion is actually knowable after the fact.

function netType() {
  const c = typeof navigator !== "undefined" &&
    (navigator.connection || navigator.mozConnection || navigator.webkitConnection);
  return (c && typeof c.effectiveType === "string") ? c.effectiveType : "unknown";
}

function isOnline() {
  if (typeof navigator === "undefined") return true;
  if (chaos() && chaos().offline === true) return false;
  return navigator.onLine !== false;
}

/* ================================================================
 * §15 chaos hooks — inert anywhere but a local dev host
 * ================================================================ */

function chaos() {
  if (typeof window === "undefined") return null;
  const host = (typeof location !== "undefined" && location.hostname) || "";
  if (!chaosAllowed(host)) return null;
  return window.__gpChaos || null;
}

// Local harness handle: the failure-injection checklist needs to reach a live
// viewer (e.g. to dispatch webglcontextlost on its canvas). Attached only on
// a dev host — a production page exposes nothing.
function registerForChaos(iv) {
  if (typeof window === "undefined") return;
  const host = (typeof location !== "undefined" && location.hostname) || "";
  if (!chaosAllowed(host)) return;
  window.__gpViewers = window.__gpViewers || [];
  window.__gpViewers.push(iv);
}

/* ================================================================
 * Capture helpers — every one of these is a consent-gated no-op without
 * opt-in (track/trackError enforce it; nothing here checks consent itself).
 * ================================================================ */

function emitLoad(props) {
  const clean = { net_type: netType(), online: isOnline(), ...props };
  pushFact(facts.loads, clean);
  track("imagery_load", clean);
  if (shouldForceRecordingForLoad(clean)) startRecording();
}

// One classified exception, subject to the §7.4 caps and the per-entry
// dedup. `cancelled` never reaches here (isFailureClass rejects it).
function emitException(errorClass, rawMessage, props) {
  if (!isFailureClass(errorClass)) return false;
  pushFact(facts.exceptions, { error_class: errorClass });
  if (errorClass === "image_dead" &&
      !deadDedup.first(`image_dead:${props.pool_entry || ""}`)) {
    return false;
  }
  if (!budget.allow(errorClass)) return false;
  return trackError(
    makeImageryError(errorClass, rawMessage),
    { net_type: netType(), online: isOnline(), ...props },
  );
}

/* ================================================================
 * createViewer — one instrumented viewer per surface
 * ================================================================ */

// A viewer that could not be constructed. Callers' existing degradation
// paths (try/catch, "imagery failed" toasts, gradient fallbacks) handle it;
// every moveTo rejects with the same classified error.
function stubViewer(surface, errorClass) {
  const err = () => {
    const e = new Error(`viewer unavailable (${errorClass})`);
    e.gpErrorClass = errorClass;
    return e;
  };
  return {
    ok: false,
    surface,
    viewer: null,
    errorClass,
    moveEnabled: false,
    moveTo: () => Promise.reject(err()),
    attempt: () => Promise.resolve({
      ok: false, errorClass, durationMs: 0, afterTimeout: false, err: err(),
    }),
    beginRound() {},
    endRound() {},
    noteReanchor() {},
    session: () => null,
    setMoveAllowed(allowed) { this.moveEnabled = allowed === true; },
    reassertMove() {},
    resize() {},
    destroy() {},
  };
}

export function createViewer({ surface, container, component, moveAllowed }) {
  const t0 = now();
  const c = chaos();

  if (typeof mapillary === "undefined") {
    // The SDK script itself never loaded (blocked CDN, offline, file://).
    // Nothing to send but the classified init failure — and if PostHog is
    // blocked too, even that is a silent no-op, exactly as today.
    reportInit(surface, false, "viewer_init", t0, true, "mapillary sdk missing");
    return stubViewer(surface, "viewer_init");
  }

  const supported = c && c.webglUnsupported === true
    ? false
    : typeof mapillary.isSupported !== "function" || mapillary.isSupported();

  if (!supported) {
    reportInit(surface, false, "webgl_unavailable", t0, false, "webgl unavailable");
    return stubViewer(surface, "webgl_unavailable");
  }

  let raw;
  try {
    if (c && c.failInit === true) throw new Error("chaos: forced viewer_init failure");
    const resolvedComponent = {
      ...component,
      direction: directionComponentConfig(component.direction),
    };
    raw = new mapillary.Viewer({
      accessToken: MAPILLARY_TOKEN,
      container,
      component: resolvedComponent,
    });
  } catch (e) {
    const cls = classifyImageryError(e, { phase: "init", online: isOnline() });
    reportInit(surface, false, cls, t0, supported, errorMessage(e));
    return stubViewer(surface, cls);
  }

  reportInit(surface, true, null, t0, supported, "");
  const iv = instrument({ surface, container, viewer: raw });
  iv.moveEnabled = moveAllowed === true;
  registerForChaos(iv);
  return iv;
}

function reportInit(surface, ok, errorClass, t0, webgl, rawMessage) {
  const duration_ms = Math.round(now() - t0);
  const props = {
    surface, ok, duration_ms, webgl: webgl !== false, sdk: MAPILLARY_SDK,
  };
  if (!ok && errorClass) props.error_class = errorClass;
  pushFact(facts.viewerInits, { ok, error_class: errorClass || null });
  track("viewer_init", props);
  if (!ok) {
    log.record({ error_class: errorClass, surface, pool_entry: "" });
    emitException(errorClass, rawMessage, { surface, purpose: "anchor", error_class: errorClass, webgl: webgl !== false });
    startRecording();
  }
}

/* ================================================================
 * The instrumented viewer
 * ================================================================ */

function instrument({ surface, container, viewer }) {
  let pano = null;             // open pano_session fold, or null
  let expectImage = null;      // image id our own moveTo is steering toward
  let destroyed = false;
  // Issue #2: edge counts observed before a round opened (the initial image
  // event can fire before our beginRound call). Held here and seeded into the
  // round fold at beginRound, then cleared at endRound so the next round never
  // inherits the previous anchor's edges. Never contains an id or coordinate.
  let pendingEdges = { spatial: null, sequence: null };
  // Issue #2 Phase 2: the live image ref (never serialized — only
  // extractEdgeCounts ever reads it) and the bounded setFilter() recovery
  // state. Cleared/cancelled in endRound()/destroy()/any new attempt().
  let lastImage = null;
  let edgeRecovery = null;
  let edgeRecoveryTimer = null;
  let pendingEdgeRecoveryTick = null;
  let anchorImageId = null;
  let recoveryRoundNumber = 0;
  let inFlightCount = 0;

  // #5 movement-lever state. activateComponent can throw when the viewer is not
  // laid out yet; historically that was swallowed and the movement controls
  // stayed dead for the whole round. Now a failed apply schedules one retry AND
  // reassertMove()/setMoveAllowed on a later render re-drives it.
  let desiredMove = false;
  let moveApplied = true;
  let moveRetryTimer = null;
  function applyMove() {
    let ok = true;
    for (const name of ["direction", "sequence", "keyboard"]) {
      try {
        if (desiredMove) viewer.activateComponent(name);
        else viewer.deactivateComponent(name);
      } catch { ok = false; /* SDK build without this component, or not ready */ }
    }
    moveApplied = ok;
    if (!ok && moveRetryTimer === null && typeof setTimeout !== "undefined") {
      // A component wasn't ready (viewer mid-layout): retry once shortly so a
      // transient failure doesn't strand movement for the round.
      moveRetryTimer = setTimeout(() => {
        moveRetryTimer = null;
        if (!destroyed && !moveApplied) applyMove();
      }, 300);
    }
    return ok;
  }

  const on = (name, fn) => {
    try { viewer.on(name, fn); } catch { /* SDK build without this event */ }
  };

  on("pov", () => { pano = foldPanoEvent(pano, { type: "look", at: now() }); });
  on("fov", () => { pano = foldPanoEvent(pano, { type: "zoom", at: now() }); });
  on("navigable", (ev) => {
    const value = ev && typeof ev.navigable === "boolean" ? ev.navigable : true;
    pano = foldPanoEvent(pano, { type: "navigable", value });
  });
  on("image", (ev) => {
    const id = ev && ev.image && ev.image.id;
    // An image change we did NOT ask for is the user navigating (arrow
    // clicks are internal to the SDK and never reach our moveTo).
    if (id && id !== expectImage) {
      pano = foldPanoEvent(pano, { type: "nav_move", at: now() });
    }
    // Issue #2 Phase 2: latch the LIVE image ref (never cloned) — a later
    // setFilter() recovery re-reads spatialEdges/sequenceEdges off this same
    // object, since a recovered status renders with no further "image" event.
    if (ev && ev.image && typeof ev.image === "object") lastImage = ev.image;
    observeEdges(ev);
  });

  // Issue #2: read the image's spatial/sequence edge counts (bounded, opaque
  // aggregates — never an id, coordinate, or edge payload) and latch them.
  // Fold into the open round if there is one; otherwise hold them so the first
  // beginRound seeds the anchor's edges even when the initial image event beat
  // our beginRound call. An UNKNOWN (uncached) count is ignored, never zeroed.
  function observeEdges(ev) {
    const counts = extractEdgeCounts(ev);
    if (counts.spatial === null && counts.sequence === null) return;
    if (counts.spatial !== null) pendingEdges.spatial = counts.spatial;
    if (counts.sequence !== null) pendingEdges.sequence = counts.sequence;
    if (pano) {
      pano = foldPanoEvent(pano, {
        type: "edges", spatial: counts.spatial, sequence: counts.sequence,
        at: now(),
      });
    }
  }

  /* Issue #2 Phase 2 (docs/issue-2-phase2-fix.md): bounded spatial-edge
   * cache recovery. All timers route through one scheduleTick() so a single
   * test-only seam (__edgeRecoveryTickForTests) can drive the whole state
   * machine without ever sleeping. §15 chaos may override the three delays
   * on a dev host; inert in production like every chaos hook. */
  function edgeRecoveryDelays() {
    const c = chaos();
    const over = (c && c.edgeRecoveryMs) || {};
    return {
      grace: Number.isFinite(over.grace) ? over.grace : EDGE_RECOVERY_GRACE_MS,
      recheck: Number.isFinite(over.recheck) ? over.recheck : EDGE_RECOVERY_RECHECK_MS,
      backoff: Number.isFinite(over.backoff) ? over.backoff : EDGE_RECOVERY_BACKOFF_MS,
    };
  }

  function cancelEdgeRecoveryTimer() {
    if (edgeRecoveryTimer !== null) { clearTimeout(edgeRecoveryTimer); edgeRecoveryTimer = null; }
    pendingEdgeRecoveryTick = null;
  }

  function scheduleTick(fn, ms) {
    cancelEdgeRecoveryTimer();
    pendingEdgeRecoveryTick = fn;
    if (typeof setTimeout === "undefined") return;
    edgeRecoveryTimer = setTimeout(() => {
      edgeRecoveryTimer = null;
      const f = pendingEdgeRecoveryTick;
      pendingEdgeRecoveryTick = null;
      if (f) f();
    }, ms);
  }

  // Arm on anchor/resume success. Replaces any previous state/timer —
  // idempotent per anchor; a re-anchor restarts cleanly.
  function armEdgeRecovery(imageId, roundNumber) {
    cancelEdgeRecoveryTimer();
    edgeRecovery = createEdgeRecovery();
    anchorImageId = imageId;
    recoveryRoundNumber = roundNumber;
    scheduleTick(edgeRecoveryTick, edgeRecoveryDelays().grace);
  }

  function edgeRecoveryCtx() {
    const counts = extractEdgeCounts(lastImage);
    const currentId = lastImage && typeof lastImage === "object" ? lastImage.id : null;
    return {
      viewerOk: iv.ok === true,
      canSetFilter: typeof viewer.setFilter === "function",
      moveEnabled: iv.moveEnabled === true,
      inFlight: inFlightCount > 0,
      userNavigated: Boolean(pano) && (
        pano.nav_moves > 0 ||
        (currentId != null && anchorImageId != null && currentId !== anchorImageId)
      ),
      spatial: counts.spatial,
    };
  }

  function edgeRecoveryTick() {
    if (!edgeRecovery) return;
    const decision = decideEdgeRecovery(edgeRecovery, edgeRecoveryCtx());
    if (decision.act === "stop") {
      edgeRecovery = edgeRecoveryStopped(edgeRecovery);
      return; // no event for edges_present/etc — silence is the healthy path
    }
    if (decision.act === "skip") return; // never reschedules beyond the planned ticks
    runEdgeRecoveryAttempt(decision.trigger);
  }

  function runEdgeRecoveryAttempt(trigger) {
    const state = edgeRecovery;
    if (!state) return;
    state.attempts += 1;
    const attemptNumber = state.attempts;
    const roundNumber = recoveryRoundNumber;
    const t0 = now();
    let settleP;
    try {
      settleP = Promise.resolve(viewer.setFilter());
    } catch {
      settleP = Promise.reject(new Error("setFilter threw"));
    }
    settleP.then(() => false, () => true).then((failed) => {
      // A round transition (or a fresh re-arm) may have replaced `edgeRecovery`
      // while setFilter() was in flight — never let a stale attempt schedule
      // a tick for whatever round/state is now live.
      if (edgeRecovery !== state) return;
      scheduleTick(
        () => finishEdgeRecoveryAttempt(state, attemptNumber, trigger, t0, roundNumber, failed),
        edgeRecoveryDelays().recheck,
      );
    });
  }

  function finishEdgeRecoveryAttempt(state, attemptNumber, trigger, t0, roundNumber, setFilterFailed) {
    if (edgeRecovery !== state) return;
    const counts = extractEdgeCounts(lastImage);
    const outcome = classifyEdgeRecoveryOutcome(counts.spatial, setFilterFailed);
    const props = {
      surface, round_number: roundNumber, attempt: attemptNumber, trigger,
      result: outcome, duration_ms: Math.round(now() - t0),
      net_type: netType(), online: isOnline(),
    };
    if (counts.spatial !== null) props.spatial_after = counts.spatial;
    if (counts.sequence !== null) props.sequence_after = counts.sequence;
    track("edge_recovery", props);
    if (pano) {
      pano = foldPanoEvent(pano, { type: "edge_recovery_attempt", at: now() });
      // Only feed the anchor's edges latch (Phase 1's anchor_spatial_edges)
      // on the LAST attempt that will ever run for this round — recovered,
      // or attempts just ran out. An interim "no_change" reading (attempt 1
      // routinely converts uncached to a cached-zero WITHOUT a real fetch,
      // §C correction 1) must never latch a stale 0 that then blocks
      // attempt 2's real, recovered count from ever backfilling it (the
      // edges fold keeps the FIRST known value, never overwrites it).
      const isFinalAttempt = outcome === "recovered" || attemptNumber >= EDGE_RECOVERY_MAX_ATTEMPTS;
      if (isFinalAttempt && (counts.spatial !== null || counts.sequence !== null)) {
        pano = foldPanoEvent(pano, {
          type: "edges", spatial: counts.spatial, sequence: counts.sequence, at: now(),
        });
      }
    }
    if (outcome === "recovered") {
      edgeRecovery = edgeRecoveryStopped(edgeRecovery);
      return;
    }
    // Not recovered and attempts may remain — the NEXT tick's own
    // decideEdgeRecovery call is what enforces attempts_exhausted; no
    // duplicate cap check here (the pure state machine is the one place the
    // bound lives).
    scheduleTick(edgeRecoveryTick, edgeRecoveryDelays().backoff);
  }

  // Pointer activity with zero pov change is the only gesture_blocked signal
  // we have (§5). Capture phase on the container: an overlay ABOVE the
  // container still hides it — documented limit, not a bug.
  const el = typeof document !== "undefined" && typeof container === "string"
    ? document.getElementById(container)
    : container;
  const onPointerDown = () => {
    pano = foldPanoEvent(pano, { type: "pointer_down", at: now() });
  };
  if (el && el.addEventListener) {
    el.addEventListener("pointerdown", onPointerDown, true);
  }

  // GPU/memory pressure kills the WebGL context: the viewer renders nothing
  // from here on, and today that is completely silent.
  const onContextLost = () => {
    emitException("webgl_context_lost", "webglcontextlost", {
      surface, error_class: "webgl_context_lost", webgl: true,
    });
    log.record({ error_class: "webgl_context_lost", surface, pool_entry: "" });
    startRecording();
  };
  let canvas = null;
  const attachCanvas = () => {
    if (canvas || !el || !el.querySelector) return;
    canvas = el.querySelector("canvas");
    if (canvas) canvas.addEventListener("webglcontextlost", onContextLost);
  };
  attachCanvas();
  const canvasTimer = typeof setTimeout !== "undefined"
    ? setTimeout(attachCanvas, 1500) : null;

  /* Round-transition cover (§ overnight bundle #4). A round-anchor moveTo can
   * take up to 20s (SLOW_TIMEOUT_MS); until it settles, the container still
   * holds the PREVIOUS round's panorama at the previous zoom. Left visible,
   * latency exposes stale state — the player studies last round's street.
   * So an anchor/resume load resets the view and drops an opaque cover over the
   * pano BEFORE the move, and lifts it only when the new image actually
   * arrives. A genuine failure leaves the cover up (the caller's failure
   * overlay/map fallback takes over) — the stale pano is never re-exposed.
   * The cover lives INSIDE the container, below the HUD/action-bar siblings,
   * so the timer and Make Guess stay usable while imagery loads. */
  let coverEl = null;
  function ensureCover() {
    if (coverEl) return coverEl;
    if (!el || typeof document === "undefined" || !document.createElement) {
      return null;
    }
    coverEl = document.createElement("div");
    coverEl.className = "pano-cover hidden";
    if (el.appendChild) el.appendChild(coverEl);
    return coverEl;
  }
  function showCover() {
    const c = ensureCover();
    if (c && c.classList) c.classList.remove("hidden");
  }
  function hideCover() {
    if (coverEl && coverEl.classList) coverEl.classList.add("hidden");
  }
  // Neutralize the previous round's zoom/center so the new image never inherits
  // it. SDK-tolerant: a viewer between images may not accept these yet.
  function resetView() {
    try { if (viewer.setCenter) viewer.setCenter([0.5, 0.5]); } catch { /* between images */ }
    try { if (viewer.setZoom) viewer.setZoom(0); } catch { /* between images */ }
  }
  // Only round-anchor transitions cover: nav (user movement), follow (TV
  // mirroring), seed/hero (decorative) must never blank the pano.
  const coversRound = (purpose) => purpose === "anchor" || purpose === "resume";

  // One attempt: timed, timeout-raced, classified, exception-captured.
  // NEVER rejects — it resolves a result record, so the skip loop and the
  // single-shot path can both decide what to emit.
  function attempt(imageId, purpose) {
    const t0 = now();
    const poolEntry = poolDiagId(imageId);
    const c = chaos();
    // Issue #2 Phase 2: a new load (any purpose) supersedes any pending
    // recovery tick — the viewer state it was checking is about to change.
    cancelEdgeRecoveryTimer();
    inFlightCount += 1;
    // §15: the injection harness may shorten the budget on a dev host so a
    // timeout scenario doesn't take 20 real seconds. Inert in production.
    const limit = c && Number.isFinite(c.timeoutMs)
      ? c.timeoutMs
      : imageryTimeoutMs(purpose);
    let timedOut = false;
    let settled = false;

    // #4: reset the view and cover the old pano BEFORE a round-anchor move, so
    // the previous round's street (at the previous zoom) is never on screen
    // while the new image loads. The cover lifts only when the image arrives.
    if (coversRound(purpose)) { resetView(); showCover(); }

    const injected = c && typeof c.moveTo === "function"
      ? c.moveTo(imageId, purpose)
      : null;

    expectImage = imageId;
    const real = injected || Promise.resolve().then(() => viewer.moveTo(imageId));

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        settled = true;
        finish(false, new Error(`imagery timed out after ${limit}ms`));
      }, limit);

      function finish(ok, err) {
        clearTimeout(timer);
        const durationMs = Math.round(now() - t0);
        if (ok) {
          resolve({ ok: true, errorClass: null, durationMs, afterTimeout: false, poolEntry });
          return;
        }
        const errorClass = classifyImageryError(err, {
          online: isOnline(), timedOut, phase: "move",
        });
        log.record({ error_class: errorClass, surface, pool_entry: poolEntry });
        if (purpose === "nav") {
          pano = foldPanoEvent(pano, { type: "nav_failure", at: now() });
        }
        emitException(errorClass, errorMessage(err), {
          surface, purpose, error_class: errorClass,
          pool_entry: poolEntry, duration_ms: durationMs,
        });
        resolve({ ok: false, errorClass, durationMs, afterTimeout: timedOut, err, poolEntry });
      }

      real.then(
        () => {
          inFlightCount = Math.max(0, inFlightCount - 1);
          // The image actually arrived: reveal it (whether on time or late).
          if (coversRound(purpose)) {
            hideCover();
            // Issue #2 Phase 2: arm bounded recovery on every round-anchor
            // success (on time or late) — idempotent per anchor.
            armEdgeRecovery(imageId,
              pano && Number.isFinite(pano.round_number) ? pano.round_number : 0);
          }
          if (settled) {
            // The SDK finished late: correct the record rather than leave a
            // timeout standing against a load that actually worked (§6.1).
            emitLoad({
              surface, purpose, ok: true, after_timeout: true,
              duration_ms: Math.round(now() - t0), skips: 0,
              pool_entry: poolEntry,
            });
            return;
          }
          settled = true;
          finish(true, null);
        },
        (err) => {
          inFlightCount = Math.max(0, inFlightCount - 1);
          // A genuine rejection leaves the cover UP — the caller's failure
          // overlay / "guess from the map" fallback takes the surface; a stale
          // pano must never be re-exposed on a failed round-anchor load.
          if (settled) return;   // already timed out; the timeout owns it
          settled = true;
          finish(false, err);
        },
      );
    });
  }

  const iv = {
    ok: true,
    surface,
    viewer,
    errorClass: null,

    attempt,

    // Instrumented moveTo. Emits exactly one imagery_load, then rethrows the
    // ORIGINAL rejection so every existing catch behaves identically.
    moveTo(imageId, purpose) {
      const p = purpose || "nav";
      return attempt(imageId, p).then((r) => {
        const props = {
          surface, purpose: p, ok: r.ok, skips: 0,
          duration_ms: r.durationMs, pool_entry: r.poolEntry,
        };
        if (!r.ok) props.error_class = r.errorClass;
        if (r.afterTimeout) props.after_timeout = true;
        emitLoad(props);
        if (r.ok) return undefined;
        throw r.err;
      });
    },

    // pano_session lifecycle (§7.1): one fold per (surface, round).
    beginRound(roundNumber) {
      iv.endRound();
      pano = createPanoSession({ surface, roundNumber, startedAt: now() });
      // Issue #2: seed the anchor's edge availability from any image/edge state
      // latched before this round opened — the initial image before round 1, or
      // SDK ordering that fired an edge observation ahead of our beginRound.
      if (pendingEdges.spatial !== null || pendingEdges.sequence !== null) {
        pano = foldPanoEvent(pano, {
          type: "edges", spatial: pendingEdges.spatial,
          sequence: pendingEdges.sequence, at: now(),
        });
      }
    },
    endRound() {
      // Issue #2 Phase 2: a round leaving play cancels any pending recovery
      // and drops the live image latch, unconditionally — before the pano
      // early-return below, since destroy()/a pre-round-1 call must cancel
      // too even when no pano was ever open.
      cancelEdgeRecoveryTimer();
      edgeRecovery = null;
      lastImage = null;
      if (!pano) return;
      const props = panoSessionProps(pano);
      pushFact(facts.panos, {
        nav_available: pano.nav_available,
        nav_failures: pano.nav_failures,
        pointer_downs: pano.pointer_downs,
        looks: pano.looks,
        move_enabled: Boolean(iv.moveEnabled),
      });
      track("pano_session", props);
      pano = null;
      // Clear the latch so the NEXT round never inherits this anchor's edges;
      // the early return above preserves a pre-round-1 latch (pano is null then)
      // so the initial image still seeds beginRound(1).
      pendingEdges = { spatial: null, sequence: null };
    },
    noteReanchor() {
      pano = foldPanoEvent(pano, { type: "reanchor", at: now() });
    },
    session: () => pano,

    // Whether street movement is enabled for this surface — the health model
    // only counts navigation failures where navigation was offered (§9.1).
    moveEnabled: false,

    // G2 Frozen / G6 Hard: toggle street navigation mid-surface by
    // (de)activating the direction/sequence/keyboard components. The ONLY
    // legal place to touch the viewer's components (CLAUDE.md). Idempotent and
    // SDK-build-tolerant; a failed activation retries (see applyMove) so the
    // movement controls can't be silently stranded for the round.
    setMoveAllowed(allowed) {
      iv.moveEnabled = allowed === true;
      desiredMove = allowed === true;
      applyMove();
    },

    // Re-drive the movement lever on a later active-round render. A no-op when
    // the last apply already stuck (so it never re-toggles a healthy viewer);
    // it re-applies only when a previous activation had thrown.
    reassertMove() {
      if (!moveApplied) applyMove();
    },

    resize() {
      try { viewer.resize(); } catch { /* not laid out yet */ }
    },

    // Test-only seam (Issue #2 Phase 2): synchronously runs one due edge-
    // recovery tick, same convention as __resetSessionForTests. Never called
    // in production.
    __edgeRecoveryTickForTests() {
      if (edgeRecoveryTimer !== null) { clearTimeout(edgeRecoveryTimer); edgeRecoveryTimer = null; }
      const f = pendingEdgeRecoveryTick;
      pendingEdgeRecoveryTick = null;
      if (f) f();
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      iv.endRound();
      if (canvasTimer) clearTimeout(canvasTimer);
      if (moveRetryTimer) { clearTimeout(moveRetryTimer); moveRetryTimer = null; }
      if (canvas) canvas.removeEventListener("webglcontextlost", onContextLost);
      if (el && el.removeEventListener) {
        el.removeEventListener("pointerdown", onPointerDown, true);
      }
      if (coverEl && coverEl.remove) { try { coverEl.remove(); } catch { /* gone */ } }
      coverEl = null;
      try { viewer.remove(); } catch { /* already gone */ }
      if (typeof window !== "undefined" && Array.isArray(window.__gpViewers)) {
        const i = window.__gpViewers.indexOf(iv);
        if (i >= 0) window.__gpViewers.splice(i, 1);
      }
    },
  };
  return iv;
}

/* ================================================================
 * loadRoundImage — the one shared dead-image skip loop (was copy-pasted
 * three times). Peek, try, and then either:
 *   - success       → { entry, skips, degraded: false }
 *   - dead entry    → skip (advance the seeded sampler) and try the next
 *   - pool exhausted → { entry: null, skips, degraded: false }  (finish/end)
 *   - RETRYABLE     → { entry: null, degraded: true }  (do NOT finish/end)
 *
 * The `degraded` flag is the stabilization contract (review P1-3/P2-1/P2-5).
 * It is true when imagery failed in a way the CALLER must treat as retryable
 * and MUST NOT let consume a Daily run, finish a couch game, or push h2h to
 * gameOver:
 *   - the viewer is a stub (iv.ok === false: SDK blocked, WebGL off, offline,
 *     constructor threw) — every attempt would reject, so we consume nothing;
 *   - a live seeded entry failed on a TRANSIENT class (timeout, offline, rate
 *     limit, server, auth, webgl, unknown). Skipping past a live entry there
 *     both desyncs the Daily's shared order and burns the pool for nothing, so
 *     we keep the same entry and hand the caller a retryable state instead.
 * Only a genuinely exhausted pool (every remaining entry provably dead) still
 * returns the classic `entry: null, degraded: false` the finish paths expect.
 * ================================================================ */

export async function loadRoundImage(sampler, iv, purpose) {
  const p = purpose || "anchor";
  let entry = sampler.peek();
  let skips = 0;

  // The viewer itself is a stub (no WebGL, SDK blocked, offline, constructor
  // failure): every attempt would reject, so retrying would grind through the
  // entire 5,000-entry pool for nothing. Report the real cause once and hand
  // back a RETRYABLE degraded result — not one pool entry is consumed, and no
  // caller may treat this as exhaustion. viewer_init already recorded the
  // hard-failure fact, so this load is intentionally NOT tagged `exhausted`.
  if (iv.ok === false) {
    emitLoad({
      surface: iv.surface, purpose: p, ok: false, skips: 0, duration_ms: 0,
      error_class: iv.errorClass || "viewer_init",
      pool_entry: entry ? poolDiagId(entry.image_id) : "",
    });
    return { entry: null, skips: 0, degraded: true };
  }

  while (entry) {
    // eslint-disable-next-line no-await-in-loop
    const r = await iv.attempt(entry.image_id, p);
    if (r.ok) {
      emitLoad({
        surface: iv.surface, purpose: p, ok: true, skips,
        duration_ms: r.durationMs, pool_entry: r.poolEntry,
        ...(r.afterTimeout ? { after_timeout: true } : {}),
      });
      return { entry, skips, degraded: false };
    }

    // Transient/environmental failure on a LIVE seeded entry: do not advance
    // the sampler (keeps the Daily's five identical for everyone) and do not
    // consume the round. emitLoad(ok:false) still forces the recording and
    // feeds the health fold; the console line carries the opaque diag id only.
    if (!isDeadEntryClass(r.errorClass)) {
      console.warn(
        `Pool entry ${r.poolEntry} did not load (${r.errorClass}) — retryable`,
      );
      emitLoad({
        surface: iv.surface, purpose: p, ok: false, skips,
        duration_ms: r.durationMs, error_class: r.errorClass,
        pool_entry: r.poolEntry,
      });
      return { entry: null, skips, degraded: true };
    }

    // A provably dead entry: skip it deterministically — every device on the
    // same seed skips the same entry to the same next spot. The console line
    // the replays show carries the diag id, never the raw image id.
    console.warn(
      `Pool entry ${r.poolEntry} failed to load (${r.errorClass}), skipping`,
    );
    skips++;
    entry = sampler.advance();
  }

  // Pool exhausted: every remaining entry was provably dead — the player has
  // no playable panorama for this round (the "failed" health class). This is
  // the ONLY null-entry case the finish/end paths should act on. `exhausted`
  // is a local health-fold fact; the schema strips it, so it never leaves.
  emitLoad({
    surface: iv.surface, purpose: p, ok: false, skips, exhausted: true,
    duration_ms: 0, error_class: "image_dead", pool_entry: "",
  });
  startRecording();
  return { entry: null, skips, degraded: false };
}
