// Tests for js/imagery.js — the pure field-observability layer: the error
// taxonomy, the scrubbers that keep query strings and image ids off the
// wire, the opaque pool diag id, the timeout/caps policy, the pano_session
// fold, the session-health classifier, and the report bundle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ERROR_CLASSES,
  HARD_FAILURE_CLASSES,
  DEAD_ENTRY_CLASSES,
  isDeadEntryClass,
  isFailureClass,
  errorMessage,
  classifyImageryError,
  scrubUrl,
  scrubErrorMessage,
  MESSAGE_MAX,
  poolDiagId,
  imageryTimeoutMs,
  SLOW_LOAD_MS,
  EXCEPTION_CAP_PER_CLASS,
  EXCEPTION_CAP_TOTAL,
  createExceptionBudget,
  createDedup,
  createPanoSession,
  foldPanoEvent,
  panoSessionProps,
  looksGestureBlocked,
  LOOK_THROTTLE_MS,
  EDGE_COUNT_CAP,
  boundEdgeCount,
  edgeStatusCount,
  extractEdgeCounts,
  EDGE_RECOVERY_MAX_ATTEMPTS,
  EDGE_RECOVERY_GRACE_MS,
  EDGE_RECOVERY_RECHECK_MS,
  EDGE_RECOVERY_BACKOFF_MS,
  createEdgeRecovery,
  decideEdgeRecovery,
  edgeRecoveryStopped,
  classifyEdgeRecoveryOutcome,
  classifySessionHealth,
  HEALTH_HEALTHY,
  HEALTH_DEGRADED,
  HEALTH_FAILED,
  shouldForceRecordingForLoad,
  shouldForceRecording,
  makeRefCode,
  REF_CODE_RE,
  createImageryLog,
  buildReportBundle,
  filterQuarantined,
  chaosAllowed,
} from "../js/imagery.js";

/* ================================================================
 * §5 Error taxonomy — one fixture per class, from real SDK message shapes
 * ================================================================ */

const FIXTURES = [
  // [message, ctx, expected class]
  ["Failed to fetch: 401 Unauthorized", {}, "http_auth"],
  ["MapillaryError: 403 Forbidden", {}, "http_auth"],
  ["Invalid access token", {}, "http_auth"],
  ["Request failed with status 429", {}, "http_rate_limit"],
  ["rate limit exceeded for application", {}, "http_rate_limit"],
  ["graph.mapillary.com responded 503", {}, "http_server"],
  ["Bad Gateway", {}, "http_server"],
  ["Image 123456789012345 not found", {}, "image_dead"],
  ["Node does not exist", {}, "image_dead"],
  ["No navigable edges in direction", {}, "no_neighbors"],
  ["not navigable", {}, "no_neighbors"],
  ["Request aborted", {}, "cancelled"],
  ["moveTo was cancelled by a newer request", {}, "cancelled"],
  ["something odd", { online: false }, "network_offline"],
  ["something odd", { timedOut: true }, "network_timeout"],
  ["imagery timed out after 20000ms", {}, "network_timeout"],
  ["WebGL context could not be created", { phase: "init" }, "webgl_unavailable"],
  ["anything", { webglSupported: false }, "webgl_unavailable"],
  ["context lost", { phase: "move" }, "webgl_context_lost"],
  ["container element is not valid", { phase: "init" }, "viewer_init"],
  ["totally unrecognised nonsense", { phase: "move" }, "sdk_unknown"],
];

test("classifyImageryError: one fixture per taxonomy class", () => {
  for (const [msg, ctx, expected] of FIXTURES) {
    assert.equal(
      classifyImageryError(new Error(msg), ctx), expected,
      `"${msg}" ${JSON.stringify(ctx)}`,
    );
  }
});

test("classifyImageryError: every produced class is in the closed enum", () => {
  for (const [msg, ctx] of FIXTURES) {
    assert.ok(ERROR_CLASSES.includes(classifyImageryError(new Error(msg), ctx)));
  }
});

test("classifyImageryError: cancellation wins over everything (expected churn)", () => {
  // A superseded moveTo while offline and timed out is still just churn.
  assert.equal(
    classifyImageryError(new Error("request was replaced"),
      { online: false, timedOut: true }),
    "cancelled",
  );
});

test("classifyImageryError: real HTTP evidence beats a connectivity guess", () => {
  // A 401 body proves we reached Mapillary, whatever navigator.onLine says.
  assert.equal(
    classifyImageryError(new Error("401 Unauthorized"), { online: false }),
    "http_auth",
  );
});

test("classifyImageryError: an explicit ctx class wins (contextlost listener)", () => {
  assert.equal(
    classifyImageryError(null, { errorClass: "webgl_context_lost" }),
    "webgl_context_lost",
  );
  // ...but only for classes in the enum.
  assert.equal(
    classifyImageryError(new Error("nope"), { errorClass: "made_up", phase: "move" }),
    "sdk_unknown",
  );
});

test("classifyImageryError: never throws on junk input", () => {
  for (const junk of [null, undefined, 0, "", [], {}, Symbol("x")]) {
    assert.ok(ERROR_CLASSES.includes(classifyImageryError(junk, {})));
  }
  assert.ok(ERROR_CLASSES.includes(classifyImageryError(new Error("x"), null)));
});

