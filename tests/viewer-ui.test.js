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
import { NAV_HINT_MAX_MS } from "../js/imagery.js";

/* ================================================================
 * A very small fake browser
 * ================================================================ */

// §18 render probe: the offscreen canary reads a module-level toggle so a test
// can force "GPU layer down" without reaching into the wrapper's private state.
let canaryDead = false;

function makeFakeGl(opts) {
  const o = opts || {};
  return {
    COLOR_BUFFER_BIT: 0x4000, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401,
    isContextLost: () => o.lost === true,
    clearColor() {}, clear() {},
    // Only the canary calls readPixels (clears to green → "ok"). canaryDead
    // makes it read black so probeCanaryOk() returns false.
    readPixels(x, y, w, h, fmt, type, px) {
      if (canaryDead) { px[0] = 0; px[1] = 0; px[2] = 0; px[3] = 255; }
      else { px[0] = 0; px[1] = 255; px[2] = 0; px[3] = 255; }
    },
    getExtension(name) {
      return name === "WEBGL_lose_context"
        ? { loseContext() { o.lost = true; } } : null;
    },
  };
}

function makeFake2dContext() {
  let src = null;
  return {
    clearRect() {},
    drawImage(cv) { src = cv; },
    getImageData(x, y, w, h) {
      const n = Math.max(4, (w || 1) * (h || 1) * 4);
      const data = new Uint8ClampedArray(n);   // all-zero = uniform (blank)
      if (src && src._content) data[4] = 255;  // one differing channel → content
      return { data };
    },
  };
}

// A canvas whose WebGL state the probe reads. ctxLost: true (dead context),
// false (healthy), or null (unreadable — no obtainable context). content: the
// pixel sample reads non-uniform ("content"), else uniform ("blank").
function makeCanvas({ ctxLost = false, content = true } = {}) {
  const cv = makeElement("canvas");
  cv.isConnected = true;
  cv._gl = ctxLost === null ? null : makeFakeGl({ lost: ctxLost });
  cv._content = content;
  return cv;
}

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
    append(...kids) { kids.forEach((k) => { if (k) k._parent = el; }); this.children.push(...kids); },
    appendChild(kid) { if (kid) kid._parent = el; this.children.push(kid); return kid; },
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
      // Minimal comma-selector support: matches an element carrying ANY of
      // the requested classes (real querySelector's ".a,.b" semantics),
      // enough for both the single-class `.pano-cover` lookups and the
      // multi-class NAV_ARROW_SELECTOR probe.
      const wants = String(sel).split(",").map((s) => s.trim().replace(/^\./, ""));
      return this.children.find((c) => c && c.className &&
        String(c.className).split(/\s+/).some((cn) => wants.includes(cn))) || null;
    },
    width: 0,
    height: 0,
    // A live element is connected unless a test says otherwise (the §18 probe
    // reads canvas.isConnected).
    isConnected: true,
    // §18 render probe: a canvas hands back a WebGL or 2D context. `_gl` is set
    // per-test (a lost context, an unreadable null); a canvas created for the
    // offscreen canary/sample lazily gets a healthy default.
    getContext(type) {
      if (type === "2d") {
        if (!this.__ctx2d) this.__ctx2d = makeFake2dContext();
        return this.__ctx2d;
      }
      if (this._gl !== undefined) return this._gl;
      if (String(tag).toLowerCase() === "canvas") {
        this._gl = makeFakeGl();
        return this._gl;
      }
      return null;
    },
    cloneNode() { return makeElement(tag); },
    replaceWith() {},
    remove() {
      if (this._parent && Array.isArray(this._parent.children)) {
        const i = this._parent.children.indexOf(this);
        if (i >= 0) this._parent.children.splice(i, 1);
      }
    },
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
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
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

  // A tiny event target so the wrapper's document/window listeners
  // (visibilitychange, pagehide — §18) register and can be dispatched.
  const eventTarget = (host) => {
    const listeners = {};
    host.addEventListener = (name, fn) => {
      (listeners[name] = listeners[name] || []).push(fn);
    };
    host.removeEventListener = (name, fn) => {
      const l = listeners[name] || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    };
    host.dispatchEvent = (name, ev) => {
      for (const fn of (listeners[name] || []).slice()) fn(ev || {});
    };
    host.__listeners = listeners;
    return host;
  };

  const win = eventTarget({
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    posthog,
    matchMedia: () => ({ matches: false }),
  });
  define("window", win);
  eventTarget(doc);            // document.addEventListener for visibilitychange
  define("document", doc);
  define("location", { hostname: "localhost", pathname: "/host.html" });
  define("navigator", { onLine: true, connection: { effectiveType: "4g" } });
  define("fetch", () => Promise.resolve({ ok: false, status: 404 }));

  // Consent is ACCEPTED for this whole file: the wrapper's capture paths are
  // what we are testing. The "no consent" half of the gate is proved in
  // tests/analytics.test.js, which exercises it directly.
  store.set("geoparty_analytics_consent", "accepted");

  return { doc, posthog, byId, win };
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
      // Shared monotonic order counter (regression test for the round-
      // boundary autoplay bug): proves seq.stop() ran BEFORE the
      // sequence component was deactivated, not after.
      this.order = 0;
      const self = this;
      this.seq = {
        playing: false,
        stops: 0,
        play() { this.playing = true; },
        stop() { this.stops++; this.playing = false; this.stoppedAtOrder = self.order++; },
      };
      state.viewers.push(this);
    }
    getComponent(name) {
      (this.getComponentCalls = this.getComponentCalls || []).push(name);
      return name === "sequence" ? this.seq : null;
    }
    on(name, fn) { (this.handlers[name] = this.handlers[name] || []).push(fn); }
    emit(name, ev) { for (const fn of this.handlers[name] || []) fn(ev); }
    // §18: getCanvas() is the probe/rebind's PRIMARY canvas source (V2). Returns
    // null until a test sets `_canvas` (mirrors the SDK's detached-until-first-
    // moveTo getter, Verdict F5).
    getCanvas() { return this._canvas || null; }
    moveTo(id) { (this.calls = this.calls || []).push("moveTo"); this.movedTo = id; return Promise.resolve(); }
    setCenter(c) { (this.calls = this.calls || []).push("setCenter"); this.center = c; }
    setZoom(z) { (this.calls = this.calls || []).push("setZoom"); this.zoom = z; }
    setFilter() { (this.calls = this.calls || []).push("setFilter"); return Promise.resolve(); }
    // Verdict F8: SDK teardown deliberately fires a real loseContext(), so a
    // bound webglcontextlost listener WILL fire during a normal destroy unless
    // detached first. The fake mirrors it — the D2 order regression depends on it.
    remove() {
      this.removed = true;
      if (this._canvas && typeof this._canvas.dispatch === "function") {
        this._canvas.dispatch("webglcontextlost", {});
      }
    }
    resize() { this.resizes = (this.resizes || 0) + 1; }
    activateComponent(name) {
      (this.activated = this.activated || []).push(name);
      (this.activatedAtOrder = this.activatedAtOrder || []).push(this.order++);
    }
    deactivateComponent(name) {
      (this.deactivated = this.deactivated || []).push(name);
      (this.deactivatedAtOrder = this.deactivatedAtOrder || []).push(this.order++);
    }
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
  // Rebuild the module's per-session singletons (budget/dedup/log/facts) so
  // tests are order-independent (review P2-3): without this the cumulative
  // image_dead budget and leftover health facts leak across tests.
  viewerUi.__resetSessionForTests();
  mly.supported = true;
  mly.constructThrows = null;
  mly.viewers.length = 0;   // §18 rebuild tests assert on the constructed count
  globalThis.navigator.onLine = true;
  window.__gpChaos = {};
  canaryDead = false;
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

test("setMoveAllowed: toggles moveEnabled and (de)activates nav components (G2/G6)", () => {
  const iv = makeHostViewer();
  const raw = iv.viewer;
  iv.setMoveAllowed(false);   // G2 Frozen / G6 Hard
  assert.equal(iv.moveEnabled, false);
  assert.deepEqual(raw.deactivated, ["direction", "sequence", "keyboard"]);
  iv.setMoveAllowed(true);
  assert.equal(iv.moveEnabled, true);
  assert.deepEqual(raw.activated, ["direction", "sequence", "keyboard"]);
  iv.destroy();
});

/* ================================================================
 * Autoplay round-boundary regression (Mapillary PlayService, not the
 * sequence component, owns the "play" loop — see js/viewer-ui.js stopPlay).
 * ================================================================ */

test("autoplay: round boundary stops play", () => {
  const iv = makeHostViewer();
  const raw = iv.viewer;
  raw.seq.play();
  assert.equal(raw.seq.playing, true);
  iv.beginRound(2);
  assert.ok(raw.seq.stops >= 1);
  assert.equal(raw.seq.playing, false);
  iv.destroy();
});

