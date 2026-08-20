// Tests for js/viewer-ui.js — the instrumented Mapillary wrapper, driven
// through the §15 failure-injection matrix of docs/field-observability-plan.md.
//
// viewer-ui.js is browser glue, so this file stands up a deliberately small
// fake browser (DOM, navigator, performance, a fake posthog and a fake
// MapillaryJS) and then injects real failures through the same
// `window.__gpChaos` hooks the manual on-device runbook uses. That makes the
// A–G scenarios reproducible in CI instead of a one-off checklist:
//
//   A rejected moveTo      → imagery_load{ok:false,image_dead} + one issue
//   B timeout + late win   → network_timeout, then ok:true/after_timeout
//   C 429                  → http_rate_limit
//   D PostHog blocked      → nothing throws, capture silently off
//   E offline mid-round    → network_offline
//   F no neighbours        → no_neighbors + nav_available:false
//   G handled skip         → one imagery_load{skips:n}, one deduped issue
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

/* ================================================================
 * A very small fake browser
 * ================================================================ */

function makeElement(tag) {
  const classes = new Set();
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    listeners: {},
    dataset: {},
    style: {},
    _text: "",
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); this.children.length = 0; },
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, on) => (on === undefined
        ? (classes.has(c) ? classes.delete(c) : classes.add(c))
        : (on ? classes.add(c) : classes.delete(c))),
      contains: (c) => classes.has(c),
    },
    setAttribute() {},
    append(...kids) { this.children.push(...kids); },
    appendChild(kid) { this.children.push(kid); return kid; },
    addEventListener(name, fn) {
      (this.listeners[name] = this.listeners[name] || []).push(fn);
    },
    removeEventListener(name, fn) {
      const l = this.listeners[name] || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
    dispatch(name, ev) {
      for (const fn of (this.listeners[name] || []).slice()) fn(ev || {});
    },
    querySelector(sel) {
      if (sel === "canvas") return this._canvas || null;
      return this.children.find((c) => c && c.className &&
        String(c.className).includes(sel.replace(".", ""))) || null;
    },
    cloneNode() { return makeElement(tag); },
    replaceWith() {},
    remove() {},
  };
  return el;
}

function installFakeBrowser() {
  const store = new Map();
  const byId = new Map();

  const doc = {
    head: makeElement("head"),
    body: makeElement("body"),
    createElement: (tag) => makeElement(tag),
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, makeElement("div"));
      return byId.get(id);
    },
  };

  const posthog = {
    __loaded: false,
    captured: [],
    exceptions: [],
    superProps: {},
    recordings: 0,
    init() { this.__loaded = true; return this; },
    capture(event, props) { this.captured.push({ event, props }); },
    captureException(error, props) { this.exceptions.push({ error, props }); },
    register(p) { Object.assign(this.superProps, p); },
    startSessionRecording() { this.recordings++; },
    stopSessionRecording() { this.recordings--; },
    get_session_id: () => "fake-session-1",
    onFeatureFlags() {},
    isFeatureEnabled: () => true,
    opt_out_capturing() { this.optedOut = true; },
    opt_in_capturing() { this.optedOut = false; },
    reset() { this.captured.length = 0; this.exceptions.length = 0; this.recordings = 0; },
  };

  const define = (name, value) =>
    Object.defineProperty(globalThis, name,
      { value, configurable: true, writable: true });

  define("window", {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    posthog,
    matchMedia: () => ({ matches: false }),
  });
  define("document", doc);
  define("location", { hostname: "localhost", pathname: "/host.html" });
  define("navigator", { onLine: true, connection: { effectiveType: "4g" } });
  define("fetch", () => Promise.resolve({ ok: false, status: 404 }));

  // Consent is ACCEPTED for this whole file: the wrapper's capture paths are
  // what we are testing. The "no consent" half of the gate is proved in
  // tests/analytics.test.js, which exercises it directly.
  store.set("geoparty_analytics_consent", "accepted");

  return { doc, posthog, byId };
}

/* ---------------- a fake MapillaryJS ---------------- */