test("errorMessage: pulls a message out of anything", () => {
  assert.equal(errorMessage(new Error("boom")), "boom");
  assert.equal(errorMessage("plain"), "plain");
  assert.equal(errorMessage({ message: "obj" }), "obj");
  assert.equal(errorMessage({ name: "TypeError" }), "TypeError");
  assert.equal(errorMessage(null), "");
});

test("isFailureClass: cancelled is excluded from failure math", () => {
  assert.equal(isFailureClass("cancelled"), false);
  assert.equal(isFailureClass("image_dead"), true);
  assert.equal(isFailureClass(null), false);
  assert.equal(isFailureClass(""), false);
});

test("HARD_FAILURE_CLASSES are all real classes", () => {
  for (const c of HARD_FAILURE_CLASSES) assert.ok(ERROR_CLASSES.includes(c));
});

/* ================================================================
 * Scrubbers — the privacy-critical pair
 * ================================================================ */

test("scrubUrl: strips the query string (Mapillary tokens ride there)", () => {
  assert.equal(
    scrubUrl("https://graph.mapillary.com/x?access_token=MLY%7Csecret"),
    "https://graph.mapillary.com/x",
  );
  assert.equal(
    scrubUrl("https://geoparty.example/player.html?room=KWPF#top"),
    "https://geoparty.example/player.html",
  );
});

test("scrubUrl: long digit runs become <id> (image ids reverse to places)", () => {
  assert.equal(
    scrubUrl("https://graph.mapillary.com/1263588815098567"),
    "https://graph.mapillary.com/<id>",
  );
  // Short numbers (round numbers, ports, years) survive.
  assert.equal(scrubUrl("https://host:8080/round/5"), "https://host:8080/round/5");
});

test("scrubUrl: passes non-strings through untouched", () => {
  assert.equal(scrubUrl(undefined), undefined);
  assert.equal(scrubUrl(42), 42);
});

test("scrubErrorMessage: strips query strings inside URL tokens only", () => {
  assert.equal(
    scrubErrorMessage("failed GET https://graph.mapillary.com/a?access_token=X now"),
    "failed GET https://graph.mapillary.com/a now",
  );
  // A question mark in prose is not a query string.
  assert.equal(scrubErrorMessage("is it dead? maybe"), "is it dead? maybe");
});

test("scrubErrorMessage: replaces image ids and truncates", () => {
  assert.equal(
    scrubErrorMessage("Image 1263588815098567 not found"),
    "Image <id> not found",
  );
  assert.equal(scrubErrorMessage("x".repeat(1000)).length, MESSAGE_MAX);
});

test("scrubErrorMessage: accepts Errors and nullish input", () => {
  assert.equal(scrubErrorMessage(new Error("Image 1263588815098567 dead")),
    "Image <id> dead");
  assert.equal(scrubErrorMessage(null), "");
});

test("no scrubbed output can still contain a raw image id or a token", () => {
  const pool = JSON.parse(
    readFileSync(new URL("../data/location_pool.json", import.meta.url), "utf8"));
  for (const entry of pool.slice(0, 200)) {
    const msg = `moveTo failed for https://graph.mapillary.com/${entry.image_id}?access_token=MLY|1|2`;
    const out = scrubErrorMessage(msg);
    assert.ok(!out.includes(String(entry.image_id)), out);
    assert.ok(!out.includes("access_token"), out);
  }
});

/* ================================================================
 * §8 Pool diagnostic id
 * ================================================================ */

test("poolDiagId: stable, opaque, 8 base36 chars", () => {
  const id = poolDiagId("1263588815098567");
  assert.match(id, /^[0-9a-z]{8}$/);
  assert.equal(id, poolDiagId("1263588815098567")); // deterministic
  assert.notEqual(id, poolDiagId("1263588815098568"));
  assert.ok(!id.includes("1263588815098567"));
});

test("poolDiagId: empty/nullish ids produce the empty string, not a hash", () => {
  assert.equal(poolDiagId(""), "");
  assert.equal(poolDiagId(null), "");
  assert.equal(poolDiagId(undefined), "");
});

test("poolDiagId: no collisions across the whole shipped pool", () => {
  const pool = JSON.parse(
    readFileSync(new URL("../data/location_pool.json", import.meta.url), "utf8"));
  const seen = new Map();
  for (const entry of pool) {
    const d = poolDiagId(entry.image_id);
    assert.equal(d.length, 8);
    if (seen.has(d)) {
      assert.fail(`diag id collision ${d}: ${seen.get(d)} vs ${entry.image_id}`);
    }
    seen.set(d, entry.image_id);
  }
  assert.equal(seen.size, pool.length);
});

/* ================================================================
 * §6.1 timeout policy + §7.4 caps
 * ================================================================ */

test("imageryTimeoutMs: 20s for round-blocking loads, 10s for decorative", () => {
  for (const p of ["anchor", "resume", "seed", "nav"]) {
    assert.equal(imageryTimeoutMs(p), 20000, p);
  }
  for (const p of ["follow", "hero"]) {
    assert.equal(imageryTimeoutMs(p), 10000, p);
  }
  assert.equal(imageryTimeoutMs(undefined), 20000); // safe default
});

test("exception budget: per-class and total caps both bite", () => {
  const b = createExceptionBudget();
  for (let i = 0; i < EXCEPTION_CAP_PER_CLASS; i++) {
    assert.equal(b.allow("image_dead"), true, `#${i}`);
  }
  assert.equal(b.allow("image_dead"), false, "per-class cap");
  assert.equal(b.allow("http_server"), true, "a different class still passes");
  assert.equal(b.countFor("image_dead"), EXCEPTION_CAP_PER_CLASS);
});

