// imagery.js — PURE field-observability logic (no DOM, no network, no
// PostHog). Everything the Mapillary wrapper needs in order to *decide*
// something lives here and is unit-tested in tests/imagery.test.js:
//
//   - the closed error taxonomy + classifier (docs/field-observability-plan.md §5)
//   - message/URL scrubbers (no query strings, no long digit runs ever leave)
//   - poolDiagId(): opaque pool-entry correlation key (§8 — never coordinates,
//     never the raw Mapillary image id)
//   - the per-purpose timeout policy (§6.1) and the exception budget caps (§7.4)
//   - the pano_session interaction fold (§7.1) and the session health
//     classifier (§9.1) that decides healthy / degraded / failed
//   - ref codes + the report bundle for the "Report it" flow (§10)
//   - the chaos-hook host check used by the failure-injection harness (§15)
//
// Privacy note: nothing in this file may produce a value derived from a
// user's guess, a coordinate, or free text. Pool entries are game content
// we chose — poolDiagId pseudonymizes them so PostHog holds no directly
// reversible location key (§8 documents that tradeoff honestly).

/* ================================================================
 * §5 Error taxonomy
 * ================================================================ */

export const ERROR_CLASSES = Object.freeze([
  "http_auth",
  "http_rate_limit",
  "http_server",
  "network_timeout",
  "network_offline",
  "image_dead",
  "no_neighbors",
  "viewer_init",
  "webgl_unavailable",
  "webgl_context_lost",
  "gesture_blocked",
  "reanchor_bounce",
  "cancelled",
  "sdk_unknown",
]);

// `cancelled` is expected churn (a moveTo superseded by a newer one): it is
// counted in events but NEVER captured as an exception and never counted in
// failure-rate math.
export const NON_FAILURE_CLASSES = Object.freeze(["cancelled"]);

// Classes that mean the player saw a broken game (§9.1 "failed").
// network_timeout is conditional — a late success corrects it (§6.1).
export const HARD_FAILURE_CLASSES = Object.freeze([
  "http_auth",
  "webgl_unavailable",
  "webgl_context_lost",
  "viewer_init",
]);

export function isFailureClass(errorClass) {
  return Boolean(errorClass) && !NON_FAILURE_CLASSES.includes(errorClass);
}

// The ONLY classes that mean the pool ENTRY itself is gone, so the seeded
// sampler may deterministically skip past it. The skip is a property of the
// content (dead everywhere, for everyone), which is what keeps the Daily's
// "same five spots for everyone" invariant intact even as devices skip.
//
// Every OTHER failure (network_timeout, offline, rate_limit, server, auth,
// webgl_*, sdk_unknown) is transient or environmental — a property of THIS
// device/moment, not of the entry. Skipping past a LIVE entry on one of those
// would desync the Daily's shared order (review P2-5) and burn the whole pool
// for nothing, so loadRoundImage surfaces a retryable degraded state and does
// NOT advance the sampler instead. `no_neighbors` is a navigation dead-end
// (the anchor loaded fine), never an anchor-load skip reason.
export const DEAD_ENTRY_CLASSES = Object.freeze(["image_dead"]);

export function isDeadEntryClass(errorClass) {
  return DEAD_ENTRY_CLASSES.includes(errorClass);
}

const RE_CANCELLED = /cancell?ed|aborted|superseded|request was replaced/i;
const RE_AUTH = /\b40[13]\b|unauthoriz|forbidden|invalid (?:access )?token|token (?:expired|revoked)/i;
const RE_RATE = /\b429\b|rate[ _-]?limit|too many requests|quota/i;
const RE_SERVER = /\b5[0-9]{2}\b|internal server error|bad gateway|service unavailable|gateway timeout/i;
const RE_DEAD = /\b404\b|not found|does not exist|no such image|could not be found|unable to (?:find|resolve) image/i;
const RE_NO_NEIGHBORS = /no (?:navigable|adjacent|neighbou?r)|empty adjacency|no (?:such )?edge|not navigable|no images? in direction/i;
const RE_WEBGL = /webgl|graphics context|context lost/i;
const RE_TIMEOUT = /timed? ?out|timeout/i;

