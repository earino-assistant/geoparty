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
  navigationArrowsVisible,
  decideNavHint,
  navHintBaselineCleared,
  NAV_HINT_MAX_MS,
  NAV_HINT_POLL_MS,
  classifyRenderProbe,
  createRenderWatch,
  renderWatchProbed,
  renderWatchStopped,
  decideRenderProbe,
  createRenderRecovery,
  renderRecoveryUsed,
  renderRecoveryRoundReset,
  decideRenderRecovery,
  classifyRenderOutcome,
  RENDER_PROBE_FIRST_MS,
  RENDER_PROBE_SECOND_MS,
  RENDER_PROBE_VISIBLE_MS,
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
  // §7 live-fire harness: __gpChaos.killContext(idx?) kills a live viewer's
  // WebGL context exactly as the iOS jetsam path does (WEBGL_lose_context),
  // driving the whole detect→emit→rebuild→resume pipeline on a real device.
  // Dev-host only (we are already inside the chaosAllowed guard).
  window.__gpChaos = window.__gpChaos || {};
  window.__gpChaos.killContext = (idx) => {
    const t = window.__gpViewers[idx || 0];
    return t && typeof t.__chaosKillContext === "function"
      ? t.__chaosKillContext() : false;
  };
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

export function createViewer({ surface, container, component, moveAllowed, onRecovery }) {
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
  const iv = instrument({ surface, container, component, viewer: raw, onRecovery });
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

function instrument({ surface, container, component, viewer: rawViewer, onRecovery }) {
  // `viewer` is a mutable binding, not a parameter: §18's in-place rebuild
  // replaces the raw SDK viewer BEHIND the stable `iv` façade (§3.1), so every
  // internal reference and every rebound on(...) handler follows the swap.
  let viewer = rawViewer;
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

  // Autoplay ("play" mode) lives on the Navigator's PlayService, NOT the
  // sequence component — component.stop() -> configure({playing:false}) only
  // reaches the PlayService while the component is still ACTIVE. Deactivating
  // the sequence component (Frozen/Hard, below) tears down the config
  // subscription but never stops a running PlayService, so it keeps advancing
  // the camera forever. Must be called BEFORE the deactivate loop, while the
  // component is still active. Idempotent and SDK-build-tolerant.
  function stopPlay() {
    try {
      const seq = typeof viewer.getComponent === "function"
        ? viewer.getComponent("sequence") : null;
      if (seq && typeof seq.stop === "function") seq.stop();
    } catch { /* SDK build without a sequence component, or not laid out yet */ }
  }

  function applyMove() {
    stopPlay();
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

  // Collected so §18's rebuild can re-run them against the replacement viewer
  // (they close over the mutable `viewer` binding but must be re-registered on
  // the new SDK instance). Called once at construction, again after a rebuild.
  function bindViewerHandlers() {
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
  }
  bindViewerHandlers();

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
        () => refreshLastImageThen(state,
          () => finishEdgeRecoveryAttempt(state, attemptNumber, trigger, t0, roundNumber, failed)),
        edgeRecoveryDelays().recheck,
      );
    });
  }

  // Phase 3 correction (docs/issue-2-phase2-fix.md §12): re-acquire the viewer's
  // CURRENT image after setFilter() BEFORE the recheck reads its edge counts.
  // Phase 2 re-read the `lastImage` latched at load time, but in the field
  // setFilter()'s clear() cuts that image out of the trajectory and the caching
  // pass repopulates a DIFFERENT current-image object — so the old ref reads
  // `spatial:null` forever and attempt 2 never leaves the "uncached" branch
  // (every field edge_recovery was trigger=uncached / result=no_change, 0/108
  // recovered). The public getImage() resolves stateService.currentImage$ — the
  // live current image (confirmed against the mapillary-js 4.1.2 bundle:
  // `getImage(){return new Promise((res,rej)=>{this._navigator.stateService
  // .currentImage$.pipe(take(1)).subscribe(res,rej)})}`) — so refreshing
  // `lastImage` from it makes the recheck observe the POST-recovery edges.
  // Robust to both SDK behaviors: if setFilter mutates the image in place,
  // getImage() returns that same (now-fresh) object; if it replaces the image,
  // getImage() returns the new one. An SDK build without getImage (or a reject)
  // falls back to the latched ref and stays synchronous. The `lastImage`
  // assignment is still id/coordinate-free (only extractEdgeCounts reads it) and
  // is gated on the state still being live so a late resolve can't repopulate a
  // latch endRound() just cleared.
  function refreshLastImageThen(state, fn) {
    if (typeof viewer.getImage !== "function") { fn(); return; }
    let p;
    try { p = viewer.getImage(); } catch { fn(); return; }
    Promise.resolve(p).then(
      (image) => {
        if (edgeRecovery === state && image && typeof image === "object") {
          lastImage = image;
        }
        fn();
      },
      () => { fn(); },
    );
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

  // §18: re-probe when the page returns to the foreground while a round is
  // open (+300ms lets the compositor re-present first). A backgrounded page is
  // never judged (classifyRenderProbe → "unknown").
  const onVisibility = () => {
    if (documentVisible() && pano != null && renderWatch && !renderWatch.done) {
      scheduleRenderProbe(renderProbeTick, renderProbeDelays().visible);
    }
  };
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", onVisibility);
  }

  // G3/D7: on Daily a round's pano fold closes only at the NEXT beginRound (or
  // destroy), so a mid-round abandon — reload, tab close — ALWAYS loses the
  // open fold (her round-3 fold died exactly this way). Flush it on pagehide
  // with partial:true (posthog-js flushes on pagehide via beacon) so torn
  // rounds are studyable rather than silent.
  const onPageHide = () => {
    if (!pano) return;
    const props = panoSessionProps(pano);
    if (props) { props.partial = true; track("pano_session", props); }
    pano = null;
  };
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", onPageHide);
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
  // D6: three.js preventDefault()s the lost event (F6), so a restore CAN fire —
  // but its GL re-init still needs a needsRender trigger before it repaints. So
  // the restore schedules a probe AND resizes (guaranteeing the repaint the
  // probe then verifies).
  const onContextRestored = () => {
    try { viewer.resize(); } catch { /* not laid out yet */ }
    if (pano != null) {
      if (!renderWatch || renderWatch.done) renderWatch = createRenderWatch();
      scheduleRenderProbe(renderProbeTick, renderProbeDelays().visible);
    }
  };

  // D1 (THE primary listener fix). The SDK canvas is created DETACHED and
  // enters the DOM only after the FIRST moveTo settles (Verdict F1–F5);
  // getCanvas() returns null until then. So the listener can only bind once a
  // load has actually painted — which is why attachCanvas() now re-runs on
  // EVERY successful attempt() (any purpose), using getCanvas() as the primary
  // source and querySelector("canvas") as the fallback. A null canvas is "not
  // present yet", never an error. The create-time and +1500ms attempts stay as
  // harmless first tries (known-insufficient on cold mobile networks, §B).
  let canvas = null;
  function currentCanvas() {
    let cv = null;
    try {
      if (viewer && typeof viewer.getCanvas === "function") cv = viewer.getCanvas();
    } catch { cv = null; }
    if (!cv && el && typeof el.querySelector === "function") {
      try { cv = el.querySelector("canvas"); } catch { cv = null; }
    }
    return cv || null;
  }
  function detachCanvas() {
    if (!canvas) return;
    try { canvas.removeEventListener("webglcontextlost", onContextLost); } catch { /* gone */ }
    try { canvas.removeEventListener("webglcontextrestored", onContextRestored); } catch { /* gone */ }
    canvas = null;
  }
  function attachCanvas() {
    const cv = currentCanvas();
    if (!cv) return;             // not in the DOM yet (F5) — retry on next success
    if (cv === canvas) return;   // already bound to this exact element
    detachCanvas();              // rebind: drop the stale listener first (D1)
    canvas = cv;
    if (typeof canvas.addEventListener === "function") {
      canvas.addEventListener("webglcontextlost", onContextLost);
      canvas.addEventListener("webglcontextrestored", onContextRestored);
    }
  }
  attachCanvas();
  const canvasTimer = typeof setTimeout !== "undefined"
    ? setTimeout(attachCanvas, 1500) : null;

  /* ==============================================================
   * §18 render-death probe + bounded rebuild (docs/ios-blackout-review.md).
   * Wrapper-internal, behind the `iv` façade — the probe reads only our own
   * viewer's canvas; the canary and 2D sample canvas are offscreen and never
   * enter the DOM. All timers route through one scheduleRenderProbe() seam so
   * __renderProbeTickForTests can drive the state machine without sleeping —
   * exactly the edge-recovery lifecycle, already proven in this file.
   * ============================================================== */
  let renderWatch = null;
  let renderProbeTimer = null;
  let pendingRenderProbeTick = null;
  let renderProbeArmedAt = null;
  let renderRecovery = createRenderRecovery();  // SESSION-scoped (persists per round)
  let renderRebuildPending = null;              // { attempt, trigger, t0, roundNumber }
  let canary = null;                            // { canvas, gl } — lazy, one per viewer
  let sampleCanvas = null;
  let sampleCtx = null;

  function renderProbeDelays() {
    const c = chaos();
    const over = (c && c.renderProbeMs) || {};
    return {
      first: Number.isFinite(over.first) ? over.first : RENDER_PROBE_FIRST_MS,
      second: Number.isFinite(over.second) ? over.second : RENDER_PROBE_SECOND_MS,
      visible: Number.isFinite(over.visible) ? over.visible : RENDER_PROBE_VISIBLE_MS,
    };
  }

  function cancelRenderProbe() {
    if (renderProbeTimer !== null) { clearTimeout(renderProbeTimer); renderProbeTimer = null; }
    pendingRenderProbeTick = null;
  }

  function scheduleRenderProbe(fn, ms) {
    cancelRenderProbe();
    pendingRenderProbeTick = fn;
    if (typeof setTimeout === "undefined") return;
    renderProbeTimer = setTimeout(() => {
      renderProbeTimer = null;
      const f = pendingRenderProbeTick;
      pendingRenderProbeTick = null;
      if (f) f();
    }, ms);
  }

  // Armed on anchor/resume success (D4: the canvas always exists by then).
  function armRenderProbe() {
    cancelRenderProbe();
    renderWatch = createRenderWatch();
    renderProbeArmedAt = now();
    scheduleRenderProbe(renderProbeTick, renderProbeDelays().first);
  }

  function documentVisible() {
    if (typeof document === "undefined") return true;
    // A document with no visibilityState (old/stub) is treated as visible.
    return document.visibilityState === undefined ||
      document.visibilityState === "visible";
  }

  // The canary answers the case isContextLost() cannot: a GPU process dead
  // enough that even context-state queries lie. One persistent 1×1 offscreen
  // context, created LAZILY (only when a probe is already suspicious) and kept
  // for the viewer's life — iOS caps live WebGL contexts and evicts the oldest,
  // so churning a canary could itself cause the SDK's loss (§2.2).
  function ensureCanary() {
    if (canary) return canary;
    if (typeof document === "undefined" || typeof document.createElement !== "function") {
      canary = { canvas: null, gl: null };
      return canary;
    }
    try {
      const cv = document.createElement("canvas");
      cv.width = 1; cv.height = 1;
      const gl = typeof cv.getContext === "function" &&
        (cv.getContext("webgl2") || cv.getContext("webgl") ||
         cv.getContext("experimental-webgl"));
      canary = { canvas: cv, gl: gl || null };
    } catch { canary = { canvas: null, gl: null }; }
    return canary;
  }

  function probeCanaryOk() {
    const cn = ensureCanary();
    if (!cn || !cn.gl) return false;
    const gl = cn.gl;
    try {
      if (typeof gl.isContextLost === "function" && gl.isContextLost()) return false;
      gl.clearColor(0, 1, 0, 1);              // clear to green
      gl.clear(gl.COLOR_BUFFER_BIT);
      const px = new Uint8Array(4);
      // readPixels in the SAME task is spec-valid even with
      // preserveDrawingBuffer:false — the buffer survives until the task yields.
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px[1] > 200 && px[0] < 80 && px[2] < 80;
    } catch { return false; }
  }

  function releaseCanary() {
    if (canary && canary.gl && typeof canary.gl.getExtension === "function") {
      try {
        const ext = canary.gl.getExtension("WEBGL_lose_context");
        if (ext && typeof ext.loseContext === "function") ext.loseContext();
      } catch { /* already gone */ }
    }
    canary = null;
  }

  function readCtxLost(cv) {
    if (!cv || typeof cv.getContext !== "function") return null;
    let gl = null;
    try {
      gl = cv.getContext("webgl2") || cv.getContext("webgl") ||
        cv.getContext("experimental-webgl");
    } catch { gl = null; }
    if (!gl || typeof gl.isContextLost !== "function") return null;
    try { return gl.isContextLost() === true; } catch { return null; }
  }

  // Corroboration only (§2.1). D5: three.js clears to #0f0f0f, so a healthy
  // idle canvas is uniform near-black — ANY uniform frame is "blank", whatever
  // the color; only a non-uniform frame proves paint ("content").
  function readSample(cv) {
    if (!cv || typeof document === "undefined" ||
        typeof document.createElement !== "function") {
      return "unreadable";
    }
    try {
      if (!sampleCtx) {
        sampleCanvas = document.createElement("canvas");
        sampleCanvas.width = 8; sampleCanvas.height = 8;
        sampleCtx = typeof sampleCanvas.getContext === "function"
          ? sampleCanvas.getContext("2d") : null;
      }
      if (!sampleCtx) return "unreadable";
      sampleCtx.clearRect(0, 0, 8, 8);
      sampleCtx.drawImage(cv, 0, 0, 8, 8);
      const data = sampleCtx.getImageData(0, 0, 8, 8).data;
      for (let i = 4; i < data.length; i += 4) {
        if (data[i] !== data[0] || data[i + 1] !== data[1] ||
            data[i + 2] !== data[2] || data[i + 3] !== data[3]) {
          return "content";
        }
      }
      return "blank";
    } catch { return "unreadable"; }
  }

  function gatherRenderSignals() {
    if (!documentVisible()) return { visible: false };
    const cv = currentCanvas();
    const canvasFound = cv != null;
    const canvasConnected = canvasFound && cv.isConnected === true;
    const ctxLost = readCtxLost(cv);
    if (ctxLost === true) {
      // Decisive — never spend a canary when the context already reports lost.
      return { visible: true, canvasFound, canvasConnected, ctxLost: true, sample: "skipped" };
    }
    const sample = canvasFound ? readSample(cv) : "unreadable";
    // The canary is for the ambiguous middle ONLY: run it when the canvas is
    // present but not clearly painting, never during a teardown (canvas gone).
    let canaryOk = null;
    if (canvasFound && canvasConnected && sample !== "content") {
      canaryOk = probeCanaryOk();
    }
    return { visible: true, canvasFound, canvasConnected, ctxLost, canaryOk, sample };
  }

  function emitRenderProbe(verdict, signals) {
    const props = {
      surface,
      round_number: pano && Number.isFinite(pano.round_number) ? pano.round_number : 0,
      verdict,
      since_load_ms: renderProbeArmedAt === null
        ? 0 : Math.round(now() - renderProbeArmedAt),
      net_type: netType(), online: isOnline(),
    };
    if (signals.ctxLost === true || signals.ctxLost === false) props.ctx_lost = signals.ctxLost;
    if (signals.canaryOk === true || signals.canaryOk === false) props.canary_ok = signals.canaryOk;
    if (typeof signals.sample === "string") props.sample = signals.sample;
    track("render_probe", props);
  }

  function renderProbeTick() {
    if (!renderWatch || renderWatch.done) return;
    const gate = decideRenderProbe(renderWatch, {
      viewerOk: iv.ok === true,
      roundOpen: pano != null,
      inFlight: inFlightCount > 0,
    });
    if (gate.act === "stop") { renderWatch = renderWatchStopped(renderWatch); return; }
    if (gate.act === "skip") return; // a load is in flight; its success re-arms
    const signals = gatherRenderSignals();
    const verdict = classifyRenderProbe(signals);
    renderWatch = renderWatchProbed(renderWatch, verdict);
    handleRenderVerdict(verdict, signals);
    // Second probe of the +1500/+5000 pair — only after the first, and only if
    // the watch is still live (a dead verdict that stopped/rebuilt must not
    // reschedule a corpse probe).
    if (renderWatch && renderWatch.probes === 1 && !renderWatch.done) {
      const d = renderProbeDelays();
      scheduleRenderProbe(renderProbeTick, Math.max(0, d.second - d.first));
    }
  }

  function handleRenderVerdict(verdict, signals) {
    // Resolve a pending rebuild on the first real verdict its re-armed probe
    // returns (the rebuild's own verification pass, §3.1.5).
    if (renderRebuildPending && verdict !== "unknown") {
      const pending = renderRebuildPending;
      renderRebuildPending = null;
      finishRebuild(classifyRenderOutcome({
        rebuilt: true, resumeOk: true, followupVerdict: verdict,
      }), pending);
      // fall through: a still-dead follow-up must still emit its render_probe
      // and reach decideRenderRecovery — which now says "stop" (budget spent),
      // so there is never a second rebuild this round.
    }
    if (verdict === "alive" || verdict === "unknown") return;
    emitRenderProbe(verdict, signals);
    if (verdict === "suspect") {
      const react = decideRenderProbe(renderWatch, {
        viewerOk: iv.ok === true, roundOpen: pano != null,
        inFlight: inFlightCount > 0, verdict: "suspect",
      });
      if (react.act === "nudge") { try { viewer.resize(); } catch { /* not laid out */ } }
      return;
    }
    handleRenderDead(signals);
  }

  function handleRenderDead(signals) {
    // §2.4 step 1: THIS alone converts the silent class into a PostHog issue.
    emitException("render_dead", "render probe: webgl context dead", {
      surface, error_class: "render_dead", webgl: true,
    });
    log.record({ error_class: "render_dead", surface, pool_entry: "" });
    startRecording();
    if (pano) pano = foldPanoEvent(pano, { type: "render_dead", at: now() });
    const decision = decideRenderRecovery(renderRecovery, {
      verdict: "dead",
      viewerOk: iv.ok === true,
      roundOpen: pano != null,
      inFlight: inFlightCount > 0,
      visible: documentVisible(),
    });
    if (decision === "rebuild") {
      rebuild(signals.ctxLost === true ? "context_lost" : "canary_dead");
    } else if (decision === "stop") {
      renderWatch = renderWatchStopped(renderWatch);
    }
    // "skip": leave the watch live; the second/visibility probe re-checks.
  }

  // §3.1 in-place rebuild: replace the raw SDK viewer behind the same `iv`,
  // then moveTo the player's current image ("resume"). Bounded 1/round, 2/
  // session by the pure decideRenderRecovery.
  function rebuild(trigger) {
    const t0 = now();
    renderRecovery = renderRecoveryUsed(renderRecovery);
    const attemptNumber = renderRecovery.sessionRebuilds;
    const roundNumber = pano && Number.isFinite(pano.round_number) ? pano.round_number : 0;
    // Resume target, chosen BEFORE teardown: where the player is standing now
    // (navigated off the anchor) or the anchor itself. lastImage is a live ref,
    // never serialized (only extractEdgeCounts reads it elsewhere).
    const navigatedOff = lastImage && typeof lastImage === "object" &&
      lastImage.id != null && anchorImageId != null && lastImage.id !== anchorImageId;
    const target = navigatedOff ? lastImage.id : anchorImageId;

    // D2 (load-bearing, F8): SDK teardown deliberately fires a REAL
    // loseContext(). Detach canvas listeners and cancel probes BEFORE
    // remove(), or the destroy trips our own webglcontextlost handler and
    // re-probes a corpse. Mirrors today's correct destroy() order.
    renderWatch = renderWatchStopped(renderWatch);
    cancelRenderProbe();
    detachCanvas();
    cancelEdgeRecoveryTimer();
    edgeRecovery = null;
    cancelNavHint();
    try { viewer.remove(); } catch { /* a context-lost viewer may throw */ }

    let newRaw;
    try {
      const resolvedComponent = {
        ...component,
        direction: directionComponentConfig(
          iv.moveEnabled === true && component.direction !== false),
      };
      newRaw = new mapillary.Viewer({
        accessToken: MAPILLARY_TOKEN,
        container,
        component: resolvedComponent,
      });
    } catch {
      finishRebuild("rebuild_failed", { attempt: attemptNumber, trigger, t0, roundNumber });
      return;
    }
    viewer = newRaw;
    iv.viewer = newRaw;               // keep the façade property fresh (§3.1)
    bindViewerHandlers();             // re-register pov/fov/navigable/image
    attachCanvas();                   // canvas is null until the resume settles (F5)
    desiredMove = iv.moveEnabled === true;  // a hard/frozen viewer comes back frozen
    applyMove();

    if (target == null) {
      finishRebuild("rebuild_failed", { attempt: attemptNumber, trigger, t0, roundNumber });
      return;
    }
    // Through the façade moveTo: resume gets the cover, the 20s timeout, an
    // imagery_load{purpose:"resume"}, and re-arms edge recovery, the nav hint
    // AND the render probe — that re-armed probe becomes the rebuild's own
    // verification pass (§3.1.4). moveTo rethrows on failure → rebuild_failed.
    iv.moveTo(target, "resume").then(
      () => {
        renderRebuildPending = { attempt: attemptNumber, trigger, t0, roundNumber };
      },
      () => {
        finishRebuild("rebuild_failed", { attempt: attemptNumber, trigger, t0, roundNumber });
      },
    );
  }

  function finishRebuild(result, pending) {
    track("render_recovery", {
      surface, round_number: pending.roundNumber, attempt: pending.attempt,
      trigger: pending.trigger, result,
      duration_ms: Math.round(now() - pending.t0),
      net_type: netType(), online: isOnline(),
    });
    // §3.3: a successful rebuild is silent (the cover drops/lifts like a round
    // transition). Only a failure toasts — through the page's callback, so the
    // wrapper never imports UI. The map-guess path is fully functional.
    if ((result === "rebuild_failed" || result === "still_dead") &&
        typeof onRecovery === "function") {
      try { onRecovery(result); } catch { /* a page callback must never break the wrapper */ }
    }
  }

  // §7 live-fire harness handle (reachable only via __gpChaos.killContext on a
  // dev host — see registerForChaos). Kills the live canvas's context exactly
  // as the jetsam path does; the SDK swallows it (F6) and the probe catches it.
  function chaosKillContext() {
    const cv = currentCanvas();
    if (!cv || typeof cv.getContext !== "function") return false;
    let gl = null;
    try {
      gl = cv.getContext("webgl2") || cv.getContext("webgl") ||
        cv.getContext("experimental-webgl");
    } catch { gl = null; }
    if (!gl || typeof gl.getExtension !== "function") return false;
    try {
      const ext = gl.getExtension("WEBGL_lose_context");
      if (ext && typeof ext.loseContext === "function") { ext.loseContext(); return true; }
    } catch { /* ignore */ }
    return false;
  }

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

  /* "Loading the arrows…" nav hint (issue #3 follow-up, docs §17 in
   * imagery.js). A move-enabled round anchor can land before Mapillary's
   * DirectionComponent has any arrow glyphs to draw — this is a
   * non-blocking (pointer-events:none) pill that bridges the gap. It is
   * entirely independent of the §4 cover / edge-recovery machinery above:
   * no shared state, no interaction with setFilter(). */
  let navHintEl = null;
  let navHintTimer = null;
  let pendingNavHintTick = null;
  let navHintArmedAt = null;
  // Latches true once arrowsVisible has been observed false at least once
  // during THIS arm — guards against reading the previous round's stale
  // arrow glyphs as "found arrows" (imagery.js §17 / navHintBaselineCleared).
  let navHintBaseline = false;

  function ensureNavHint() {
    if (navHintEl) return navHintEl;
    if (!el || typeof document === "undefined" || !document.createElement) {
      return null;
    }
    navHintEl = document.createElement("div");
    navHintEl.className = "pano-nav-hint";
    const dot = document.createElement("span");
    dot.className = "pano-nav-hint-dot";
    navHintEl.appendChild(dot);
    navHintEl.appendChild(document.createTextNode("Loading the arrows…"));
    // Mount on <body>, NOT the Mapillary viewer container: the SDK's own CSS
    // (`.mapillary-viewer div { box-sizing:content-box }` and the container's
    // flex/grid layout) stretches children, which made the pill render full
    // height/width when it was appended to `el`. Fixed-position on body is
    // immune to the SDK's container styling.
    const host = (typeof document !== "undefined" && document.body)
      ? document.body
      : el;
    if (host && host.appendChild) host.appendChild(navHintEl);
    return navHintEl;
  }

  function showNavHint() {
    const n = ensureNavHint();
    if (n && n.classList) n.classList.add("show");
  }

  // Stops any pending poll and fades the pill. Used both for the "we're
  // done" decisions (arrows found / timed out) and for supersession.
  function hideNavHint() {
    if (navHintTimer !== null) { clearTimeout(navHintTimer); navHintTimer = null; }
    pendingNavHintTick = null;
    if (navHintEl && navHintEl.classList) navHintEl.classList.remove("show");
  }

  // A superseded/ended round invalidates whatever the hint was waiting on.
  function cancelNavHint() {
    hideNavHint();
  }

  function scheduleNavHintPoll() {
    pendingNavHintTick = navHintPoll;
    if (typeof setTimeout === "undefined") return;
    navHintTimer = setTimeout(() => {
      navHintTimer = null;
      const f = pendingNavHintTick;
      pendingNavHintTick = null;
      if (f) f();
    }, NAV_HINT_POLL_MS);
  }

  function navHintPoll() {
    const arrowsVisible = navigationArrowsVisible(el);
    navHintBaseline = navHintBaselineCleared(navHintBaseline, arrowsVisible);
    const elapsedMs = navHintArmedAt === null ? 0 : now() - navHintArmedAt;
    const decision = decideNavHint({
      arrowsVisible,
      baselineClear: navHintBaseline,
      elapsedMs,
      maxMs: NAV_HINT_MAX_MS,
    });
    if (decision === "wait") { scheduleNavHintPoll(); return; }
    hideNavHint(); // both hide_arrows and hide_timeout fade silently
  }

  // Arm on round-anchor success, right alongside armEdgeRecovery. Only when
  // movement is actually offered (Frozen/TV never show it). Deliberately
  // does NOT early-return when arrows are already on screen: the viewer +
  // DirectionComponent are reused across rounds, so arrows present at arm
  // time may be the PREVIOUS round's stale glyphs, not this round's. The
  // baseline latch (seeded here, cleared by the first poll that observes
  // arrowsVisible===false) is what prevents a flash-then-instant-fade.
  function armNavHint() {
    cancelNavHint();
    if (iv.moveEnabled !== true) return;
    navHintArmedAt = now();
    navHintBaseline = navigationArrowsVisible(el) === false;
    showNavHint();
    scheduleNavHintPoll();
  }

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
    // A new load supersedes whatever the nav hint was waiting on too.
    cancelNavHint();
    // §18: a new load supersedes pending render probes — the canvas it was
    // judging is about to change; a successful load re-arms them.
    cancelRenderProbe();
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
          // D1: the SDK canvas may have JUST entered the DOM on this settle
          // (F5) — re-attach the context listeners on every success (any
          // purpose), which is the earliest possible bind moment.
          attachCanvas();
          // The image actually arrived: reveal it (whether on time or late).
          if (coversRound(purpose)) {
            hideCover();
            // Issue #2 Phase 2: arm bounded recovery on every round-anchor
            // success (on time or late) — idempotent per anchor.
            armEdgeRecovery(imageId,
              pano && Number.isFinite(pano.round_number) ? pano.round_number : 0);
            armNavHint();
            // §18: arm the render-death probe on the same anchor/resume success.
            armRenderProbe();
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
    stopPlay,

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
      // Universal per-round safety net: a round boundary always stops any
      // running autoplay, regardless of the outgoing/incoming move lever.
      // On player (no sequence component laid out) this is a harmless no-op.
      stopPlay();
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
      cancelNavHint();
      // §18: cancel probes, reset the PER-ROUND rebuild budget (the per-SESSION
      // budget persists), and drop any pending rebuild verification. Runs
      // before the pano early-return so a destroy/pre-round-1 call clears too.
      cancelRenderProbe();
      renderWatch = null;
      renderRecovery = renderRecoveryRoundReset(renderRecovery);
      renderRebuildPending = null;
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
      // Frozen/Hard: movement is off, so actively dismiss the
      // "Loading the arrows…" pill rather than leave an already-armed hint
      // to time out against arrows that will never appear.
      if (allowed !== true) cancelNavHint();
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

    // Test-only seam: synchronously runs one due nav-hint poll, same
    // convention as __edgeRecoveryTickForTests. Never called in production.
    __navHintTickForTests() {
      if (navHintTimer !== null) { clearTimeout(navHintTimer); navHintTimer = null; }
      const f = pendingNavHintTick;
      pendingNavHintTick = null;
      if (f) f();
    },

    // Test-only seam (§18): synchronously runs one due render-probe tick, same
    // convention as __edgeRecoveryTickForTests. Never called in production.
    __renderProbeTickForTests() {
      if (renderProbeTimer !== null) { clearTimeout(renderProbeTimer); renderProbeTimer = null; }
      const f = pendingRenderProbeTick;
      pendingRenderProbeTick = null;
      if (f) f();
    },

    // §7 live-fire harness handle — wired to __gpChaos.killContext on a dev
    // host only (registerForChaos). Inert data on any other page.
    __chaosKillContext: chaosKillContext,

    destroy() {
      if (destroyed) return;
      destroyed = true;
      iv.endRound();
      if (canvasTimer) clearTimeout(canvasTimer);
      if (moveRetryTimer) { clearTimeout(moveRetryTimer); moveRetryTimer = null; }
      // §18: cancel the probe, release the canary GPU context (via
      // WEBGL_lose_context so iOS reclaims it), detach BOTH canvas listeners.
      cancelRenderProbe();
      releaseCanary();
      detachCanvas();
      if (el && el.removeEventListener) {
        el.removeEventListener("pointerdown", onPointerDown, true);
      }
      if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
      if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
        window.removeEventListener("pagehide", onPageHide);
      }
      if (coverEl && coverEl.remove) { try { coverEl.remove(); } catch { /* gone */ } }
      coverEl = null;
      cancelNavHint();
      if (navHintEl && navHintEl.remove) { try { navHintEl.remove(); } catch { /* gone */ } }
      navHintEl = null;
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