test("exception budget: a retry loop cannot spend the monthly budget", () => {
  const b = createExceptionBudget({ perClass: 1000, total: EXCEPTION_CAP_TOTAL });
  let sent = 0;
  for (let i = 0; i < 10000; i++) if (b.allow("sdk_unknown")) sent++;
  assert.equal(sent, EXCEPTION_CAP_TOTAL);
  assert.equal(b.sent(), EXCEPTION_CAP_TOTAL);
});

test("exception budget: cancelled never consumes an allowance", () => {
  const b = createExceptionBudget();
  for (let i = 0; i < 50; i++) assert.equal(b.allow("cancelled"), false);
  assert.equal(b.sent(), 0);
});

test("dedup: one exception per pool entry per session", () => {
  const d = createDedup();
  assert.equal(d.first("image_dead:abc"), true);
  assert.equal(d.first("image_dead:abc"), false);
  assert.equal(d.first("image_dead:def"), true);
  assert.equal(d.size(), 2);
  // A missing key must not swallow the report.
  assert.equal(d.first(""), true);
  assert.equal(d.first(""), true);
});

/* ================================================================
 * §7.1 pano_session fold
 * ================================================================ */

const session = (over) => createPanoSession({
  surface: "player", roundNumber: 3, startedAt: 1000, ...over,
});

test("pano fold: counts interactions and throttles look bursts", () => {
  let s = session();
  // A single head-turn is a burst of pov events inside the throttle window.
  for (let i = 0; i < 50; i++) s = foldPanoEvent(s, { type: "look", at: 1100 + i });
  assert.equal(s.looks, 1);
  s = foldPanoEvent(s, { type: "look", at: 1100 + LOOK_THROTTLE_MS });
  assert.equal(s.looks, 2);
});

test("pano fold: first_move_ms is the first interaction, from round start", () => {
  let s = session();
  s = foldPanoEvent(s, { type: "navigable", value: true }); // not interaction
  assert.equal(s.first_move_ms, null);
  s = foldPanoEvent(s, { type: "pointer_down", at: 2400 });
  assert.equal(s.first_move_ms, 1400);
  s = foldPanoEvent(s, { type: "look", at: 9000 });
  assert.equal(s.first_move_ms, 1400, "only the FIRST interaction counts");
});

test("pano fold: every counter and the navigable latch", () => {
  let s = session();
  s = foldPanoEvent(s, { type: "zoom", at: 1200 });
  s = foldPanoEvent(s, { type: "nav_move", at: 1300 });
  s = foldPanoEvent(s, { type: "nav_move", at: 1400 });
  s = foldPanoEvent(s, { type: "nav_failure", at: 1500 });
  s = foldPanoEvent(s, { type: "reanchor", at: 1600 });
  s = foldPanoEvent(s, { type: "navigable", value: true });
  s = foldPanoEvent(s, { type: "navigable", value: false });
  assert.equal(s.zoom_changes, 1);
  assert.equal(s.nav_moves, 2);
  assert.equal(s.nav_failures, 1);
  assert.equal(s.reanchors, 1);
  assert.equal(s.nav_available, false, "latch keeps the LAST state seen");
});

test("pano fold: edge_recovery_attempt counts setFilter() recovery attempts (issue #2 Phase 2)", () => {
  let s = session();
  assert.equal(s.edge_recoveries, 0);
  s = foldPanoEvent(s, { type: "edge_recovery_attempt", at: 1100 });
  assert.equal(s.edge_recoveries, 1);
  s = foldPanoEvent(s, { type: "edge_recovery_attempt", at: 1200 });
  assert.equal(s.edge_recoveries, 2);
  assert.equal(s.first_move_ms, null, "a recovery attempt is not a user interaction");
});

test("panoSessionProps: edge_recoveries is reported only when > 0", () => {
  let s = session();
  assert.ok(!("edge_recoveries" in panoSessionProps(s)), "absent, not a false 0, on the healthy majority");
  s = foldPanoEvent(s, { type: "edge_recovery_attempt", at: 1100 });
  assert.equal(panoSessionProps(s).edge_recoveries, 1);
});

test("pano fold: unknown/absent events are inert, and it never mutates", () => {
  const s = session();
  const before = JSON.stringify(s);
  assert.equal(foldPanoEvent(s, { type: "nope" }), s);
  assert.equal(foldPanoEvent(s, null), s);
  assert.equal(foldPanoEvent(null, { type: "look" }), null);
  foldPanoEvent(s, { type: "look", at: 1200 });
  assert.equal(JSON.stringify(s), before, "input state untouched");
});

test("panoSessionProps: schema keys only, first_move_ms omitted when absent", () => {
  let s = session();
  const idle = panoSessionProps(s);
  assert.deepEqual(Object.keys(idle).sort(), [
    "looks", "nav_available", "nav_failures", "nav_moves", "pointer_downs",
    "reanchors", "round_number", "surface", "zoom_changes",
  ]);
  assert.equal(idle.round_number, 3);
  s = foldPanoEvent(s, { type: "look", at: 3000 });
  assert.equal(panoSessionProps(s).first_move_ms, 2000);
  assert.equal(panoSessionProps(null), null);
});