function installFakeMapillary() {
  const state = { supported: true, constructThrows: null, viewers: [] };
  class FakeViewer {
    constructor(opts) {
      if (state.constructThrows) throw new Error(state.constructThrows);
      this.opts = opts;
      this.handlers = {};
      this.removed = false;
      state.viewers.push(this);
    }
    on(name, fn) { (this.handlers[name] = this.handlers[name] || []).push(fn); }
    emit(name, ev) { for (const fn of this.handlers[name] || []) fn(ev); }
    moveTo() { return Promise.resolve(); }   // chaos overrides this in tests
    remove() { this.removed = true; }
    resize() {}
  }
  globalThis.mapillary = {
    Viewer: FakeViewer,
    isSupported: () => state.supported,
  };
  return state;
}

/* ================================================================
 * harness
 * ================================================================ */

let env;
let mly;
let viewerUi;

before(async () => {
  env = installFakeBrowser();
  mly = installFakeMapillary();
  // Import AFTER the globals exist — consent.js boots on import.
  viewerUi = await import("../js/viewer-ui.js");
  await new Promise((r) => setTimeout(r, 0));
});

beforeEach(() => {
  env.posthog.reset();
  mly.supported = true;
  mly.constructThrows = null;
  globalThis.navigator.onLine = true;
  window.__gpChaos = {};
});

const events = (name) => env.posthog.captured.filter((c) => c.event === name);
const lastEvent = (name) => events(name).slice(-1)[0];

// A pool sampler double with the exact PoolSampler contract.
function sampler(...ids) {
  return {
    order: ids.map((id) => ({ image_id: id })),
    cursor: 0,
    peek() { return this.cursor < this.order.length ? this.order[this.cursor] : null; },
    advance() { this.cursor++; return this.peek(); },
  };
}

const HOST_COMPONENT = { cover: false, direction: true, sequence: true };
const makeHostViewer = () => viewerUi.createViewer({
  surface: "host", container: "hostViewer", moveAllowed: true,
  component: HOST_COMPONENT,
});

/* ================================================================
 * Baseline: a healthy load
 * ================================================================ */

test("healthy: a successful moveTo emits one ok imagery_load, no issue", async () => {
  const iv = makeHostViewer();
  await iv.moveTo("1263588815098567", "anchor");
  const ev = lastEvent("imagery_load");
  assert.equal(ev.props.ok, true);
  assert.equal(ev.props.purpose, "anchor");
  assert.equal(ev.props.surface, "host");
  assert.equal(ev.props.skips, 0);
  assert.equal(ev.props.net_type, "4g");
  assert.match(ev.props.pool_entry, /^[0-9a-z]{8}$/);
  assert.equal(env.posthog.exceptions.length, 0);
  assert.equal(env.posthog.recordings, 0, "a healthy load forces no recording");
  iv.destroy();
});

test("healthy: viewer_init reports construction, WebGL support and the SDK pin", () => {
  const iv = makeHostViewer();
  const ev = lastEvent("viewer_init");
  assert.equal(ev.props.ok, true);
  assert.equal(ev.props.webgl, true);
  assert.equal(ev.props.sdk, "4.1.2");
  assert.ok(!("error_class" in ev.props));
  iv.destroy();
});

test("healthy: the raw image id never appears in any captured property", async () => {
  const iv = makeHostViewer();
  await iv.moveTo("1263588815098567", "anchor");
  const blob = JSON.stringify(env.posthog.captured);
  assert.ok(!blob.includes("1263588815098567"), blob);
  iv.destroy();
});

/* ================================================================
 * A — a rejected moveTo (dead image)
 * ================================================================ */

test("A: a rejected moveTo classifies, reports, and RETHROWS to the caller", async () => {
  window.__gpChaos.moveTo = () =>
    Promise.reject(new Error("Image 1263588815098567 does not exist"));
  const iv = makeHostViewer();

  await assert.rejects(() => iv.moveTo("1263588815098567", "anchor"),
    /does not exist/, "the caller's own catch still sees the original error");

  const ev = lastEvent("imagery_load");
  assert.equal(ev.props.ok, false);
  assert.equal(ev.props.error_class, "image_dead");
  assert.equal(env.posthog.exceptions.length, 1);
  const ex = env.posthog.exceptions[0];
  assert.equal(ex.error.name, "ImageryError");
  assert.ok(!ex.error.message.includes("1263588815098567"), "id scrubbed");
  assert.equal(ex.props.error_class, "image_dead");
  assert.equal(ex.props.pool_entry, ev.props.pool_entry);
  assert.equal(env.posthog.recordings, 1, "a failure forces the session to record");
  iv.destroy();
});