// Pull the message out of anything (Error, string, {message}, SDK reject
// value). Never throws.
export function errorMessage(err) {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (typeof err.message === "string" && err.message) return err.message;
  if (typeof err.name === "string" && err.name) return err.name;
  try { return String(err); } catch { return ""; }
}

// The one classifier. `ctx` is what the wrapper knows that the message
// doesn't: { online, timedOut, phase, webglSupported, errorClass }.
// `phase` is "init" | "move" | "nav". An explicit ctx.errorClass wins (the
// webglcontextlost listener and the isSupported() pre-check use it).
export function classifyImageryError(err, ctx) {
  const c = ctx || {};
  if (c.errorClass && ERROR_CLASSES.includes(c.errorClass)) return c.errorClass;

  const msg = errorMessage(err);

  // Expected churn first: a superseded moveTo is not a failure at all.
  if (RE_CANCELLED.test(msg)) return "cancelled";

  // Real HTTP evidence beats connectivity guesses — a 401 body proves we
  // reached Mapillary.
  if (RE_AUTH.test(msg)) return "http_auth";
  if (RE_RATE.test(msg)) return "http_rate_limit";
  if (RE_SERVER.test(msg)) return "http_server";
  if (RE_DEAD.test(msg)) return "image_dead";
  if (RE_NO_NEIGHBORS.test(msg)) return "no_neighbors";

  if (c.webglSupported === false) return "webgl_unavailable";
  if (RE_WEBGL.test(msg)) {
    return c.phase === "init" ? "webgl_unavailable" : "webgl_context_lost";
  }

  if (c.online === false) return "network_offline";
  if (c.timedOut === true || RE_TIMEOUT.test(msg)) return "network_timeout";

  if (c.phase === "init") return "viewer_init";
  return "sdk_unknown";
}

/* ================================================================
 * Scrubbers — nothing with a query string or a long digit run leaves
 * ================================================================ */