test("looksGestureBlocked: pointers land but the view never moves", () => {
  let s = session();
  s = foldPanoEvent(s, { type: "pointer_down", at: 1100 });
  s = foldPanoEvent(s, { type: "pointer_down", at: 1900 });
  assert.equal(looksGestureBlocked(s), true);
  s = foldPanoEvent(s, { type: "look", at: 2000 });
  assert.equal(looksGestureBlocked(s), false);
  assert.equal(looksGestureBlocked(session()), false, "an idle round is not blocked");
});

/* ================================================================
 * Issue #2 — spatial/sequence edge diagnostics (the honest replacement
 * for the broken `nav_available` signal)
 * ================================================================ */

test("boundEdgeCount: clamps to [0,cap], floors, rejects junk", () => {
  assert.equal(boundEdgeCount(0), 0);
  assert.equal(boundEdgeCount(3), 3);
  assert.equal(boundEdgeCount(3.9), 3, "floored, never rounded up");
  assert.equal(boundEdgeCount(EDGE_COUNT_CAP + 50), EDGE_COUNT_CAP, "capped");
  assert.equal(boundEdgeCount(-4), 0, "negative → 0");
  assert.equal(boundEdgeCount(NaN), 0);
  assert.equal(boundEdgeCount(Infinity), 0);
  assert.equal(boundEdgeCount("7"), 0, "non-number → 0");
});

test("edgeStatusCount: an UNCACHED status is unknown (null), never zero", () => {
  // The whole point of #2: never repeat the nav_available false-signal trap.
  // A status the SDK has not cached carries no trustworthy count.
  assert.equal(edgeStatusCount({ cached: false, edges: [] }), null);
  assert.equal(edgeStatusCount({ cached: false, edges: [{}, {}] }), null);
  // A cached status counts its edges (bounded).
  assert.equal(edgeStatusCount({ cached: true, edges: [] }), 0);
  assert.equal(edgeStatusCount({ cached: true, edges: [{}, {}, {}] }), 3);
  // Tolerant of the documented alternatives and hostile inputs.
  assert.equal(edgeStatusCount([{}, {}]), 2, "a bare edge array");
  assert.equal(edgeStatusCount(5), 5, "an already-counted number");
  assert.equal(edgeStatusCount({ count: 4 }), 4, "a {count} shape");
  assert.equal(edgeStatusCount(null), null);
  assert.equal(edgeStatusCount(undefined), null);
  assert.equal(edgeStatusCount({}), null, "malformed object → unknown");
  assert.equal(edgeStatusCount("nope"), null);
  assert.equal(edgeStatusCount({ cached: true, edges: 900 }), null,
    "edges must be an array to be counted");
});

test("extractEdgeCounts: reads spatial/sequence from an image event, never an id", () => {
  const ev = {
    image: {
      id: "1263588815098567",
      spatialEdges: { cached: true, edges: [{}, {}, {}, {}] },
      sequenceEdges: { cached: true, edges: [{}, {}] },
    },
  };
  assert.deepEqual(extractEdgeCounts(ev), { spatial: 4, sequence: 2 });
  // A bare image object works too.
  assert.deepEqual(
    extractEdgeCounts({ spatialEdges: [{}], sequenceEdges: [{}, {}, {}] }),
    { spatial: 1, sequence: 3 },
  );
});

test("extractEdgeCounts: uncached/absent edges read as unknown, not zero", () => {
  assert.deepEqual(
    extractEdgeCounts({ image: { spatialEdges: { cached: false, edges: [] } } }),
    { spatial: null, sequence: null });
  assert.deepEqual(extractEdgeCounts({ image: {} }), { spatial: null, sequence: null });
});

test("extractEdgeCounts: never throws on hostile input or a throwing getter", () => {
  assert.deepEqual(extractEdgeCounts(null), { spatial: null, sequence: null });
  assert.deepEqual(extractEdgeCounts(undefined), { spatial: null, sequence: null });
  assert.deepEqual(extractEdgeCounts(42), { spatial: null, sequence: null });
  assert.deepEqual(extractEdgeCounts("x"), { spatial: null, sequence: null });
  // A real MapillaryJS Image getter can throw before the image is initialized.
  const hostile = { image: {} };
  Object.defineProperty(hostile.image, "spatialEdges", {
    get() { throw new Error("Image not initialized"); },
  });
  Object.defineProperty(hostile.image, "sequenceEdges", {
    get() { throw new Error("Image not initialized"); },
  });
  assert.deepEqual(extractEdgeCounts(hostile), { spatial: null, sequence: null });
});

/* ================================================================
 * Issue #2 Phase 2 — bounded spatial-edge cache recovery (pure predicate)
 * ================================================================ */

function baseRecoveryCtx(overrides) {
  return {
    viewerOk: true, canSetFilter: true, moveEnabled: true,
    inFlight: false, userNavigated: false, spatial: null,
    ...overrides,
  };
}

test("createEdgeRecovery: starts at zero attempts, not done", () => {
  assert.deepEqual(createEdgeRecovery(), { attempts: 0, done: false });
});

test("edgeRecoveryStopped: marks done, preserves attempts, never mutates the input", () => {
  const input = { attempts: 1, done: false };
  const stopped = edgeRecoveryStopped(input);
  assert.deepEqual(stopped, { attempts: 1, done: true });
  assert.deepEqual(input, { attempts: 1, done: false }, "the input is untouched");
  assert.deepEqual(edgeRecoveryStopped(null), { attempts: 0, done: true });
});