test("autoplay: Frozen round stops play BEFORE deactivating the sequence component", () => {
  const iv = makeHostViewer();
  const raw = iv.viewer;
  raw.seq.play();
  assert.equal(raw.seq.playing, true);
  iv.setMoveAllowed(false);   // G2 Frozen
  assert.ok(raw.seq.stops >= 1);
  assert.equal(raw.seq.playing, false);
  assert.ok(raw.deactivated.includes("sequence"));
  const deactivateSeqOrder = raw.deactivatedAtOrder[raw.deactivated.indexOf("sequence")];
  assert.ok(raw.seq.stoppedAtOrder < deactivateSeqOrder,
    "seq.stop() must run before the sequence component is deactivated");
  iv.destroy();
});

test("autoplay: a move-allowed round starts controlled (stopped, then reactivated)", () => {
  const iv = makeHostViewer();
  const raw = iv.viewer;
  raw.seq.play();
  assert.equal(raw.seq.playing, true);
  iv.setMoveAllowed(true);
  assert.ok(raw.seq.stops >= 1);
  assert.ok(raw.activated.includes("sequence"));
  iv.destroy();
});

test("autoplay: no-op when not playing", () => {
  const iv = makeHostViewer();
  const raw = iv.viewer;
  assert.equal(raw.seq.playing, false);
  assert.doesNotThrow(() => iv.beginRound(1));
  assert.equal(raw.seq.playing, false);
  iv.destroy();
});

test("autoplay: new-anchor path leaves play stopped", async () => {
  const iv = makeHostViewer();
  const raw = iv.viewer;
  raw.seq.play();
  assert.equal(raw.seq.playing, true);
  iv.beginRound(2);
  await iv.moveTo("1263588815098567", "anchor");
  assert.equal(raw.seq.playing, false);
  iv.destroy();
});

test("autoplay: safe on a viewer with no getComponent", () => {
  const iv = makeHostViewer();
  const raw = iv.viewer;
  delete raw.getComponent;
  assert.doesNotThrow(() => iv.beginRound(1));
  assert.doesNotThrow(() => iv.setMoveAllowed(false));
  iv.destroy();
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
  const { entry, skips, degraded } = await viewerUi.loadRoundImage(s, iv, "anchor");
  assert.equal(entry, null, "the caller's pool-exhausted path takes over");
  assert.equal(skips, 3);
  assert.equal(degraded, false,
    "genuine exhaustion is NOT degraded — the finish/end paths must act on it");
  const ev = lastEvent("imagery_load");
  assert.equal(ev.props.ok, false);
  assert.equal(ev.props.skips, 3);
  iv.destroy();
});

/* ================================================================
 * degraded — the retryable-vs-exhausted contract (P1-3 / P2-1 / P2-5)
 * ================================================================ */

test("degraded: a transient timeout keeps the seeded entry and does NOT advance",
  async () => {
    // The Daily's "same five for everyone" invariant: a slow-network timeout
    // must not skip a LIVE entry to a different one (review P2-5).
    window.__gpChaos.timeoutMs = 5;
    window.__gpChaos.moveTo = () => new Promise(() => {}); // never settles
    const iv = makeHostViewer();
    const s = sampler("live-1", "live-2", "live-3");

    const { entry, skips, degraded } =
      await viewerUi.loadRoundImage(s, iv, "anchor");
    assert.equal(entry, null, "no entry to score");
    assert.equal(degraded, true, "retryable — the caller must not consume the run");
    assert.equal(skips, 0);
    assert.equal(s.cursor, 0, "the seeded entry is untouched — no live spot skipped");
    const ev = lastEvent("imagery_load");
    assert.equal(ev.props.ok, false);
    assert.equal(ev.props.error_class, "network_timeout");
    assert.ok(!("exhausted" in ev.props), "a transient failure is not exhaustion");
    iv.destroy();
  });

test("degraded: a rate-limited anchor is retryable, not a pool skip", async () => {
  window.__gpChaos.moveTo = () =>
    Promise.reject(new Error("Request failed with status 429"));
  const iv = makeHostViewer();
  const s = sampler("a", "b", "c");
  const { entry, degraded } = await viewerUi.loadRoundImage(s, iv, "anchor");
  assert.equal(entry, null);
  assert.equal(degraded, true, "http_rate_limit is environmental, never a dead entry");
  assert.equal(s.cursor, 0, "the pool is not burned on a transient class");
  iv.destroy();
});

test("degraded: dead entries still skip; only the transient one degrades",
  async () => {
    // A live pool with a dead first entry then a timeout on the (live) second:
    // the dead one is skipped deterministically, the timeout degrades.
    let calls = 0;
    window.__gpChaos.timeoutMs = 5;
    window.__gpChaos.moveTo = () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("Node does not exist"));
      return new Promise(() => {}); // second entry: transient timeout
    };
    const iv = makeHostViewer();
    const s = sampler("dead-1", "live-2", "live-3");
    const { entry, skips, degraded } =
      await viewerUi.loadRoundImage(s, iv, "anchor");
    assert.equal(entry, null);
    assert.equal(degraded, true);
    assert.equal(skips, 1, "the dead entry was skipped");
    assert.equal(s.cursor, 1, "and the sampler advanced past ONLY the dead one");
    iv.destroy();
  });