const DIGIT_RUN_RE = /\d{10,}/g;
const URL_TOKEN_RE = /\b(?:https?:\/\/|www\.)[^\s"'<>()\]]+/gi;
export const MESSAGE_MAX = 300;

// Mapillary access tokens ride in query params and image ids are long digit
// strings that reverse to a place via the public Graph API. Both die here.
// The `#` in the cut also drops URL *fragments* entirely — this is the belt
// layer of the Ghost Duel privacy defense (spec §3.5.6): even if a `#g=`
// challenge URL reached a `$current_url`-class property, no payload byte
// survives sanitizeBeforeSend. (The braces layer, history.replaceState, strips
// it before analytics can ever observe the URL.)
export function scrubUrl(value) {
  if (typeof value !== "string") return value;
  const cut = value.search(/[?#]/);
  const base = cut === -1 ? value : value.slice(0, cut);
  return base.replace(DIGIT_RUN_RE, "<id>");
}

export function scrubErrorMessage(value) {
  if (typeof value !== "string") {
    if (value == null) return "";
    return scrubErrorMessage(errorMessage(value));
  }
  const noQuery = value.replace(URL_TOKEN_RE, (m) => {
    const cut = m.search(/[?#]/);
    return cut === -1 ? m : m.slice(0, cut);
  });
  const noIds = noQuery.replace(DIGIT_RUN_RE, "<id>");
  return noIds.length > MESSAGE_MAX ? noIds.slice(0, MESSAGE_MAX) : noIds;
}

/* ================================================================
 * §8 Pool-entry diagnostic id — opaque, stable, dependency-free
 * ================================================================ */

function fnv1a(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const DIAG_SALT_A = "geoparty-diag-a:";
const DIAG_SALT_B = "geoparty-diag-b:";

// Two FNV-1a passes with distinct salts, folded to 41 bits and rendered as
// 8 base36 chars ("k3x9q0ar"). Works on file:// — no crypto.subtle.
export function poolDiagId(imageId) {
  const s = imageId == null ? "" : String(imageId);
  if (!s) return "";
  const a = fnv1a(DIAG_SALT_A + s, 2166136261);
  const b = fnv1a(DIAG_SALT_B + s, 0x9e3779b9);
  const n = (a % 2097152) * 1048576 + (b % 1048576); // 21 + 20 bits
  return n.toString(36).padStart(8, "0");
}

/* ================================================================
 * §6.1 Timeout policy + §7.4 exception budget caps
 * ================================================================ */

export const PURPOSES = Object.freeze([
  "anchor", "resume", "follow", "seed", "hero", "nav",
]);

export const SURFACES = Object.freeze([
  "host", "player", "tv", "tv_panel", "daily", "landing",
]);

const SLOW_TIMEOUT_MS = 20000;   // the round is blocked on this one
const FAST_TIMEOUT_MS = 10000;   // decorative / mirroring loads

export function imageryTimeoutMs(purpose) {
  return purpose === "follow" || purpose === "hero"
    ? FAST_TIMEOUT_MS
    : SLOW_TIMEOUT_MS;
}

// A load slower than this is "degraded" even when it succeeds (§9.1).
export const SLOW_LOAD_MS = 10000;

export const EXCEPTION_CAP_PER_CLASS = 5;
export const EXCEPTION_CAP_TOTAL = 20;

// A device stuck in a retry loop must not be able to spend the monthly
// exception budget: past the cap trackError degrades to the (cheap,
// aggregated) imagery_load event only.
export function createExceptionBudget(opts) {
  const perClass = (opts && opts.perClass) || EXCEPTION_CAP_PER_CLASS;
  const total = (opts && opts.total) || EXCEPTION_CAP_TOTAL;
  const counts = new Map();
  let sent = 0;
  return {
    // true → this exception may be captured; also consumes the allowance.
    allow(errorClass) {
      if (!isFailureClass(errorClass)) return false;
      if (sent >= total) return false;
      const n = counts.get(errorClass) || 0;
      if (n >= perClass) return false;
      counts.set(errorClass, n + 1);
      sent++;
      return true;
    },
    sent: () => sent,
    countFor: (errorClass) => counts.get(errorClass) || 0,
  };
}

// Per-session dedup: one image_dead exception per pool entry, not one per
// retry (§6.1 "deduped by pool entry per session").
export function createDedup() {
  const seen = new Set();
  return {
    first(key) {
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
    size: () => seen.size,
  };
}

/* ================================================================
 * Issue #2 — spatial/sequence edge diagnostics
 * ================================================================
 * MapillaryJS reports each image's navigation edges as a NavigationEdgeStatus
 * `{ cached: boolean, edges: NavigationEdge[] }`: `spatialEdges` is the
 * arrow/step network the "arrows vanished" field reports are about, and
 * `sequenceEdges` is the along-capture chain. These counts REPLACE the broken
 * `nav_available` health signal (which depended on the `navigable` event that
 * never emits usefully in our setup, and so was false for all 80 historical
 * sessions — issue #2). The critical rule that keeps us from repeating that
 * false-signal trap: a count is trustworthy ONLY when the SDK marks the status
 * `cached`. An uncached status is UNKNOWN (null), never a false zero. The
 * counts are deliberately bounded to a small integer — a diagnostic of "does
 * this anchor have any arrows at all", not a precise graph measurement — and
 * they are pure aggregates: no image id, coordinate, or edge payload rides.
 */

export const EDGE_COUNT_CAP = 12;

// Clamp a raw edge count to a bounded, non-negative integer. Junk (non-finite,
// negative, non-number) collapses to 0 so a malformed count can never inflate
// an aggregate.
export function boundEdgeCount(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return 0;
  const i = Math.floor(n);
  return i > EDGE_COUNT_CAP ? EDGE_COUNT_CAP : i;
}

// Count one edge status defensively. Returns an int in [0, cap], or null when
// the input carries NO trustworthy count (absent, uncached, or malformed) —
// UNKNOWN is deliberately not zero, so a not-yet-cached status never reads as
// "no arrows here".
export function edgeStatusCount(status) {
  if (status == null) return null;
  if (typeof status === "number") return boundEdgeCount(status);
  if (Array.isArray(status)) return boundEdgeCount(status.length);
  if (typeof status === "object") {
    // NavigationEdgeStatus: an uncached status is unknown, never a real 0.
    if (status.cached === false) return null;
    if (Array.isArray(status.edges)) return boundEdgeCount(status.edges.length);
    if (typeof status.count === "number") return boundEdgeCount(status.count);
  }
  return null;
}

// Pull `{ spatial, sequence }` edge counts out of whatever MapillaryJS hands
// the `image` listener — a viewer image event `{ image }`, a bare Image, or an
// already-shaped `{ spatialEdges, sequenceEdges }`. Never throws (the SDK
// getters can throw before an image is initialized) and never reads an id or a
// coordinate. Each field is an int in [0, cap], or null (unknown).
export function extractEdgeCounts(input) {
  const out = { spatial: null, sequence: null };
  let img = input;
  if (input && typeof input === "object" && input.image &&
      typeof input.image === "object") {
    img = input.image;
  }
  if (!img || typeof img !== "object") return out;
  let spatial;
  let sequence;
  try { spatial = img.spatialEdges; } catch { spatial = null; }
  try { sequence = img.sequenceEdges; } catch { sequence = null; }
  out.spatial = edgeStatusCount(spatial);
  out.sequence = edgeStatusCount(sequence);
  return out;
}

/* ================================================================
 * §7.1 pano_session — the interaction fold
 * ================================================================ */

export const LOOK_THROTTLE_MS = 500; // pov bursts collapse into one "look"

export function createPanoSession(opts) {
  const o = opts || {};
  return {
    surface: o.surface || "",
    round_number: Number.isFinite(o.roundNumber) ? o.roundNumber : 0,
    startedAt: Number.isFinite(o.startedAt) ? o.startedAt : 0,
    looks: 0,
    zoom_changes: 0,
    nav_moves: 0,
    nav_failures: 0,
    // DEPRECATED (issue #2): the last `navigable` state seen. `navigable`
    // does not emit usefully in our setup, so this stayed false for every
    // historical session — it is NO LONGER an input to classifySessionHealth.
    // Retained only for backward continuity; prefer anchor_spatial_edges.
    nav_available: false,
    // Issue #2: bounded counts of the ROUND ANCHOR image's navigation edges,
    // null until an edge status is observed AND cached (unknown ≠ zero).
    anchor_spatial_edges: null,
    anchor_sequence_edges: null,
    reanchors: 0,
    pointer_downs: 0,
    first_move_ms: null,
    lastLookAt: null,
  };
}

const INTERACTION_TYPES = ["look", "zoom", "pointer_down", "nav_move"];

// Pure fold: (state, event) -> new state. Event shapes:
//   {type:"look"|"zoom"|"pointer_down"|"nav_move"|"nav_failure"|"reanchor", at}
//   {type:"navigable", value:boolean}
//   {type:"edges", spatial:int|null, sequence:int|null, at}
export function foldPanoEvent(state, ev) {
  if (!state || !ev || !ev.type) return state;
  const next = { ...state };
  const at = Number.isFinite(ev.at) ? ev.at : null;

  switch (ev.type) {
    case "look":
      // Throttle pov bursts so a single head-turn is one look, not 200.
      if (next.lastLookAt === null || at === null ||
          at - next.lastLookAt >= LOOK_THROTTLE_MS) {
        next.looks += 1;
        next.lastLookAt = at;
      }
      break;
    case "zoom": next.zoom_changes += 1; break;
    case "pointer_down": next.pointer_downs += 1; break;
    case "nav_move": next.nav_moves += 1; break;
    case "nav_failure": next.nav_failures += 1; break;
    case "reanchor": next.reanchors += 1; break;
    case "navigable": next.nav_available = ev.value === true; break;
    case "edges":
      // Latch the ANCHOR image's edge availability once per round: the first
      // image of a round is the anchor, and a later image is a different place
      // the player walked to, so a KNOWN count is never overwritten. A null
      // (unknown) observation fills nothing but may itself be filled later by a
      // cached count — so a genuine, cached 0 still registers as known.
      if (next.anchor_spatial_edges === null && Number.isFinite(ev.spatial)) {
        next.anchor_spatial_edges = boundEdgeCount(ev.spatial);
      }
      if (next.anchor_sequence_edges === null && Number.isFinite(ev.sequence)) {
        next.anchor_sequence_edges = boundEdgeCount(ev.sequence);
      }
      break;
    default: return state;
  }

  if (INTERACTION_TYPES.includes(ev.type) && next.first_move_ms === null &&
      at !== null && Number.isFinite(next.startedAt)) {
    next.first_move_ms = Math.max(0, Math.round(at - next.startedAt));
  }
  return next;
}

// The event payload (schema keys only; nulls dropped so the sanitizer's
// "absent" and "zero" never get confused).
export function panoSessionProps(state) {
  if (!state) return null;
  const props = {
    surface: state.surface,
    round_number: state.round_number,
    looks: state.looks,
    zoom_changes: state.zoom_changes,
    nav_moves: state.nav_moves,
    nav_failures: state.nav_failures,
    nav_available: state.nav_available === true,
    reanchors: state.reanchors,
    pointer_downs: state.pointer_downs,
  };
  if (state.first_move_ms !== null && state.first_move_ms !== undefined) {
    props.first_move_ms = state.first_move_ms;
  }
  // Issue #2: only emit an edge count that is actually KNOWN. An unknown
  // (null) count is absent, never a false 0 — the sanitizer would keep a 0.
  if (state.anchor_spatial_edges !== null &&
      state.anchor_spatial_edges !== undefined) {
    props.anchor_spatial_edges = state.anchor_spatial_edges;
  }
  if (state.anchor_sequence_edges !== null &&
      state.anchor_sequence_edges !== undefined) {
    props.anchor_sequence_edges = state.anchor_sequence_edges;
  }
  return props;
}

// A session with pointer activity but zero pov change is the only signal we
// have for the gesture_blocked class (§5 — labelled, never auto-classified).
export function looksGestureBlocked(state) {
  return Boolean(state) && state.pointer_downs > 0 && state.looks === 0;
}

/* ================================================================
 * §9.1 Session health — healthy / degraded / failed (failed > degraded)
 * ================================================================ */

export const HEALTH_HEALTHY = "healthy";
export const HEALTH_DEGRADED = "degraded";
export const HEALTH_FAILED = "failed";

// `facts` is the session's own instrumentation, folded by the caller:
//   viewerInits: [{ ok, error_class }]
//   loads:       [{ purpose, ok, late, duration_ms, skips, error_class,
//                   exhausted }]
//   panos:       [{ nav_failures, pointer_downs, looks, move_enabled }]
//                 (nav_available is DEPRECATED and no longer read here — #2)
//   exceptions:  [{ error_class }]
//   reports:     int
//   roundsIncomplete: bool — a started round never reached its reveal.
//     Set deliberately by the caller at end-of-session; an in-flight round
//     must NOT set it (§9.1 note).
export function classifySessionHealth(facts) {
  const f = facts || {};
  const viewerInits = f.viewerInits || [];
  const loads = f.loads || [];
  const panos = f.panos || [];
  const exceptions = f.exceptions || [];

  // A late success corrects a timeout (§6.1) — only an uncorrected timeout
  // is a hard failure.
  const lateCorrected = loads.some((l) => l && l.ok === true && l.late === true);

  const failed =
    (f.reports || 0) > 0 ||
    viewerInits.some((v) => v && v.ok === false) ||
    loads.some((l) => l && l.ok === false && l.exhausted === true) ||
    exceptions.some((e) => {
      if (!e || !e.error_class) return false;
      if (HARD_FAILURE_CLASSES.includes(e.error_class)) return true;
      return e.error_class === "network_timeout" && !lateCorrected;
    });
  if (failed) return HEALTH_FAILED;

  const degraded =
    loads.some((l) => l && (
      (l.ok === true && (l.duration_ms >= SLOW_LOAD_MS || l.late === true)) ||
      (l.ok === true && (l.skips || 0) >= 1) ||
      (l.ok === false && isFailureClass(l.error_class))
    )) ||
    // Issue #2: a move-enabled round degrades only on a GENUINE navigation
    // failure. It no longer degrades merely because `nav_available` is false —
    // that field depends on the `navigable` event, which never emits usefully
    // here, so it stayed false for every move-enabled session and mislabelled
    // them all as degraded. anchor_spatial_edges is the honest replacement, but
    // its healthy threshold is a Phase 2 decision, so it is diagnostic-only
    // (not a health input) for now.
    panos.some((p) => p && p.move_enabled === true && (p.nav_failures || 0) > 0) ||
    panos.some((p) => looksGestureBlocked(p)) ||
    exceptions.some((e) => e && e.error_class === "no_neighbors") ||
    f.roundsIncomplete === true;

  return degraded ? HEALTH_DEGRADED : HEALTH_HEALTHY;
}

// Client-side recording override (§9.3): the moment a single load looks
// degraded or failed we force the session to record, so a negative sampling
// decision in Stage 2+ can't lose the evidence.
export function shouldForceRecordingForLoad(load) {
  if (!load) return false;
  if (load.ok === false) return isFailureClass(load.error_class);
  if (load.late === true) return true;
  if (Number.isFinite(load.duration_ms) && load.duration_ms >= SLOW_LOAD_MS) {
    return true;
  }
  return (load.skips || 0) >= 2;
}

export function shouldForceRecording(facts) {
  return classifySessionHealth(facts) !== HEALTH_HEALTHY;
}

/* ================================================================
 * §10 Report flow — reference codes and the diagnostic bundle
 * ================================================================ */

// Crockford base32 (no I, L, O, U — unambiguous when read aloud to support).
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const REF_CODE_RE = /^GP-[0-9A-HJKMNP-TV-Z]{6}$/;

// Derived from the PostHog session id + a monotonic counter: unique per
// report at our scale, and reproducible in a test (no Math.random).
export function makeRefCode(sessionId, counter) {
  const seed = `${sessionId == null ? "" : sessionId}#${counter || 0}`;
  const a = fnv1a(seed, 2166136261);
  const b = fnv1a(seed + "!", 0x9e3779b9);
  let n = (a % 1048576) * 1024 + (b % 1024); // 30 bits
  let out = "";
  for (let i = 0; i < 6; i++) {
    out = CROCKFORD[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return `GP-${out}`;
}

// A tiny ring buffer of classified failures for this session. Pure data —
// no DOM, no network — so the report bundle fold is testable.
export function createImageryLog(max) {
  const cap = Number.isFinite(max) && max > 0 ? max : 20;
  const entries = [];
  return {
    record(entry) {
      if (!entry) return;
      entries.push(entry);
      while (entries.length > cap) entries.shift();
    },
    all: () => entries.slice(),
    last: () => (entries.length ? entries[entries.length - 1] : null),
    failures: () => entries.filter((e) => e && isFailureClass(e.error_class)),
    count: () => entries.length,
  };
}

// The imagery_report payload (§7.1). Everything here is an aggregate or an
// opaque id; there is no free text and no coordinate anywhere.
export function buildReportBundle(input) {
  const i = input || {};
  const failures = i.failures || [];
  const last = failures.length ? failures[failures.length - 1] : null;
  const props = {
    surface: i.surface || "unknown",
    ref_code: i.ref_code || "",
    error_class: (last && last.error_class) || "none",
    net_type: i.net_type || "unknown",
    online: i.online !== false,
    recent_failures: failures.length,
    consent: i.consent === "one_time" ? "one_time" : "analytics",
  };
  const poolEntry = (last && last.pool_entry) || i.pool_entry || "";
  if (poolEntry) props.pool_entry = poolEntry;
  return props;
}

/* ================================================================
 * §13 Pool quarantine (proposal-only — the file is reviewed by a human)
 * ================================================================ */

// Filters a loaded pool against a quarantine id list. Absent/!Array list is
// a no-op so file:// and old checkouts keep working. Never empties the pool:
// a quarantine file that would remove everything is ignored (a bad PR must
// not be able to brick the game).
export function filterQuarantined(pool, quarantined) {
  if (!Array.isArray(pool) || !Array.isArray(quarantined) ||
      quarantined.length === 0) {
    return pool;
  }
  const dead = new Set(quarantined.map(String));
  const kept = pool.filter((e) => e && !dead.has(String(e.image_id)));
  return kept.length ? kept : pool;
}

/* ================================================================
 * §15 Failure-injection harness gate
 * ================================================================ */

// The chaos hooks (window.__gpChaos) are inert anywhere but a local dev
// host. This is a hostname check, deliberately NOT a query param — a
// production page can never be talked into failing.
export function chaosAllowed(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" ||
    hostname === "::1" || hostname === "[::1]" || hostname === "";
}