test("decideEdgeRecovery: done is terminal — beats every other condition", () => {
  const state = { attempts: 0, done: true };
  assert.deepEqual(
    decideEdgeRecovery(state, baseRecoveryCtx({ spatial: null })),
    { act: "stop", reason: "done" },
  );
});

test("decideEdgeRecovery: viewer_stub — not ok, or no setFilter on the SDK build", () => {
  const state = createEdgeRecovery();
  assert.equal(
    decideEdgeRecovery(state, baseRecoveryCtx({ viewerOk: false })).reason,
    "viewer_stub",
  );
  assert.equal(
    decideEdgeRecovery(state, baseRecoveryCtx({ canSetFilter: false })).reason,
    "viewer_stub",
  );
});

test("decideEdgeRecovery: user_navigated stops — never fight navigation", () => {
  const state = createEdgeRecovery();
  assert.deepEqual(
    decideEdgeRecovery(state, baseRecoveryCtx({ userNavigated: true })),
    { act: "stop", reason: "user_navigated" },
  );
});

test("decideEdgeRecovery: edges_present stops — arrows exist, nothing to do", () => {
  const state = createEdgeRecovery();
  assert.equal(decideEdgeRecovery(state, baseRecoveryCtx({ spatial: 1 })).reason, "edges_present");
  assert.equal(decideEdgeRecovery(state, baseRecoveryCtx({ spatial: 4 })).reason, "edges_present");
});

test("decideEdgeRecovery: attempts_exhausted stops at the hard bound", () => {
  const state = { attempts: EDGE_RECOVERY_MAX_ATTEMPTS, done: false };
  assert.deepEqual(
    decideEdgeRecovery(state, baseRecoveryCtx({ spatial: 0 })),
    { act: "stop", reason: "attempts_exhausted" },
  );
});

test("decideEdgeRecovery: frozen is a SKIP, not a stop — a next round is not poisoned", () => {
  const state = createEdgeRecovery();
  const decision = decideEdgeRecovery(state, baseRecoveryCtx({ moveEnabled: false }));
  assert.deepEqual(decision, { act: "skip", reason: "frozen" });
  assert.deepEqual(state, { attempts: 0, done: false }, "a skip never mutates the passed-in state");
});

test("decideEdgeRecovery: in_flight is a skip — never during a load", () => {
  const state = createEdgeRecovery();
  assert.deepEqual(
    decideEdgeRecovery(state, baseRecoveryCtx({ inFlight: true })),
    { act: "skip", reason: "in_flight" },
  );
});

test("decideEdgeRecovery: unknown (null) triggers an attempt with trigger 'uncached'", () => {
  const state = createEdgeRecovery();
  assert.deepEqual(
    decideEdgeRecovery(state, baseRecoveryCtx({ spatial: null })),
    { act: "attempt", reason: "uncached", trigger: "uncached" },
  );
});

test("decideEdgeRecovery: a cached zero triggers an attempt with trigger 'zero' — unknown != zero", () => {
  const state = createEdgeRecovery();
  assert.deepEqual(
    decideEdgeRecovery(state, baseRecoveryCtx({ spatial: 0 })),
    { act: "attempt", reason: "zero", trigger: "zero" },
  );
});

test("decideEdgeRecovery: precedence — edges_present beats frozen", () => {
  const state = createEdgeRecovery();
  const decision = decideEdgeRecovery(state, baseRecoveryCtx({ spatial: 2, moveEnabled: false }));
  assert.equal(decision.reason, "edges_present");
});

test("decideEdgeRecovery: precedence — done beats attempts remaining and everything else", () => {
  const state = { attempts: 0, done: true };
  const decision = decideEdgeRecovery(state, baseRecoveryCtx({ spatial: null, userNavigated: true }));
  assert.equal(decision.reason, "done");
});

test("decideEdgeRecovery: precedence — attempts_exhausted beats frozen/in_flight", () => {
  const state = { attempts: EDGE_RECOVERY_MAX_ATTEMPTS, done: false };
  assert.equal(
    decideEdgeRecovery(state, baseRecoveryCtx({ spatial: 0, moveEnabled: false, inFlight: true })).reason,
    "attempts_exhausted",
  );
});

test("mutation guard: a state with one attempt already made must still be allowed a second — " +
  "a cap of 1 would stop here and the real re-fetch would never fire", () => {
    // Correction #1 (field-verified against MapillaryJS 4.1.2): attempt 1
    // (trigger "uncached") only ever converts a stuck uncached status to
    // cached-ZERO, WITHOUT issuing HTTP. Only attempt 2 (trigger "zero")
    // re-issues the real fetch that restores arrows. If the cap were 1, this
    // exact state (one attempt already spent, spatial now a cached 0) would
    // read attempts_exhausted instead — recovery would silently give up
    // right where the real fix is one attempt away.
    const state = { attempts: 1, done: false };
    const decision = decideEdgeRecovery(state, baseRecoveryCtx({ spatial: 0 }));
    assert.equal(decision.act, "attempt", "the real cap (2) allows the recovering second attempt");
    assert.equal(decision.trigger, "zero");
    assert.equal(EDGE_RECOVERY_MAX_ATTEMPTS, 2, "the constant this test depends on");
  });