/* ================================================================
 * B — timeout, and the late success that corrects it
 * ================================================================ */

test("B: a moveTo that never settles times out as network_timeout", async () => {
  window.__gpChaos.timeoutMs = 5;                 // §15 dev-host knob
  window.__gpChaos.moveTo = () => new Promise(() => {});   // never settles
  const iv = makeHostViewer();

  await assert.rejects(() => iv.moveTo("123456789012345", "anchor"),
    /timed out/, "the caller sees a rejection instead of hanging forever");

  const ev = lastEvent("imagery_load");
  assert.equal(ev.props.ok, false);
  assert.equal(ev.props.error_class, "network_timeout");
  assert.ok(ev.props.duration_ms >= 5);
  assert.equal(env.posthog.exceptions.slice(-1)[0].props.error_class,
    "network_timeout");
  iv.destroy();
});

test("B: a late SDK success after the timeout corrects the record", async () => {
  window.__gpChaos.timeoutMs = 5;
  window.__gpChaos.moveTo = () =>
    new Promise((res) => setTimeout(res, 40));    // finishes long after 5ms
  const iv = makeHostViewer();

  await assert.rejects(() => iv.moveTo("123456789012345", "anchor"));
  assert.equal(lastEvent("imagery_load").props.error_class, "network_timeout");

  await new Promise((r) => setTimeout(r, 80));    // let the SDK land late
  const corrected = lastEvent("imagery_load");
  assert.equal(corrected.props.ok, true);
  assert.equal(corrected.props.after_timeout, true,
    "a late success must not leave a timeout standing against a working load");
  iv.destroy();
});

test("B: a timeout does NOT tear the viewer down (plan §6.1)", async () => {
  window.__gpChaos.timeoutMs = 5;
  window.__gpChaos.moveTo = () => new Promise(() => {});
  const iv = makeHostViewer();
  await iv.moveTo("123456789012345", "anchor").catch(() => {});
  assert.equal(iv.viewer.removed, false);
  iv.destroy();
});

/* ================================================================
 * C — 429 rate limiting
 * ================================================================ */

test("C: a 429 from the Graph API classifies http_rate_limit", async () => {
  window.__gpChaos.moveTo = () =>
    Promise.reject(new Error("Request failed with status 429"));
  const iv = makeHostViewer();
  await assert.rejects(() => iv.moveTo("111111111111111", "anchor"));
  assert.equal(lastEvent("imagery_load").props.error_class, "http_rate_limit");
  assert.equal(env.posthog.exceptions[0].props.error_class, "http_rate_limit");
  iv.destroy();
});

/* ================================================================
 * E — offline mid-round
 * ================================================================ */

test("E: offline mid-round classifies network_offline and marks online:false",
  async () => {
    globalThis.navigator.onLine = false;
    window.__gpChaos.moveTo = () => Promise.reject(new Error("Failed to fetch"));
    const iv = makeHostViewer();
    await assert.rejects(() => iv.moveTo("222222222222222", "anchor"));
    const ev = lastEvent("imagery_load");
    assert.equal(ev.props.error_class, "network_offline");
    assert.equal(ev.props.online, false);
    iv.destroy();
  });

/* ================================================================
 * F — no neighbours (navigation dead-end)
 * ================================================================ */

test("F: a nav failure counts into pano_session and reports no_neighbors",
  async () => {
    const iv = makeHostViewer();
    iv.beginRound(2);
    iv.viewer.emit("navigable", { navigable: false });
    window.__gpChaos.moveTo = () =>
      Promise.reject(new Error("No navigable edges in direction"));
    await assert.rejects(() => iv.moveTo("333333333333333", "nav"));
    iv.endRound();

    const pano = lastEvent("pano_session");
    assert.equal(pano.props.nav_available, false);
    assert.equal(pano.props.nav_failures, 1);
    assert.equal(pano.props.round_number, 2);
    assert.equal(lastEvent("imagery_load").props.error_class, "no_neighbors");
    iv.destroy();
  });

/* ================================================================
 * G — the handled skip loop
 * ================================================================ */