test("degraded: a stub viewer is retryable, never exhaustion", async () => {
  mly.supported = false; // no WebGL → stub viewer
  const iv = makeHostViewer();
  const s = sampler("a", "b", "c");
  const { entry, skips, degraded } = await viewerUi.loadRoundImage(s, iv, "anchor");
  assert.equal(entry, null);
  assert.equal(skips, 0);
  assert.equal(degraded, true, "a stub viewer must not zero a Daily run (P1-3)");
  assert.equal(s.cursor, 0, "not one pool entry consumed");
  const ev = lastEvent("imagery_load");
  assert.ok(!("exhausted" in ev.props),
    "the stub load is not tagged exhausted — viewer_init already carries the failure");
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
 * Issue #2 — edge diagnostics + the nav_available health correction
 * ================================================================ */

test("#2: a viewer that never emits `navigable` still reads a healthy session",
  async () => {
    // The root bug: `navigable` never fires usefully, so nav_available was
    // false for all 80 field sessions and every move-enabled session was
    // mislabelled degraded. A clean move-enabled round must now read healthy.
    const iv = makeHostViewer();                 // movement enabled
    iv.beginRound(1);
    await iv.moveTo("123456789012345", "anchor");
    iv.endRound();                               // NO navigable event, ever
    assert.equal(viewerUi.imagerySession().health(), "healthy",
      "a missing nav_available signal must not, by itself, degrade the session");
    assert.equal(lastEvent("pano_session").props.nav_available, false,
      "nav_available stays its (deprecated) broken false — continuity preserved");
    iv.destroy();
  });

test("#2: cached spatial/sequence edges fold into pano_session", () => {
  const iv = makeHostViewer();
  iv.beginRound(3);
  iv.viewer.emit("image", {
    image: {
      id: "anchor-1",
      spatialEdges: { cached: true, edges: [{}, {}, {}, {}] },
      sequenceEdges: { cached: true, edges: [{}, {}] },
    },
  });
  iv.endRound();
  const pano = lastEvent("pano_session");
  assert.equal(pano.props.anchor_spatial_edges, 4);
  assert.equal(pano.props.anchor_sequence_edges, 2);
  iv.destroy();
});

test("#2: an UNCACHED edge status is unknown — never a false-zero edge count", () => {
  const iv = makeHostViewer();
  iv.beginRound(1);
  iv.viewer.emit("image", {
    image: {
      id: "anchor-x",
      spatialEdges: { cached: false, edges: [] },   // graph not resolved yet
      sequenceEdges: { cached: false, edges: [] },
    },
  });
  iv.endRound();
  const pano = lastEvent("pano_session");
  assert.ok(!("anchor_spatial_edges" in pano.props),
    "an uncached status stays absent, never a false 0 (the nav_available trap)");
  assert.ok(!("anchor_sequence_edges" in pano.props));
  iv.destroy();
});

test("#2: an edge observation BEFORE beginRound seeds the round's anchor", () => {
  const iv = makeHostViewer();
  // The viewer's initial image event fires before we open the round.
  iv.viewer.emit("image", {
    image: {
      id: "initial",
      spatialEdges: { cached: true, edges: [{}, {}, {}] },
      sequenceEdges: { cached: true, edges: [{}] },
    },
  });
  iv.beginRound(1);   // must seed the latched pre-round edges (SDK ordering)
  iv.endRound();
  const pano = lastEvent("pano_session");
  assert.equal(pano.props.anchor_spatial_edges, 3,
    "the pre-beginRound image/edge state is retained in the round fold");
  assert.equal(pano.props.anchor_sequence_edges, 1);
  iv.destroy();
});

test("#2: one round's anchor edges never leak into the next round", () => {
  const iv = makeHostViewer();
  iv.beginRound(1);
  iv.viewer.emit("image", {
    image: { id: "a1", spatialEdges: { cached: true, edges: [{}, {}, {}, {}, {}] } },
  });
  iv.endRound();
  assert.equal(lastEvent("pano_session").props.anchor_spatial_edges, 5);
  // Round 2 sees no edge observation → it must report unknown, not round 1's 5.
  iv.beginRound(2);
  iv.endRound();
  assert.ok(!("anchor_spatial_edges" in lastEvent("pano_session").props),
    "the latch is cleared at endRound — round 2 starts from unknown");
  iv.destroy();
});

test("#2: an image id in an edge observation never reaches analytics", () => {
  const iv = makeHostViewer();
  iv.beginRound(1);
  iv.viewer.emit("image", {
    image: {
      id: "1263588815098567",
      spatialEdges: { cached: true, edges: [{}, {}] },
    },
  });
  iv.endRound();
  const blob = JSON.stringify(env.posthog.captured);
  assert.ok(!blob.includes("1263588815098567"), "the raw image id is never captured");
  assert.equal(lastEvent("pano_session").props.anchor_spatial_edges, 2);
  iv.destroy();
});

/* ================================================================
 * Session health, read through the wrapper's own accumulated facts
 * ================================================================ */

test("imagerySession: the health fold sees what the wrapper recorded", async () => {
  // Prove causation, not coincidence (review P2-3): a CLEAN session reads
  // healthy, and it is the http_auth failure THIS test injects that flips it
  // to failed. (The old assertion passed on leftover facts from earlier
  // tests, so the path under test could have been broken and gone unnoticed.)
  assert.equal(viewerUi.imagerySession().health(), "healthy",
    "the reset gives every test a clean session to start from");

  window.__gpChaos.moveTo = () => Promise.reject(new Error("401 Unauthorized"));
  const iv = makeHostViewer();
  await iv.moveTo("666666666666666", "anchor").catch(() => {});

  assert.equal(viewerUi.imagerySession().health(), "failed",
    "the injected http_auth failure is what flips health to failed");
  assert.equal(viewerUi.imagerySession().log.failures().slice(-1)[0].error_class,
    "http_auth");
  iv.destroy();
});

/* ================================================================
 * D — chaos hooks are inert off a dev host
 * ================================================================ */

test("D: chaos hooks do nothing when the page is not on a dev host", async (t) => {
  // t.after restores the global even if an assertion throws mid-test — a bare
  // restore at the end of the body leaks the mutation on failure (P2-3).
  t.after(() => { globalThis.location.hostname = "localhost"; });
  globalThis.location.hostname = "geoparty.example";
  window.__gpChaos.moveTo = () => Promise.reject(new Error("chaos should not fire"));
  const iv = makeHostViewer();
  await iv.moveTo("777777777777777", "anchor");   // the REAL fake viewer resolves
  assert.equal(lastEvent("imagery_load").props.ok, true);
  iv.destroy();
});

test("D: a production page never exposes the __gpViewers harness handle", (t) => {
  t.after(() => { globalThis.location.hostname = "localhost"; });
  globalThis.location.hostname = "geoparty.example";
  delete window.__gpViewers;
  const iv = makeHostViewer();
  assert.equal(window.__gpViewers, undefined);
  iv.destroy();
});

/* ================================================================
 * #4 — round-transition cover: reset + cover before the move, uncover on
 * arrival, stay covered on failure (stale pano never re-exposed)
 * ================================================================ */

const coverOf = (cid) => document.getElementById(cid).querySelector(".pano-cover");
const makeCoverViewer = (cid) => viewerUi.createViewer({
  surface: "host", container: cid, moveAllowed: true, component: HOST_COMPONENT,
});

test("#4: an anchor load resets the view and covers the pano BEFORE the move",
  async () => {
    const cid = "cover-order";
    const iv = makeCoverViewer(cid);
    const seen = {};
    window.__gpChaos.moveTo = () => {
      const cover = coverOf(cid);
      seen.coverUp = !!(cover && !cover.classList.contains("hidden"));
      seen.resetCalls = (iv.viewer.calls || []).slice();
      return Promise.resolve();
    };
    await iv.moveTo("123456789012345", "anchor");
    assert.equal(seen.coverUp, true, "the cover is up while the image loads");
    assert.deepEqual(seen.resetCalls, ["setCenter", "setZoom"],
      "zoom/center are reset before the move, so the new image starts neutral");
    assert.ok(coverOf(cid).classList.contains("hidden"),
      "the cover lifts once the image actually arrives");
    iv.destroy();
  });

test("#4: a failed anchor load leaves the cover UP (no stale pano)", async () => {
  const cid = "cover-fail";
  window.__gpChaos.moveTo = () => Promise.reject(new Error("Image does not exist"));
  const iv = makeCoverViewer(cid);
  await iv.moveTo("123456789012345", "anchor").catch(() => {});
  const cover = coverOf(cid);
  assert.ok(cover && !cover.classList.contains("hidden"),
    "on failure the caller's overlay/map fallback takes over, cover stays up");
  iv.destroy();
});

test("#4: a late anchor success lifts the cover when the image finally lands",
  async () => {
    const cid = "cover-late";
    window.__gpChaos.timeoutMs = 5;
    window.__gpChaos.moveTo = () => new Promise((res) => setTimeout(res, 40));
    const iv = makeCoverViewer(cid);
    await iv.moveTo("123456789012345", "anchor").catch(() => {});
    assert.ok(!coverOf(cid).classList.contains("hidden"),
      "still covered while the load is only a timeout so far");
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(coverOf(cid).classList.contains("hidden"),
      "the late SDK success reveals the image");
    iv.destroy();
  });

test("#4: nav and follow loads never cover the pano", async () => {
  for (const purpose of ["nav", "follow"]) {
    const cid = `cover-none-${purpose}`;
    const iv = makeCoverViewer(cid);
    await iv.moveTo("123456789012345", purpose);
    const cover = coverOf(cid);
    assert.ok(!cover || cover.classList.contains("hidden"),
      `${purpose} must not blank the pano`);
    iv.destroy();
  }
});

test("#4: the round-anchor skip loop keeps the cover up across dead entries",
  async () => {
    // Dead first entry (skipped), good second: the cover must stay up through
    // the skip and lift only when a real image lands.
    const cid = "cover-skip";
    const dead = new Set(["dead-a"]);
    window.__gpChaos.moveTo = (id) => (dead.has(id)
      ? Promise.reject(new Error("Node does not exist"))
      : Promise.resolve());
    const iv = makeCoverViewer(cid);
    const s = sampler("dead-a", "good-1");
    const { entry } = await viewerUi.loadRoundImage(s, iv, "anchor");
    assert.equal(entry.image_id, "good-1");
    assert.ok(coverOf(cid).classList.contains("hidden"),
      "the cover lifts on the entry that loaded, not the skipped dead one");
    iv.destroy();
  });

/* ================================================================
 * "Finding your way…" nav hint (issue #3 follow-up) — arm/fade/cancel glue
 * ================================================================ */

// The pill is mounted on <body> (see ensureNavHint), so query body, not the
// viewer container. Arrows (addArrowGlyph) still go in the container.
const navHintOf = () => document.body.querySelector(".pano-nav-hint");
function addArrowGlyph(cid, cls) {
  const arrow = document.createElement("div");
  arrow.className = cls || "mapillary-direction-arrow-step";
  document.getElementById(cid).appendChild(arrow);
  return arrow;
}
const NAV_ARROW_TEST_SELECTOR = [
  "mapillary-direction-arrow-step", "mapillary-direction-arrow-spherical",
  "mapillary-direction-turn-left", "mapillary-direction-turn-right",
  "mapillary-direction-turn-around",
].join(",");
function navHintArrowNode(cid) {
  return document.getElementById(cid).querySelector(NAV_ARROW_TEST_SELECTOR);
}
function navigationArrowsPresent(cid) {
  return Boolean(navHintArrowNode(cid));
}

test("nav hint: appears on a move-enabled anchor load when no arrows are on screen yet",
  async () => {
    const cid = "navhint-appears";
    const iv = makeCoverViewer(cid);
    await iv.moveTo("123456789012345", "anchor");
    const hint = navHintOf(cid);
    assert.ok(hint && hint.classList.contains("show"), "the pill shows while arrows are missing");
    iv.destroy();
  });

test("nav hint: fades the instant a real arrow glyph is detected on a poll tick",
  async () => {
    const cid = "navhint-fades-arrows";
    const iv = makeCoverViewer(cid);
    await iv.moveTo("123456789012345", "anchor");
    assert.ok(navHintOf(cid).classList.contains("show"));
    addArrowGlyph(cid, "mapillary-direction-arrow-step");
    iv.__navHintTickForTests();
    assert.ok(!navHintOf(cid).classList.contains("show"),
      "the pill fades as soon as an arrow glyph is found — hide_arrows beats the timeout");
    iv.destroy();
  });

// The viewer + DirectionComponent are reused across rounds, so arrows already
// in the container at arm time may be the PREVIOUS round's stale glyphs, not
// this round's — those must never be read as "found arrows" (that was the
// round-2+ bug: the pill never armed past round 1). The pill must SHOW, and
// stay shown, until the arrow DOM is observed to actually clear at least once.
test("nav hint: stale arrows already in the DOM at arm time still show the pill (no instant-hide)",
  async () => {
    const cid = "navhint-stale-at-arm";
    const stale = addArrowGlyph(cid, "mapillary-direction-turn-left");
    const iv = makeCoverViewer(cid);
    await iv.moveTo("123456789012345", "anchor");
    assert.ok(navHintOf(cid).classList.contains("show"),
      "arrows present at arm time do not suppress the pill — they might be stale");
    iv.__navHintTickForTests();
    assert.ok(navHintOf(cid).classList.contains("show"),
      "a poll tick while the stale arrows persist keeps waiting — baseline not clear yet");
    stale.remove();
    iv.__navHintTickForTests();
    assert.ok(navHintOf(cid).classList.contains("show"),
      "removing the stale arrows clears the baseline, but that tick itself only observes clear");
    addArrowGlyph(cid, "mapillary-direction-arrow-step");
    iv.__navHintTickForTests();
    assert.ok(!navHintOf(cid).classList.contains("show"),
      "a genuinely fresh arrow glyph, seen after the baseline cleared, fades the pill");
    iv.destroy();
  });

// Headline regression for the round-2+ bug: round 1 leaves its arrow glyph in
// the DOM (nothing tears it down between rounds), and round 2's arm must
// still show the pill instead of reading round 1's glyph as "already found".
test("nav hint: round 2 (and round 3) still arm and fade correctly with a stale arrow left over from the prior round",
  async () => {
    const cid = "navhint-round2-regression";
    const iv = makeCoverViewer(cid);

    // Round 1: normal appear → fresh arrow → fade.
    iv.beginRound(1);
    await iv.moveTo("123456789012345", "anchor");
    assert.ok(navHintOf(cid).classList.contains("show"), "round 1 shows the pill");
    const r1Arrow = addArrowGlyph(cid, "mapillary-direction-arrow-step");
    iv.__navHintTickForTests();
    assert.ok(!navHintOf(cid).classList.contains("show"), "round 1 fades on its own fresh arrow");

    // Round 1's arrow glyph is deliberately LEFT in the container DOM — the
    // viewer + DirectionComponent are reused, nothing clears it between
    // rounds. This is exactly the state that made round 2 never arm before
    // the fix.
    assert.ok(navigationArrowsPresent(cid), "the stale round-1 glyph is still in the DOM");

    iv.beginRound(2);
    await iv.moveTo("223456789012345", "anchor");
    assert.ok(navHintOf(cid).classList.contains("show"),
      "round 2 must still show the pill even though a stale arrow is already present " +
      "(this is the bug: it used to never arm here)");
    r1Arrow.remove();
    iv.__navHintTickForTests(); // observes clear — still waits this tick
    assert.ok(navHintOf(cid).classList.contains("show"));
    addArrowGlyph(cid, "mapillary-direction-arrow-step");
    iv.__navHintTickForTests();
    assert.ok(!navHintOf(cid).classList.contains("show"), "round 2 fades once a fresh arrow is seen");

    // Round 3: repeat once more to prove this isn't a one-off round-2 special case.
    const r2Arrow = navHintArrowNode(cid);
    iv.beginRound(3);
    await iv.moveTo("323456789012345", "anchor");
    assert.ok(navHintOf(cid).classList.contains("show"), "round 3 also shows the pill despite a stale arrow");
    if (r2Arrow) r2Arrow.remove();
    iv.__navHintTickForTests();
    addArrowGlyph(cid, "mapillary-direction-arrow-step");
    iv.__navHintTickForTests();
    assert.ok(!navHintOf(cid).classList.contains("show"), "round 3 fades once a fresh arrow is seen");

    iv.destroy();
  });

// Even when arrows are present the whole time (baseline never clears — a
// permanently stuck DirectionComponent), the bounded timeout is still a hard
// backstop: the pill must not hang forever. Drives the poll loop with a
// stubbed clock since the timeout is real elapsed time (NAV_HINT_MAX_MS),
// not tick count.
test("nav hint: times out and fades even when the arrow baseline never clears",
  async () => {
    const cid = "navhint-timeout-stale-baseline";
    addArrowGlyph(cid, "mapillary-direction-arrow-step"); // present at arm, and stays present
    const iv = makeCoverViewer(cid);
    const realNow = performance.now;
    let t = 0;
    performance.now = () => t;
    try {
      await iv.moveTo("123456789012345", "anchor");
      assert.ok(navHintOf(cid).classList.contains("show"),
        "shown despite the arrow present at arm time");
      iv.__navHintTickForTests();
      assert.ok(navHintOf(cid).classList.contains("show"),
        "still waiting well before the timeout, baseline never cleared");
      t += NAV_HINT_MAX_MS;
      iv.__navHintTickForTests();
      assert.ok(!navHintOf(cid).classList.contains("show"),
        "the bounded timeout fires regardless of the baseline latch");
    } finally {
      performance.now = realNow;
    }
    iv.destroy();
  });

test("nav hint: endRound cancels it immediately; a tick after endRound is a no-op",
  async () => {
    const cid = "navhint-endround";
    const iv = makeCoverViewer(cid);
    iv.beginRound(1);
    await iv.moveTo("123456789012345", "anchor");
    assert.ok(navHintOf(cid).classList.contains("show"));
    iv.endRound();
    assert.ok(!navHintOf(cid).classList.contains("show"), "endRound hides the pill immediately");
    addArrowGlyph(cid, "mapillary-direction-arrow-step");
    iv.__navHintTickForTests(); // no pending tick left — must be a silent no-op
    assert.ok(!navHintOf(cid).classList.contains("show"));
    iv.destroy();
  });

test("nav hint: destroy cancels it and removes the element, mirroring coverEl teardown",
  async () => {
    const cid = "navhint-destroy";
    const iv = makeCoverViewer(cid);
    await iv.moveTo("123456789012345", "anchor");
    assert.ok(navHintOf(cid).classList.contains("show"));
    iv.destroy();
    assert.equal(navHintOf(cid), null, "the pill element is removed on destroy");
    iv.__navHintTickForTests(); // must not throw after destroy
  });

test("nav hint: a superseded new attempt() cancels the previous hint at entry",
  async () => {
    const cid = "navhint-superseded";
    const iv = makeCoverViewer(cid);
    await iv.moveTo("first-anchor", "anchor");
    assert.ok(navHintOf(cid).classList.contains("show"));
    const p = iv.moveTo("second-anchor", "anchor");
    assert.ok(!navHintOf(cid).classList.contains("show"),
      "the new attempt() cancels the previous round's hint before it arms its own");
    await p;
    iv.destroy();
  });

test("nav hint: never shown on a move-disabled surface (TV/landing)", async () => {
  const cid = "navhint-tv";
  const iv = viewerUi.createViewer({
    surface: "tv", container: cid, moveAllowed: false, component: { cover: true },
  });
  await iv.moveTo("123456789012345", "anchor");
  const hint = navHintOf(cid);
  assert.ok(!hint || !hint.classList.contains("show"), "no movement offered means no nav hint, ever");
  iv.destroy();
});

test("nav hint: never shown while Frozen (setMoveAllowed(false))", async () => {
  const cid = "navhint-frozen";
  const iv = makeCoverViewer(cid);
  iv.setMoveAllowed(false);
  await iv.moveTo("123456789012345", "anchor");
  const hint = navHintOf(cid);
  assert.ok(!hint || !hint.classList.contains("show"), "Frozen never arms the nav hint");
  iv.destroy();
});

// The Frozen flip can land AFTER the anchor has already armed the hint (the
// anchor resolves before the setMoveAllowed(false) applies, or the hint armed
// on a prior move-enabled round). Without an active dismissal the pill would
// hang the full NAV_HINT_MAX_MS against arrows that never appear. setMoveAllowed
// (false) must cancel it immediately.
test("nav hint: a Frozen setMoveAllowed(false) dismisses an already-armed hint immediately (not on timeout)",
  async () => {
    const cid = "navhint-frozen-dismiss";
    const iv = makeCoverViewer(cid);
    // Move-enabled anchor arms the pill (no arrows on screen yet).
    await iv.moveTo("123456789012345", "anchor");
    assert.ok(navHintOf(cid).classList.contains("show"),
      "the pill is armed and showing after the move-enabled anchor load");
    // Now the Frozen flip lands: movement off must dismiss the pill right away.
    iv.setMoveAllowed(false);
    assert.ok(!navHintOf(cid).classList.contains("show"),
      "setMoveAllowed(false) dismisses the armed hint immediately — not left to time out");
    // And no pending tick can re-show it: a later poll is a silent no-op.
    iv.__navHintTickForTests();
    assert.ok(!navHintOf(cid).classList.contains("show"),
      "the hint stays dismissed after the Frozen flip");
    iv.destroy();
  });

// Regression: a move-ENABLED round must keep its armed hint. setMoveAllowed
// (true) activates the components and must NOT cancel the pill — it fades only
// when arrows appear or the bounded timeout fires.
test("nav hint: setMoveAllowed(true) does NOT cancel an armed hint (a move-enabled round keeps it)",
  async () => {
    const cid = "navhint-move-enabled-keeps";
    const iv = makeCoverViewer(cid);
    await iv.moveTo("123456789012345", "anchor");
    assert.ok(navHintOf(cid).classList.contains("show"));
    iv.setMoveAllowed(true);
    assert.ok(navHintOf(cid).classList.contains("show"),
      "re-enabling movement must not dismiss the hint — it waits for arrows or the timeout");
    iv.destroy();
  });

/* ================================================================
 * #5 — movement-lever hardening: a transient activation failure must
 * recover on a later render/retry, never strand the controls for the round
 * ================================================================ */

function throwOnceActivate(raw) {
  let throwsLeft = 1;
  const real = raw.activateComponent.bind(raw);
  raw.activateComponent = (name) => {
    if (throwsLeft-- > 0) throw new Error("component not laid out yet");
    real(name);
  };
}

test("#5: a failed activation recovers on the next render via reassertMove", () => {
  const iv = makeHostViewer();
  const raw = iv.viewer;
  throwOnceActivate(raw);
  iv.setMoveAllowed(true);
  assert.equal(iv.moveEnabled, true);
  assert.ok(!(raw.activated || []).includes("direction"),
    "the throwing component did not activate on the first attempt");
  iv.reassertMove(); // a later active-round render re-drives the lever
  assert.ok((raw.activated || []).includes("direction"),
    "the movement control recovers on the next render, not stranded for the round");
  iv.destroy();
});

test("#5: a failed activation also auto-retries without an explicit render", async () => {
  const iv = makeHostViewer();
  const raw = iv.viewer;
  throwOnceActivate(raw);
  iv.setMoveAllowed(true);
  assert.ok(!(raw.activated || []).includes("direction"));
  await new Promise((r) => setTimeout(r, 350));
  assert.ok((raw.activated || []).includes("direction"),
    "the scheduled retry recovered the stranded control");
  iv.destroy();
});

test("#5: reassertMove is a no-op once the lever has stuck (no re-toggle churn)", () => {
  const iv = makeHostViewer();
  const raw = iv.viewer;
  iv.setMoveAllowed(true);
  const count = (raw.activated || []).length;
  iv.reassertMove();
  iv.reassertMove();
  assert.equal((raw.activated || []).length, count,
    "a healthy lever is not re-activated on every render");
  iv.destroy();
});

test("#5: Frozen stays frozen — deactivate is not undone by a reassert", () => {
  const iv = makeHostViewer();
  const raw = iv.viewer;
  iv.setMoveAllowed(false);      // G2 Frozen for this round
  assert.deepEqual(raw.deactivated, ["direction", "sequence", "keyboard"]);
  iv.reassertMove();             // a mid-round render must not re-enable it
  assert.equal(iv.moveEnabled, false);
  assert.ok(!(raw.activated || []).includes("direction"));
  iv.destroy();
});

/* ================================================================
 * Issue #2 Phase 2 — bounded spatial-edge cache recovery
 * (docs/issue-2-phase2-fix.md). All timers route through the test-only
 * __edgeRecoveryTickForTests() seam, so nothing here ever sleeps for a real
 * delay; `flush()` only drains the microtask queue after an async
 * setFilter() call so the NEXT tick has been scheduled before we fire it.
 * ================================================================ */

const flush = () => new Promise((r) => setTimeout(r, 0));

// Two-step recovery per docs/issue-2-phase2-fix.md §C: attempt 1 converts an
// uncached status to cached-ZERO with no real fetch; attempt 2 is the real
// re-fetch. `img` is the SAME live object `iv` latches as `lastImage`, so
// mutating it in place (no new "image" event) is the exact SDK behavior
// §2 point 4 documents.
function twoStepSetFilter(raw, img) {
  let calls = 0;
  raw.setFilter = () => {
    calls += 1;
    raw.calls = raw.calls || [];
    raw.calls.push("setFilter");
    img.spatialEdges = calls === 1
      ? { cached: true, edges: [] }
      : { cached: true, edges: [{}, {}, {}, {}] };
    return Promise.resolve();
  };
  return () => calls;
}

test("edge_recovery: recovers on attempt 2 (attempt 1 no_change) — the healthy field signature",
  async () => {
    const iv = makeHostViewer();
    const raw = iv.viewer;
    const img = { id: "anchor-1", spatialEdges: { cached: false, edges: [] } };
    const callCount = twoStepSetFilter(raw, img);

    iv.beginRound(5);
    await iv.moveTo("anchor-1", "anchor");
    iv.viewer.emit("image", { image: img });

    iv.__edgeRecoveryTickForTests();          // grace tick → attempt 1 (uncached)
    await flush();
    iv.__edgeRecoveryTickForTests();          // recheck → classify attempt 1
    const ev1 = lastEvent("edge_recovery");
    assert.equal(ev1.props.surface, "host");
    assert.equal(ev1.props.round_number, 5);
    assert.equal(ev1.props.attempt, 1);
    assert.equal(ev1.props.trigger, "uncached");
    assert.equal(ev1.props.result, "no_change");
    assert.equal(ev1.props.spatial_after, 0);

    iv.__edgeRecoveryTickForTests();          // backoff tick → attempt 2 (zero)
    await flush();
    iv.__edgeRecoveryTickForTests();          // recheck → classify attempt 2
    const ev2 = lastEvent("edge_recovery");
    assert.equal(ev2.props.attempt, 2);
    assert.equal(ev2.props.trigger, "zero");
    assert.equal(ev2.props.result, "recovered");
    assert.equal(ev2.props.spatial_after, 4);
    assert.equal(callCount(), 2, "at most two setFilter() calls, ever");

    iv.endRound();
    const pano = lastEvent("pano_session");
    assert.equal(pano.props.edge_recoveries, 2);
    assert.equal(pano.props.anchor_spatial_edges, 4,
      "a successful recovery backfills anchor_spatial_edges for the Phase 1 metric");
    iv.destroy();
  });

test("boundary: stuck at null forever — at most 2 setFilter calls, then stops (no hot loop)",
  async () => {
    const iv = makeHostViewer();
    const raw = iv.viewer;
    let calls = 0;
    raw.setFilter = () => { calls += 1; return Promise.resolve(); }; // never actually caches anything
    iv.beginRound(1);
    await iv.moveTo("stuck-1", "anchor");
    iv.viewer.emit("image", { image: { id: "stuck-1", spatialEdges: { cached: false, edges: [] } } });

    iv.__edgeRecoveryTickForTests(); await flush();   // attempt 1
    iv.__edgeRecoveryTickForTests();                  // classify 1 → no_change, schedules tick 2
    iv.__edgeRecoveryTickForTests(); await flush();   // attempt 2
    iv.__edgeRecoveryTickForTests();                  // classify 2 → no_change, schedules tick 3
    iv.__edgeRecoveryTickForTests();                  // tick 3 → attempts_exhausted, no 3rd call

    assert.equal(calls, 2, "never more than 2 setFilter calls even though edges never recover");
    assert.equal(events("edge_recovery").length, 2);
    assert.equal(lastEvent("edge_recovery").props.result, "no_change");
    iv.destroy();
  });

test("boundary: Frozen (moveEnabled false) never attempts, never touches activateComponent",
  async () => {
    const iv = makeHostViewer();
    iv.setMoveAllowed(false);
    const raw = iv.viewer;
    raw.setFilter = () => { throw new Error("must not be called"); };
    iv.beginRound(1);
    await iv.moveTo("frozen-1", "anchor");
    iv.viewer.emit("image", { image: { id: "frozen-1", spatialEdges: { cached: false, edges: [] } } });
    const activatedBefore = (raw.activated || []).length;

    iv.__edgeRecoveryTickForTests();   // grace tick → frozen → skip, silently
    assert.equal(events("edge_recovery").length, 0);
    assert.equal((raw.activated || []).length, activatedBefore);
    iv.destroy();
  });

test("boundary: TV surface (moveEnabled always false) never attempts recovery", async () => {
  const iv = viewerUi.createViewer({
    surface: "tv", container: "tvViewer", moveAllowed: false, component: { cover: true },
  });
  const raw = iv.viewer;
  raw.setFilter = () => { throw new Error("must not be called"); };
  iv.beginRound(1);
  await iv.moveTo("tv-1", "anchor");
  iv.viewer.emit("image", { image: { id: "tv-1", spatialEdges: { cached: false, edges: [] } } });
  iv.__edgeRecoveryTickForTests();
  assert.equal(events("edge_recovery").length, 0);
  iv.destroy();
});

test("Frozen round emits nothing; the next (un-Frozen) round recovers normally", async () => {
  const iv = makeHostViewer();
  iv.setMoveAllowed(false);
  const raw = iv.viewer;
  let calls = 0;
  raw.setFilter = () => { calls += 1; return Promise.resolve(); };
  iv.beginRound(1);
  await iv.moveTo("frozen-r1", "anchor");
  iv.viewer.emit("image", { image: { id: "frozen-r1", spatialEdges: { cached: false, edges: [] } } });
  iv.__edgeRecoveryTickForTests();
  assert.equal(calls, 0, "Frozen round never calls setFilter");
  iv.endRound();

  iv.setMoveAllowed(true);
  const img2 = { id: "unfrozen-r2", spatialEdges: { cached: false, edges: [] } };
  raw.setFilter = () => {
    calls += 1;
    img2.spatialEdges = { cached: true, edges: [{}] };
    return Promise.resolve();
  };
  iv.beginRound(2);
  await iv.moveTo("unfrozen-r2", "anchor");
  iv.viewer.emit("image", { image: img2 });
  iv.__edgeRecoveryTickForTests(); await flush();
  iv.__edgeRecoveryTickForTests();
  assert.equal(calls, 1);
  assert.equal(lastEvent("edge_recovery").props.result, "recovered",
    "the next round's own arm/state is not poisoned by the frozen round's skip");
  iv.destroy();
});

test("boundary: recovery never blanks the pano — no resetView/showCover/moveTo calls, cover stays hidden",
  async () => {
    const cid = "cover-recovery";
    const iv = makeCoverViewer(cid);
    const raw = iv.viewer;
    const img = { id: "cover-1", spatialEdges: { cached: false, edges: [] } };
    twoStepSetFilter(raw, img);
    iv.beginRound(1);
    await iv.moveTo("cover-1", "anchor");
    iv.viewer.emit("image", { image: img });
    const callsBefore = (raw.calls || []).filter((c) => c !== "setFilter");

    iv.__edgeRecoveryTickForTests(); await flush();
    iv.__edgeRecoveryTickForTests();
    iv.__edgeRecoveryTickForTests(); await flush();
    iv.__edgeRecoveryTickForTests();

    const callsAfter = (raw.calls || []).filter((c) => c !== "setFilter");
    assert.deepEqual(callsAfter, callsBefore,
      "no setCenter/setZoom/moveTo calls come from the recovery path");
    assert.ok(coverOf(cid).classList.contains("hidden"), "the cover stays hidden — never re-shown");
    assert.equal(lastEvent("edge_recovery").props.result, "recovered");
    iv.destroy();
  });

test("boundary: an unexpected image event (user navigation) stops recovery silently", async () => {
  const iv = makeHostViewer();
  const raw = iv.viewer;
  raw.setFilter = () => { throw new Error("must not be called"); };
  iv.beginRound(1);
  await iv.moveTo("anchor-nav", "anchor");
  iv.viewer.emit("image", { image: { id: "anchor-nav", spatialEdges: { cached: false, edges: [] } } });
  // The player clicked an arrow — the SDK emits an image event we never asked for.
  iv.viewer.emit("image", { image: { id: "somewhere-else", spatialEdges: { cached: false, edges: [] } } });
  iv.__edgeRecoveryTickForTests();
  assert.equal(events("edge_recovery").length, 0);
  iv.destroy();
});

test("boundary: a new attempt() before the tick cancels pending recovery — no setFilter call",
  async () => {
    const iv = makeHostViewer();
    const raw = iv.viewer;
    raw.setFilter = () => { throw new Error("must not be called"); };
    iv.beginRound(1);
    await iv.moveTo("anchor-mid", "anchor");
    iv.viewer.emit("image", { image: { id: "anchor-mid", spatialEdges: { cached: false, edges: [] } } });
    await iv.moveTo("anchor-mid-2", "nav");   // a second load supersedes recovery
    iv.__edgeRecoveryTickForTests();          // nothing pending — a safe no-op
    assert.equal(events("edge_recovery").length, 0);
    iv.destroy();
  });

test("boundary: a stub viewer never exposes the recovery seam at all", () => {
  mly.supported = false;
  const iv = makeHostViewer();
  assert.equal(iv.ok, false);
  assert.equal(typeof iv.__edgeRecoveryTickForTests, "undefined");
  iv.destroy();
});

test("boundary: setFilter rejecting classifies error, stays bounded, no unhandled rejection",
  async () => {
    const iv = makeHostViewer();
    const raw = iv.viewer;
    raw.setFilter = () => Promise.reject(new Error("setFilter failed"));
    iv.beginRound(1);
    await iv.moveTo("anchor-err", "anchor");
    iv.viewer.emit("image", { image: { id: "anchor-err", spatialEdges: { cached: false, edges: [] } } });
    iv.__edgeRecoveryTickForTests(); await flush();
    iv.__edgeRecoveryTickForTests();
    assert.equal(lastEvent("edge_recovery").props.result, "error");
    iv.destroy();
  });

test("boundary: a still-blocked API keeps resolving setFilter with 0 edges — " +
  "classified no_change, not error (correction #3, the blocked-API signature)", async () => {
    const iv = makeHostViewer();
    const raw = iv.viewer;
    const img = { id: "blocked-1", spatialEdges: { cached: false, edges: [] } };
    raw.setFilter = () => {
      // The SDK swallows the 500 and resolves; the graph API is still down,
      // so nothing ever actually populates real edges.
      img.spatialEdges = { cached: true, edges: [] };
      return Promise.resolve();
    };
    iv.beginRound(1);
    await iv.moveTo("blocked-1", "anchor");
    iv.viewer.emit("image", { image: img });

    iv.__edgeRecoveryTickForTests(); await flush();   // attempt 1 (uncached)
    iv.__edgeRecoveryTickForTests();                  // classify 1 → no_change
    assert.equal(lastEvent("edge_recovery").props.result, "no_change");

    iv.__edgeRecoveryTickForTests(); await flush();   // attempt 2 (zero) — API still 500ing
    iv.__edgeRecoveryTickForTests();                  // classify 2 → STILL no_change, never error
    const ev2 = lastEvent("edge_recovery");
    assert.equal(ev2.props.attempt, 2);
    assert.equal(ev2.props.trigger, "zero");
    assert.equal(ev2.props.result, "no_change",
      "setFilter resolved even though the API 500'd — never misclassified as error");
    iv.destroy();
  });

// The FIELD-ACCURATE SDK model (Phase 3 fix, docs §12): the real setFilter()
// does NOT mutate the image latched at load — its clear() cuts that image out
// of the trajectory and the caching pass repopulates a DIFFERENT current-image
// object, reachable only via the public getImage(). So the load-time object
// (`imgOld`) stays uncached FOREVER, while getImage() returns a fresh object
// whose edges advance each recovery pass. Without the Phase 3 refresh the
// recheck re-reads the stale `imgOld` (spatial:null), so attempt 2 re-issues
// the same futile `uncached` trigger and never recovers — the exact 0/108
// field signature this test would catch as a regression.
function replacingSetFilter(raw, imgOld) {
  let calls = 0;
  let current = imgOld; // at load getImage() agrees with the image event
  raw.getImage = () => Promise.resolve(current);
  raw.setFilter = () => {
    calls += 1;
    raw.calls = raw.calls || [];
    raw.calls.push("setFilter");
    // setFilter REPLACES the current image with a new object; imgOld is left
    // untouched (still uncached) to prove the recheck must not read it.
    current = calls === 1
      ? { id: imgOld.id, spatialEdges: { cached: true, edges: [] } }            // cached-zero
      : { id: imgOld.id, spatialEdges: { cached: true, edges: [{}, {}, {}, {}] } }; // recovered
    return Promise.resolve();
  };
  return () => calls;
}

test("edge_recovery: recovers on attempt 2 when setFilter REPLACES the image object " +
  "(Phase 3 stale-ref fix — getImage() re-acquires the fresh current image)", async () => {
    const iv = makeHostViewer();
    const raw = iv.viewer;
    const imgOld = { id: "replaced-1", spatialEdges: { cached: false, edges: [] } };
    const callCount = replacingSetFilter(raw, imgOld);

    iv.beginRound(7);
    await iv.moveTo("replaced-1", "anchor");
    iv.viewer.emit("image", { image: imgOld });   // latches the STALE object

    iv.__edgeRecoveryTickForTests();          // grace tick → attempt 1 (uncached)
    await flush();
    iv.__edgeRecoveryTickForTests();          // recheck → refresh via getImage(), then classify
    await flush();                            // getImage().then → finish runs
    const ev1 = lastEvent("edge_recovery");
    assert.equal(ev1.props.attempt, 1);
    assert.equal(ev1.props.trigger, "uncached");
    assert.equal(ev1.props.result, "no_change",
      "attempt 1 sees the fresh cached-ZERO status (not the stale null), still no_change");
    assert.equal(ev1.props.spatial_after, 0,
      "spatial_after is the POST-setFilter count read off the fresh image, not the stale null");

    iv.__edgeRecoveryTickForTests();          // backoff tick → attempt 2 (ZERO, not uncached)
    await flush();
    iv.__edgeRecoveryTickForTests();          // recheck → refresh via getImage(), then classify
    await flush();
    const ev2 = lastEvent("edge_recovery");
    assert.equal(ev2.props.attempt, 2);
    assert.equal(ev2.props.trigger, "zero",
      "attempt 2 reaches the real-fetch ZERO branch — the field bug re-issued uncached here");
    assert.equal(ev2.props.result, "recovered");
    assert.equal(ev2.props.spatial_after, 4);
    assert.equal(callCount(), 2, "at most two setFilter() calls, ever");

    // imgOld is still uncached — proving recovery read the FRESH image, not it.
    assert.equal(imgOld.spatialEdges.cached, false,
      "the load-time latched object was never mutated; the fix reads getImage()");

    iv.endRound();
    const pano = lastEvent("pano_session");
    assert.equal(pano.props.edge_recoveries, 2);
    assert.equal(pano.props.anchor_spatial_edges, 4,
      "a successful recovery backfills anchor_spatial_edges even when the image was replaced");
    iv.destroy();
  });

test("endRound cancels pending recovery — a tick after endRound is a no-op", async () => {
  const iv = makeHostViewer();
  const raw = iv.viewer;
  raw.setFilter = () => { throw new Error("must not be called"); };
  iv.beginRound(1);
  await iv.moveTo("anchor-end", "anchor");
  iv.viewer.emit("image", { image: { id: "anchor-end", spatialEdges: { cached: false, edges: [] } } });
  iv.endRound();
  iv.__edgeRecoveryTickForTests();
  assert.equal(events("edge_recovery").length, 0);
  iv.destroy();
});

test("destroy cancels pending recovery — no setFilter after destroy", async () => {
  const iv = makeHostViewer();
  const raw = iv.viewer;
  raw.setFilter = () => { throw new Error("must not be called"); };
  iv.beginRound(1);
  await iv.moveTo("anchor-destroy", "anchor");
  iv.viewer.emit("image", { image: { id: "anchor-destroy", spatialEdges: { cached: false, edges: [] } } });
  iv.destroy();
  iv.__edgeRecoveryTickForTests();
  assert.equal(events("edge_recovery").length, 0);
});

test("mutation guard: attempt 1 alone never recovers — proves EDGE_RECOVERY_MAX_ATTEMPTS must be 2",
  async () => {
    const iv = makeHostViewer();
    const raw = iv.viewer;
    const img = { id: "two-step-1", spatialEdges: { cached: false, edges: [] } };
    const callCount = twoStepSetFilter(raw, img);
    iv.beginRound(1);
    await iv.moveTo("two-step-1", "anchor");
    iv.viewer.emit("image", { image: img });

    iv.__edgeRecoveryTickForTests(); await flush();   // attempt 1
    iv.__edgeRecoveryTickForTests();                  // classify 1
    assert.equal(callCount(), 1);
    assert.equal(lastEvent("edge_recovery").props.result, "no_change",
      "stopping after attempt 1 (as a cap of 1 would force) leaves the arrows unrecovered — " +
      "this is why EDGE_RECOVERY_MAX_ATTEMPTS must be 2, not 1");

    // The real cap (2) lets the second, recovering attempt fire:
    iv.__edgeRecoveryTickForTests(); await flush();   // attempt 2
    iv.__edgeRecoveryTickForTests();
    assert.equal(callCount(), 2);
    assert.equal(lastEvent("edge_recovery").props.result, "recovered");
    iv.destroy();
  });

/* ================================================================
 * §18 render-death probe + bounded rebuild (docs/ios-blackout-review.md).
 * The probe schedule routes through __renderProbeTickForTests, the same seam
 * convention as edge recovery — nothing here sleeps for a real delay.
 * ================================================================ */

const flushMicro = () => new Promise((r) => setTimeout(r, 0));

function makeDailyViewer(opts = {}) {
  const recoveryCalls = [];
  const iv = viewerUi.createViewer({
    surface: "daily",
    container: "dailyViewer",
    moveAllowed: opts.moveAllowed !== false,
    onRecovery: (result) => recoveryCalls.push(result),
    component: {
      cover: false,
      direction: opts.moveAllowed !== false,
      sequence: opts.moveAllowed !== false,
      keyboard: opts.moveAllowed !== false,
    },
  });
  iv._recoveryCalls = recoveryCalls;
  return iv;
}

// Drive a healthy anchor load that binds the canvas and arms the probe.
async function healthyAnchor(iv, raw, canvas, id = "anchor-1") {
  raw._canvas = canvas;
  iv.beginRound(3);
  await iv.moveTo(id, "anchor");
}

test("§18 probe: a healthy anchor arms a probe that reads alive — no events, no rebuild", async () => {
  const iv = makeDailyViewer();
  const raw = iv.viewer;
  await healthyAnchor(iv, raw, makeCanvas({ ctxLost: false, content: true }));
  iv.__renderProbeTickForTests();          // first probe → alive
  assert.equal(events("render_probe").length, 0, "an alive verdict emits nothing");
  assert.equal(events("render_recovery").length, 0);
  assert.equal(mly.viewers.length, 1, "no rebuild");
  iv.destroy();
});

test("§18 D1 late canvas: the listener binds on the FIRST successful attempt (the incident shape)",
  async () => {
    const iv = makeDailyViewer();
    const raw = iv.viewer;
    const late = makeCanvas();
    // getCanvas() is null at create AND at t0 — the canvas only enters the DOM
    // when the first moveTo settles (F5). Simulate by attaching it in moveTo.
    raw.moveTo = (id) => { raw._canvas = late; raw.movedTo = id; return Promise.resolve(); };
    assert.equal(raw.getCanvas(), null, "no canvas at create");
    iv.beginRound(1);
    await iv.moveTo("anchor-1", "anchor");
    // The success re-attached — the listener is now bound to the late canvas.
    late.dispatch("webglcontextlost", {});
    assert.equal(env.posthog.exceptions.slice(-1)[0].props.error_class, "webgl_context_lost");
    iv.destroy();
  });

test("§18 D1 rebind: a canvas that changes between loads detaches the old listener, binds the new",
  async () => {
    const iv = makeDailyViewer();
    const raw = iv.viewer;
    const c1 = makeCanvas();
    const c2 = makeCanvas();
    raw._canvas = c1;
    iv.beginRound(1);
    await iv.moveTo("a1", "anchor");     // binds c1
    raw._canvas = c2;
    await iv.moveTo("a2", "anchor");     // rebinds to c2, detaches c1
    const before = env.posthog.exceptions.length;
    c1.dispatch("webglcontextlost", {}); // stale listener gone → nothing
    assert.equal(env.posthog.exceptions.length, before, "old canvas listener detached");
    c2.dispatch("webglcontextlost", {}); // live listener → one issue
    assert.equal(env.posthog.exceptions.slice(-1)[0].props.error_class, "webgl_context_lost");
    iv.destroy();
  });

test("§18 D6: webglcontextrestored resizes and schedules a probe", async () => {
  const iv = makeDailyViewer();
  const raw = iv.viewer;
  const canvas = makeCanvas({ ctxLost: false });
  await healthyAnchor(iv, raw, canvas);
  const resizesBefore = raw.resizes || 0;
  // The context comes back but the canvas is actually dead now: the restore
  // schedules a probe that will catch it.
  canvas._gl = makeFakeGl({ lost: true });
  canvas.dispatch("webglcontextrestored", {});
  assert.ok((raw.resizes || 0) > resizesBefore, "restore resizes to force a repaint");
  iv.__renderProbeTickForTests();          // the restore-scheduled probe runs
  assert.equal(lastEvent("render_probe").props.verdict, "dead");
  iv.destroy();
});

test("§18 suspect: a blank sample with a healthy canary is suspect → resize nudge, never a rebuild",
  async () => {
    const iv = makeDailyViewer();
    const raw = iv.viewer;
    // Healthy context, but the pixel sample reads uniform (blank) — the exact
    // preserveDrawingBuffer trap. Canary is healthy (default) → suspect.
    const canvas = makeCanvas({ ctxLost: false, content: false });
    await healthyAnchor(iv, raw, canvas);
    const resizesBefore = raw.resizes || 0;
    iv.__renderProbeTickForTests();
    const ev = lastEvent("render_probe");
    assert.equal(ev.props.verdict, "suspect");
    assert.equal(ev.props.canary_ok, true);
    assert.equal(ev.props.sample, "blank");
    assert.ok((raw.resizes || 0) > resizesBefore, "suspect nudges with a resize");
    assert.equal(events("render_recovery").length, 0, "a suspect NEVER rebuilds");
    assert.equal(mly.viewers.length, 1);
    iv.destroy();
  });

test("§18 dead: ctxLost verdict emits render_dead + render_probe, forces recording, flags the fold, rebuilds",
  async () => {
    const iv = makeDailyViewer();
    const raw = iv.viewer;
    const canvas = makeCanvas({ ctxLost: false });
    await healthyAnchor(iv, raw, canvas, "anchor-1");
    env.posthog.reset();                     // isolate the probe's own captures
    canvas._gl = makeFakeGl({ lost: true }); // the context dies
    iv.__renderProbeTickForTests();          // probe → dead → rebuild

    // 1) one render_dead exception, 2) one render_probe event, 3) recording forced
    const deadEx = env.posthog.exceptions.filter((e) => e.props.error_class === "render_dead");
    assert.equal(deadEx.length, 1, "exactly one render_dead trackError");
    const probe = lastEvent("render_probe");
    assert.equal(probe.props.verdict, "dead");
    assert.equal(probe.props.ctx_lost, true);
    assert.ok(env.posthog.recordings >= 1, "a render death forces recording");

    // 4) the raw viewer was replaced behind the SAME iv façade
    assert.equal(mly.viewers.length, 2, "a fresh viewer was constructed");
    assert.equal(iv.viewer, mly.viewers[1], "iv.viewer points at the replacement");
    assert.equal(raw.removed, true, "the dead viewer was torn down");
    // 5) resume moveTo issued at the anchor (player never navigated off)
    await flushMicro();
    assert.equal(mly.viewers[1].movedTo, "anchor-1");
    assert.equal(lastEvent("imagery_load").props.purpose, "resume");

    // 6) the pano fold carries render_dead: true
    iv.endRound();
    assert.equal(lastEvent("pano_session").props.render_dead, true);
    iv.destroy();
  });

test("§18 rebuild target: after the player walks off the anchor, resume returns to their CURRENT image",
  async () => {
    const iv = makeDailyViewer();
    const raw = iv.viewer;
    const canvas = makeCanvas({ ctxLost: false });
    await healthyAnchor(iv, raw, canvas, "anchor-1");
    // The player navigated to a neighbour (an image event we did not ask for).
    raw.emit("image", { image: { id: "neighbour-9" } });
    canvas._gl = makeFakeGl({ lost: true });
    iv.__renderProbeTickForTests();
    await flushMicro();
    assert.equal(mly.viewers[1].movedTo, "neighbour-9",
      "resume lands where the player was standing, not the anchor");
    iv.destroy();
  });

test("§18 hard mode comes back frozen: a rebuilt no-move viewer re-asserts the deactivated lever",
  async () => {
    const iv = makeDailyViewer({ moveAllowed: false });
    const raw = iv.viewer;
    iv.setMoveAllowed(false);                 // G6 Hard
    const canvas = makeCanvas({ ctxLost: false });
    raw._canvas = canvas;
    iv.beginRound(2);
    await iv.moveTo("anchor-h", "anchor");
    canvas._gl = makeFakeGl({ lost: true });
    iv.__renderProbeTickForTests();           // dead → rebuild
    const rebuilt = mly.viewers[1];
    assert.deepEqual(rebuilt.deactivated, ["direction", "sequence", "keyboard"],
      "the replacement viewer comes back with movement frozen");
    iv.destroy();
  });

test("§18 recovered: the re-armed probe reads alive → one render_recovery(recovered), silent (no toast)",
  async () => {
    const iv = makeDailyViewer();
    const raw = iv.viewer;
    const canvas = makeCanvas({ ctxLost: false });
    await healthyAnchor(iv, raw, canvas, "anchor-1");
    canvas._gl = makeFakeGl({ lost: true });
    iv.__renderProbeTickForTests();           // dead → rebuild
    await flushMicro();                        // resume settles, re-arms the probe
    // The replacement viewer paints fine — its getCanvas is healthy.
    mly.viewers[1]._canvas = makeCanvas({ ctxLost: false, content: true });
    iv.__renderProbeTickForTests();           // verification probe → alive
    const rec = lastEvent("render_recovery");
    assert.equal(rec.props.result, "recovered");
    assert.equal(rec.props.trigger, "context_lost");
    assert.equal(iv._recoveryCalls.length, 0, "a successful recovery is SILENT");
    iv.destroy();
  });

test("§18 still dead + single-shot: a second dead verdict the same round does NOT rebuild again; toasts",
  async () => {
    const iv = makeDailyViewer();
    const raw = iv.viewer;
    const canvas = makeCanvas({ ctxLost: false });
    await healthyAnchor(iv, raw, canvas, "anchor-1");
    canvas._gl = makeFakeGl({ lost: true });
    iv.__renderProbeTickForTests();           // dead → rebuild (1/round)
    await flushMicro();
    assert.equal(mly.viewers.length, 2);
    // The replacement is ALSO dead.
    mly.viewers[1]._canvas = makeCanvas({ ctxLost: true });
    iv.__renderProbeTickForTests();           // verification probe → still dead
    assert.equal(mly.viewers.length, 2, "the per-round budget (1) forbids a second rebuild");
    const rec = lastEvent("render_recovery");
    assert.equal(rec.props.result, "still_dead");
    assert.deepEqual(iv._recoveryCalls, ["still_dead"], "a failed recovery toasts once");
    iv.destroy();
  });

test("§18 D5 soul: a blank sample NEVER escalates to dead on its own (no ctxLost, no canary condemnation)",
  async () => {
    const iv = makeDailyViewer();
    const raw = iv.viewer;
    // Context readable-and-healthy, sample uniform, canary healthy → suspect.
    const canvas = makeCanvas({ ctxLost: false, content: false });
    await healthyAnchor(iv, raw, canvas);
    iv.__renderProbeTickForTests();
    assert.equal(lastEvent("render_probe").props.verdict, "suspect");
    assert.equal(events("render_recovery").length, 0);
    assert.equal(mly.viewers.length, 1, "a blank sample alone must never rebuild a healthy viewer");
    iv.destroy();
  });

test("§18 canary-dead path: unreadable context + dead canary is dead (GPU layer down)", async () => {
  const iv = makeDailyViewer();
  const raw = iv.viewer;
  const canvas = makeCanvas({ ctxLost: null, content: false }); // no obtainable context
  await healthyAnchor(iv, raw, canvas);
  canaryDead = true;                          // force the offscreen canary down
  iv.__renderProbeTickForTests();
  const probe = lastEvent("render_probe");
  assert.equal(probe.props.verdict, "dead");
  assert.equal(probe.props.canary_ok, false);
  assert.ok(!("ctx_lost" in probe.props), "unreadable context ⇒ ctx_lost absent");
  assert.equal(mly.viewers.length, 2, "a canary-dead verdict still drives a rebuild");
  iv.destroy();
});

test("§18 lifecycle: endRound / destroy / a new attempt each cancel a pending probe", async () => {
  // endRound cancels
  let iv = makeDailyViewer();
  await healthyAnchor(iv, iv.viewer, makeCanvas({ ctxLost: true }));
  iv.endRound();
  iv.__renderProbeTickForTests();             // nothing pending → no verdict
  assert.equal(events("render_probe").length, 0, "endRound cancelled the armed probe");
  iv.destroy();

  // a new attempt() supersedes the pending probe (its success re-arms afresh)
  env.posthog.reset();
  iv = makeDailyViewer();
  const raw = iv.viewer;
  raw._canvas = makeCanvas({ ctxLost: true });
  iv.beginRound(1);
  await iv.moveTo("a1", "anchor");            // arms a probe
  await iv.moveTo("a2", "nav");               // a nav load cancels it mid-flight
  // the nav is not a covered purpose, so it does NOT re-arm — no probe pending
  iv.__renderProbeTickForTests();
  assert.equal(events("render_probe").length, 0, "a superseding load cancelled the probe");
  iv.destroy();
});

test("§18 D2 teardown order: destroy detaches BEFORE remove() — the SDK's loseContext fires into nothing",
  async () => {
    const iv = makeDailyViewer();
    const raw = iv.viewer;
    const canvas = makeCanvas({ ctxLost: false });
    await healthyAnchor(iv, raw, canvas);     // binds the listener
    env.posthog.reset();
    iv.destroy();                             // detach, THEN remove() fires loseContext
    assert.equal(raw.removed, true);
    const lost = env.posthog.exceptions.filter((e) => e.props.error_class === "webgl_context_lost");
    assert.equal(lost.length, 0, "a normal teardown emits zero webgl_context_lost");
    assert.equal(events("render_probe").length, 0, "and zero probe verdicts");
  });

test("§18 D2 (rebuild): the in-place rebuild's teardown also fires loseContext into a detached canvas",
  async () => {
    const iv = makeDailyViewer();
    const raw = iv.viewer;
    const canvas = makeCanvas({ ctxLost: false });
    await healthyAnchor(iv, raw, canvas, "anchor-1");
    canvas._gl = makeFakeGl({ lost: true });
    env.posthog.reset();
    iv.__renderProbeTickForTests();           // dead → rebuild (remove() fires loseContext)
    // The only webgl_context_lost we should EVER see is zero — the rebuild
    // detached before remove(), exactly like destroy() (D2/F8).
    const lost = env.posthog.exceptions.filter((e) => e.props.error_class === "webgl_context_lost");
    assert.equal(lost.length, 0, "rebuild teardown emits no spurious context-lost");
    iv.destroy();
  });

test("§18 pagehide (G3/D7): an open round fold is flushed exactly once with partial:true", () => {
  const iv = makeDailyViewer();
  iv.beginRound(4);
  iv.viewer.emit("pov", {});                  // some interaction folds in
  assert.equal(events("pano_session").length, 0, "no fold emitted yet");
  window.dispatchEvent("pagehide", {});       // the wrapper's pagehide listener
  const ev = lastEvent("pano_session");
  assert.equal(ev.props.round_number, 4);
  assert.equal(ev.props.partial, true, "a torn round is flagged partial");
  // The fold is cleared, so a normal endRound does not double-emit it.
  const count = events("pano_session").length;
  iv.endRound();
  assert.equal(events("pano_session").length, count, "pagehide already flushed the fold");
  iv.destroy();
});

test("§18 stub viewer: never probes and never rebuilds", async () => {
  mly.supported = false;                      // forces a stub (webgl_unavailable)
  const iv = makeDailyViewer();
  assert.equal(iv.ok, false);
  assert.equal(typeof iv.__renderProbeTickForTests, "undefined",
    "a stub exposes no probe seam");
  const s = sampler("x1");
  await viewerUi.loadRoundImage(s, iv, "anchor");
  assert.equal(events("render_probe").length, 0);
  assert.equal(events("render_recovery").length, 0);
  iv.destroy();
});