test("classifyEdgeRecoveryOutcome: truth table", () => {
  assert.equal(classifyEdgeRecoveryOutcome(4, false), "recovered");
  assert.equal(classifyEdgeRecoveryOutcome(1, false), "recovered");
  assert.equal(classifyEdgeRecoveryOutcome(0, false), "no_change");
  assert.equal(classifyEdgeRecoveryOutcome(null, false), "no_change");
  assert.equal(classifyEdgeRecoveryOutcome(0, true), "error");
  assert.equal(classifyEdgeRecoveryOutcome(null, true), "error");
  assert.equal(
    classifyEdgeRecoveryOutcome(4, true), "error",
    "setFilterFailed wins even over a stray count that looks recovered (stub/dispose race)",
  );
});

test("classifyEdgeRecoveryOutcome: a blocked graph API is no_change, never error — " +
  "setFilter()'s promise resolves even while the API 500s (correction #3)", () => {
    assert.equal(classifyEdgeRecoveryOutcome(0, false), "no_change");
    assert.equal(classifyEdgeRecoveryOutcome(null, false), "no_change");
  });

test("edge recovery constants: the bounds ARE the design — guards accidental hot-loop edits", () => {
  assert.ok(Number.isInteger(EDGE_RECOVERY_MAX_ATTEMPTS));
  assert.ok(
    EDGE_RECOVERY_MAX_ATTEMPTS >= 2 && EDGE_RECOVERY_MAX_ATTEMPTS <= 3,
    "the two-step recovery (uncached->cached-zero, then zero->real fetch) needs at least 2 attempts",
  );
  for (const ms of [EDGE_RECOVERY_GRACE_MS, EDGE_RECOVERY_RECHECK_MS, EDGE_RECOVERY_BACKOFF_MS]) {
    assert.ok(Number.isFinite(ms) && ms >= 1000, "every delay is finite and at least 1s");
  }
});

test("pano fold: the edges event latches the ANCHOR's counts once per round", () => {
  let s = session();
  assert.equal(s.anchor_spatial_edges, null, "unknown until observed");
  s = foldPanoEvent(s, { type: "edges", spatial: 4, sequence: 2, at: 1100 });
  assert.equal(s.anchor_spatial_edges, 4);
  assert.equal(s.anchor_sequence_edges, 2);
  // A later image (the player walked to a new place) must NOT overwrite the
  // anchor's recorded edges.
  s = foldPanoEvent(s, { type: "edges", spatial: 9, sequence: 1, at: 1200 });
  assert.equal(s.anchor_spatial_edges, 4, "the anchor count is latched, not overwritten");
  assert.equal(s.anchor_sequence_edges, 2);
  // An edges event is not an interaction — it must not start first_move_ms.
  assert.equal(s.first_move_ms, null);
});

test("pano fold: an unknown (null) edge count can be filled by a later cached one", () => {
  let s = session();
  s = foldPanoEvent(s, { type: "edges", spatial: null, sequence: null, at: 1100 });
  assert.equal(s.anchor_spatial_edges, null, "an unknown observation fills nothing");
  s = foldPanoEvent(s, { type: "edges", spatial: 0, sequence: null, at: 1200 });
  assert.equal(s.anchor_spatial_edges, 0, "a real cached zero IS a known count");
  s = foldPanoEvent(s, { type: "edges", spatial: 5, sequence: 3, at: 1300 });
  assert.equal(s.anchor_spatial_edges, 0, "once known, never overwritten");
  assert.equal(s.anchor_sequence_edges, 3, "the still-unknown sequence count fills in");
});

test("pano fold: edge counts fold bounded (a malformed huge count is capped)", () => {
  let s = session();
  s = foldPanoEvent(s, { type: "edges", spatial: 9999, sequence: -3, at: 1100 });
  assert.equal(s.anchor_spatial_edges, EDGE_COUNT_CAP);
  assert.equal(s.anchor_sequence_edges, 0);
});

test("panoSessionProps: edge counts appear only when known, as ints", () => {
  let s = session();
  assert.ok(!("anchor_spatial_edges" in panoSessionProps(s)),
    "an unknown anchor edge count is absent, not a false 0");
  s = foldPanoEvent(s, { type: "edges", spatial: 3, sequence: 0, at: 1100 });
  const p = panoSessionProps(s);
  assert.equal(p.anchor_spatial_edges, 3);
  assert.equal(p.anchor_sequence_edges, 0, "a KNOWN zero is reported");
});

/* ================================================================
 * §9.1 Session health — healthy / degraded / failed, failed wins
 * ================================================================ */

const healthyFacts = () => ({
  viewerInits: [{ ok: true, error_class: null }],
  loads: [
    { purpose: "anchor", ok: true, duration_ms: 1800, skips: 0 },
    { purpose: "anchor", ok: true, duration_ms: 2200, skips: 0 },
  ],
  panos: [{ nav_available: true, nav_failures: 0, pointer_downs: 4, looks: 9, move_enabled: true }],
  exceptions: [],
  reports: 0,
  roundsIncomplete: false,
});

test("health: a clean session is healthy", () => {
  assert.equal(classifySessionHealth(healthyFacts()), HEALTH_HEALTHY);
  assert.equal(classifySessionHealth({}), HEALTH_HEALTHY, "no data ≠ unhealthy");
  assert.equal(shouldForceRecording(healthyFacts()), false);
});