test("G: the skip loop emits ONE imagery_load carrying the skip count", async () => {
  const dead = new Set(["dead-a", "dead-b"]);
  window.__gpChaos.moveTo = (id) => (dead.has(id)
    ? Promise.reject(new Error("Node does not exist"))
    : Promise.resolve());
  const iv = makeHostViewer();
  const s = sampler("dead-a", "dead-b", "good-1", "good-2");

  const { entry, skips } = await viewerUi.loadRoundImage(s, iv, "anchor");
  assert.equal(entry.image_id, "good-1");
  assert.equal(skips, 2);
  assert.equal(s.cursor, 2, "the cursor sits on the entry that loaded");

  assert.equal(events("imagery_load").length, 1, "one event for the whole loop");
  const ev = lastEvent("imagery_load");
  assert.equal(ev.props.ok, true);
  assert.equal(ev.props.skips, 2);
  assert.equal(env.posthog.recordings, 1, "skips >= 2 forces recording");
  iv.destroy();
});

test("G: image_dead exceptions are deduped per pool entry, per session", async () => {
  window.__gpChaos.moveTo = () => Promise.reject(new Error("Node does not exist"));
  const iv = makeHostViewer();
  const before = env.posthog.exceptions.length;
  // The same entry retried three times must produce at most one issue.
  await iv.moveTo("dedupe-me", "anchor").catch(() => {});
  await iv.moveTo("dedupe-me", "anchor").catch(() => {});
  await iv.moveTo("dedupe-me", "anchor").catch(() => {});
  assert.equal(env.posthog.exceptions.length - before, 1);
  iv.destroy();
});

test("G: an exhausted pool reports a failed load and stops the loop", async () => {
  window.__gpChaos.moveTo = () => Promise.reject(new Error("Node does not exist"));
  const iv = makeHostViewer();
  const s = sampler("x1", "x2", "x3");
  const { entry, skips } = await viewerUi.loadRoundImage(s, iv, "anchor");
  assert.equal(entry, null, "the caller's pool-exhausted path takes over");
  assert.equal(skips, 3);
  const ev = lastEvent("imagery_load");
  assert.equal(ev.props.ok, false);
  assert.equal(ev.props.skips, 3);
  iv.destroy();
});

/* ================================================================
 * cancelled — expected churn, never an issue
 * ================================================================ */

test("cancelled: counted as an event, never captured as an exception", async () => {
  window.__gpChaos.moveTo = () =>
    Promise.reject(new Error("moveTo was cancelled by a newer request"));
  const iv = makeHostViewer();
  const before = env.posthog.exceptions.length;
  await assert.rejects(() => iv.moveTo("444444444444444", "anchor"));
  assert.equal(lastEvent("imagery_load").props.error_class, "cancelled");
  assert.equal(env.posthog.exceptions.length, before, "no issue for churn");
  assert.equal(env.posthog.recordings, 0, "and no forced recording");
  iv.destroy();
});

/* ================================================================
 * Construction failures and the degradation stub
 * ================================================================ */

test("viewer_init: no WebGL yields a stub whose moveTo always rejects", async () => {
  mly.supported = false;
  const iv = makeHostViewer();
  assert.equal(iv.ok, false);
  assert.equal(iv.viewer, null, "callers' `if (viewer)` guards degrade");
  const ev = lastEvent("viewer_init");
  assert.equal(ev.props.ok, false);
  assert.equal(ev.props.error_class, "webgl_unavailable");
  assert.equal(ev.props.webgl, false);
  await assert.rejects(() => iv.moveTo("x", "anchor"));
  iv.destroy();   // must not throw on a stub
});

test("viewer_init: a throwing constructor is classified, not swallowed", () => {
  mly.constructThrows = "container element is not valid";
  const iv = makeHostViewer();
  assert.equal(iv.ok, false);
  assert.equal(lastEvent("viewer_init").props.error_class, "viewer_init");
  assert.equal(env.posthog.exceptions.slice(-1)[0].props.error_class, "viewer_init");
  iv.destroy();
});

test("viewer_init: a stub short-circuits the skip loop (never burns the pool)",
  async () => {
    mly.supported = false;
    const iv = makeHostViewer();
    const s = sampler(...Array.from({ length: 500 }, (_, i) => `id-${i}`));
    const { entry, skips } = await viewerUi.loadRoundImage(s, iv, "anchor");
    assert.equal(entry, null);
    assert.equal(skips, 0);
    assert.equal(s.cursor, 0, "not one pool entry was consumed");
    iv.destroy();
  });

/* ================================================================
 * webglcontextlost — the silent killer
 * ================================================================ */

test("webglcontextlost on the canvas becomes a classified issue", () => {
  const container = document.getElementById("hostViewer");
  const canvas = makeElement("canvas");
  container._canvas = canvas;
  const iv = makeHostViewer();
  canvas.dispatch("webglcontextlost", {});
  const ex = env.posthog.exceptions.slice(-1)[0];
  assert.equal(ex.props.error_class, "webgl_context_lost");
  assert.ok(env.posthog.recordings >= 1);
  container._canvas = null;
  iv.destroy();
});

/* ================================================================
 * pano_session — the interaction fold, end to end
 * ================================================================ */

test("pano_session: pov/fov/image events fold into one event per round", () => {
  const iv = makeHostViewer();
  iv.beginRound(4);
  iv.viewer.emit("pov", {});
  iv.viewer.emit("fov", {});
  iv.viewer.emit("navigable", { navigable: true });
  iv.viewer.emit("image", { image: { id: "neighbour-1" } });  // user navigated
  iv.noteReanchor();
  document.getElementById("hostViewer").dispatch("pointerdown", {});
  iv.endRound();

  const ev = lastEvent("pano_session");
  assert.equal(ev.props.surface, "host");
  assert.equal(ev.props.round_number, 4);
  assert.equal(ev.props.looks, 1);
  assert.equal(ev.props.zoom_changes, 1);
  assert.equal(ev.props.nav_moves, 1);
  assert.equal(ev.props.nav_available, true);
  assert.equal(ev.props.reanchors, 1);
  assert.equal(ev.props.pointer_downs, 1);
  iv.destroy();
});

test("pano_session: an image event we asked for is not a user navigation",
  async () => {
    const iv = makeHostViewer();
    iv.beginRound(1);
    await iv.moveTo("555555555555555", "anchor");
    iv.viewer.emit("image", { image: { id: "555555555555555" } });
    iv.endRound();
    assert.equal(lastEvent("pano_session").props.nav_moves, 0);
    iv.destroy();
  });

test("pano_session: beginRound flushes the previous round's fold", () => {
  const iv = makeHostViewer();
  iv.beginRound(1);
  iv.viewer.emit("pov", {});
  const before = events("pano_session").length;
  iv.beginRound(2);
  assert.equal(events("pano_session").length, before + 1);
  assert.equal(lastEvent("pano_session").props.round_number, 1);
  iv.destroy();
  assert.equal(lastEvent("pano_session").props.round_number, 2,
    "destroy flushes the open round too");
});

/* ================================================================
 * Session health, read through the wrapper's own accumulated facts
 * ================================================================ */

test("imagerySession: the health fold sees what the wrapper recorded", async () => {
  window.__gpChaos.moveTo = () => Promise.reject(new Error("401 Unauthorized"));
  const iv = makeHostViewer();
  await iv.moveTo("666666666666666", "anchor").catch(() => {});
  assert.equal(viewerUi.imagerySession().health(), "failed");
  assert.equal(viewerUi.imagerySession().log.failures().slice(-1)[0].error_class,
    "http_auth");
  iv.destroy();
});

/* ================================================================
 * D — chaos hooks are inert off a dev host
 * ================================================================ */

test("D: chaos hooks do nothing when the page is not on a dev host", async () => {
  globalThis.location.hostname = "geoparty.example";
  window.__gpChaos.moveTo = () => Promise.reject(new Error("chaos should not fire"));
  const iv = makeHostViewer();
  await iv.moveTo("777777777777777", "anchor");   // the REAL fake viewer resolves
  assert.equal(lastEvent("imagery_load").props.ok, true);
  iv.destroy();
  globalThis.location.hostname = "localhost";
});

test("D: a production page never exposes the __gpViewers harness handle", () => {
  globalThis.location.hostname = "geoparty.example";
  delete window.__gpViewers;
  const iv = makeHostViewer();
  assert.equal(window.__gpViewers, undefined);
  iv.destroy();
  globalThis.location.hostname = "localhost";
});