test("health: degraded — slow, late, skipped, nav-broken, gesture-blocked", () => {
  const cases = {
    slow: (f) => { f.loads[0].duration_ms = SLOW_LOAD_MS; },
    late: (f) => { f.loads[0].late = true; },
    skipped: (f) => { f.loads[0].skips = 1; },
    navFailed: (f) => { f.panos[0].nav_failures = 2; },
    noNeighbors: (f) => { f.exceptions.push({ error_class: "no_neighbors" }); },
    gestureBlocked: (f) => { f.panos[0].looks = 0; },
    softFailure: (f) => {
      f.loads.push({ purpose: "follow", ok: false, error_class: "http_server" });
    },
    incomplete: (f) => { f.roundsIncomplete = true; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const f = healthyFacts();
    mutate(f);
    assert.equal(classifySessionHealth(f), HEALTH_DEGRADED, name);
    assert.equal(shouldForceRecording(f), true, name);
  }
});

test("health: a cancelled load is churn, not degradation", () => {
  const f = healthyFacts();
  f.loads.push({ purpose: "anchor", ok: false, error_class: "cancelled" });
  assert.equal(classifySessionHealth(f), HEALTH_HEALTHY);
});

test("health: failed — the player saw a broken game", () => {
  const cases = {
    exhausted: (f) => {
      f.loads.push({ purpose: "anchor", ok: false, error_class: "image_dead", exhausted: true });
    },
    viewerInit: (f) => { f.viewerInits.push({ ok: false, error_class: "viewer_init" }); },
    webglGone: (f) => { f.exceptions.push({ error_class: "webgl_unavailable" }); },
    contextLost: (f) => { f.exceptions.push({ error_class: "webgl_context_lost" }); },
    auth: (f) => { f.exceptions.push({ error_class: "http_auth" }); },
    reported: (f) => { f.reports = 1; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const f = healthyFacts();
    mutate(f);
    assert.equal(classifySessionHealth(f), HEALTH_FAILED, name);
  }
});

test("health: an uncorrected timeout fails; a late success only degrades", () => {
  const f = healthyFacts();
  f.exceptions.push({ error_class: "network_timeout" });
  assert.equal(classifySessionHealth(f), HEALTH_FAILED);

  const g = healthyFacts();
  g.exceptions.push({ error_class: "network_timeout" });
  g.loads.push({ purpose: "anchor", ok: true, late: true, duration_ms: 24000 });
  assert.equal(classifySessionHealth(g), HEALTH_DEGRADED, "the late success corrects it");
});

test("health: a skip that still landed a pano is degraded, never failed", () => {
  const f = healthyFacts();
  f.loads[0].skips = 3;                     // burned three entries...
  f.loads[0].ok = true;                     // ...but the round played
  assert.equal(classifySessionHealth(f), HEALTH_DEGRADED);
});

test("health: precedence is failed > degraded > healthy", () => {
  const f = healthyFacts();
  f.loads[0].skips = 2;                       // degraded signal
  f.viewerInits.push({ ok: false });          // failed signal
  assert.equal(classifySessionHealth(f), HEALTH_FAILED);
});

test("health: nav failures only count where movement was offered", () => {
  const f = healthyFacts();
  f.panos = [{ nav_available: false, nav_failures: 3, pointer_downs: 1, looks: 1, move_enabled: false }];
  assert.equal(classifySessionHealth(f), HEALTH_HEALTHY);
});

test("health (#2): a move-enabled session without `navigable` is NOT degraded", () => {
  // The whole bug: `navigable` never emits usefully, so nav_available has been
  // false for every historical session. A move-enabled round with NO genuine
  // navigation failure must read healthy — a missing nav_available signal is
  // no longer, by itself, evidence of a broken game.
  const f = healthyFacts();
  f.panos = [{
    nav_available: false, nav_failures: 0, pointer_downs: 4, looks: 9,
    move_enabled: true,
  }];
  assert.equal(classifySessionHealth(f), HEALTH_HEALTHY,
    "a false nav_available alone must not mark the session degraded");
  // A GENUINE nav failure on the same move-enabled round still degrades.
  f.panos[0].nav_failures = 1;
  assert.equal(classifySessionHealth(f), HEALTH_DEGRADED,
    "a real nav_failure is still preserved as a degraded signal");
});

/* ================================================================
 * §9.3 client-side recording override
 * ================================================================ */

test("shouldForceRecordingForLoad: every degraded/failed load forces recording", () => {
  assert.equal(shouldForceRecordingForLoad({ ok: false, error_class: "image_dead" }), true);
  assert.equal(shouldForceRecordingForLoad({ ok: true, late: true }), true);
  assert.equal(shouldForceRecordingForLoad({ ok: true, duration_ms: SLOW_LOAD_MS }), true);
  assert.equal(shouldForceRecordingForLoad({ ok: true, skips: 2 }), true);
});

test("shouldForceRecordingForLoad: healthy loads and churn do not", () => {
  assert.equal(shouldForceRecordingForLoad({ ok: true, duration_ms: 900, skips: 0 }), false);
  assert.equal(shouldForceRecordingForLoad({ ok: true, skips: 1 }), false);
  assert.equal(shouldForceRecordingForLoad({ ok: false, error_class: "cancelled" }), false);
  assert.equal(shouldForceRecordingForLoad(null), false);
});

/* ================================================================
 * §10 Reference codes, ring buffer, report bundle
 * ================================================================ */

test("makeRefCode: GP- + 6 unambiguous Crockford chars, deterministic", () => {
  const code = makeRefCode("sess-abc", 1);
  assert.match(code, REF_CODE_RE);
  assert.equal(code, makeRefCode("sess-abc", 1));
  assert.notEqual(code, makeRefCode("sess-abc", 2));
  assert.notEqual(code, makeRefCode("sess-abd", 1));
  assert.ok(!/[ILOU]/.test(code), "no letters that misread when spoken");
});

test("makeRefCode: no collisions across many sessions × reports", () => {
  const seen = new Set();
  for (let s = 0; s < 400; s++) {
    for (let n = 1; n <= 5; n++) seen.add(makeRefCode(`session-${s}`, n));
  }
  assert.equal(seen.size, 2000);
});

test("makeRefCode: works with no session id at all (declined user)", () => {
  assert.match(makeRefCode(null, 0), REF_CODE_RE);
  assert.match(makeRefCode("", 1), REF_CODE_RE);
});

test("imagery log: bounded ring buffer, failures only", () => {
  const l = createImageryLog(3);
  l.record({ error_class: "cancelled", pool_entry: "a" });
  l.record({ error_class: "image_dead", pool_entry: "b" });
  l.record({ error_class: "http_server", pool_entry: "c" });
  l.record({ error_class: "network_timeout", pool_entry: "d" });
  assert.equal(l.count(), 3, "oldest entry evicted");
  assert.equal(l.last().pool_entry, "d");
  assert.deepEqual(l.failures().map((e) => e.pool_entry), ["b", "c", "d"]);
  l.record(null);
  assert.equal(l.count(), 3);
});

test("report bundle: aggregates only, keyed on the LAST failure", () => {
  const props = buildReportBundle({
    surface: "player",
    ref_code: "GP-ABC123",
    failures: [
      { error_class: "image_dead", pool_entry: "aaaa1111" },
      { error_class: "network_timeout", pool_entry: "bbbb2222" },
    ],
    net_type: "3g",
    online: true,
    consent: "one_time",
  });
  assert.deepEqual(props, {
    surface: "player", ref_code: "GP-ABC123", error_class: "network_timeout",
    net_type: "3g", online: true, recent_failures: 2, consent: "one_time",
    pool_entry: "bbbb2222",
  });
});

test("report bundle: a report with no failure on record is still valid", () => {
  const props = buildReportBundle({ surface: "host", ref_code: "GP-ZZZZZZ" });
  assert.equal(props.error_class, "none");
  assert.equal(props.recent_failures, 0);
  assert.equal(props.consent, "analytics", "default is the consented path");
  assert.ok(!("pool_entry" in props), "no empty pool_entry noise");
});

test("report bundle: never carries free text or a coordinate-ish key", () => {
  const props = buildReportBundle({
    surface: "player", ref_code: "GP-ABC123",
    lat: 51.5, lng: -0.1, teamName: "The Wanderers", note: "it broke",
    failures: [],
  });
  const keys = Object.keys(props);
  for (const banned of ["lat", "lng", "teamName", "note"]) {
    assert.ok(!keys.includes(banned), banned);
  }
});

/* ================================================================
 * §13 quarantine filter + §15 chaos gate
 * ================================================================ */

const poolOf = (...ids) => ids.map((id) => ({ image_id: id }));

test("filterQuarantined: removes listed ids, keeps the rest", () => {
  const out = filterQuarantined(poolOf("a", "b", "c"), ["b"]);
  assert.deepEqual(out.map((e) => e.image_id), ["a", "c"]);
});

test("filterQuarantined: absent / empty / non-array list is a no-op", () => {
  const pool = poolOf("a", "b");
  assert.equal(filterQuarantined(pool, undefined), pool);
  assert.equal(filterQuarantined(pool, []), pool);
  assert.equal(filterQuarantined(pool, null), pool);
  assert.equal(filterQuarantined(pool, "b"), pool);
});

test("filterQuarantined: numeric ids in the file still match string ids", () => {
  const out = filterQuarantined(poolOf("123", "456"), [123]);
  assert.deepEqual(out.map((e) => e.image_id), ["456"]);
});

test("filterQuarantined: a bad PR cannot brick the game by emptying the pool", () => {
  const pool = poolOf("a", "b");
  assert.equal(filterQuarantined(pool, ["a", "b"]), pool);
});

test("chaosAllowed: dev hosts only — production can never be told to fail", () => {
  for (const h of ["localhost", "127.0.0.1", "::1", "[::1]", ""]) {
    assert.equal(chaosAllowed(h), true, h);
  }
  for (const h of ["geoparty.example", "earino.github.io", "evil.localhost.com",
    "localhost.attacker.net", "10.0.0.5"]) {
    assert.equal(chaosAllowed(h), false, h);
  }
});

test("isDeadEntryClass: ONLY image_dead is a deterministic pool skip", () => {
  // Skipping past a live seeded entry on anything but a provably-dead entry
  // desyncs the Daily's shared order (review P2-5) and burns the pool for
  // nothing (P1-3), so the sampler advances on image_dead alone.
  assert.deepEqual(DEAD_ENTRY_CLASSES, ["image_dead"]);
  assert.equal(isDeadEntryClass("image_dead"), true);
  for (const cls of [
    "network_timeout", "network_offline", "http_rate_limit", "http_server",
    "http_auth", "webgl_unavailable", "webgl_context_lost", "viewer_init",
    "no_neighbors", "sdk_unknown", "cancelled", undefined, null, "",
  ]) {
    assert.equal(isDeadEntryClass(cls), false, `${cls} must not skip a live entry`);
  }
});
