// Tests for js/revealmap-ui.js — the thin Leaflet glue. Mirrors the
// viewer-ui.test.js fake-`L` precedent: a ~60-line fake Leaflet plus fake
// requestAnimationFrame/setTimeout queues the test drives by hand, so the
// cascade animation, the delayed ghost beat, and every teardown path are
// deterministic in CI instead of a one-off checklist.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dailyRevealScene, phoneRevealScene, tvSoloRevealScene, tvCascadeRevealScene,
  LEAFLET_MAP_OPTIONS,
} from "../js/revealmap.js";

/* ================================================================
 * A very small fake Leaflet + a hand-driven rAF/timer clock.
 * ================================================================ */

function installEnv() {
  const log = [];       // ordered record of map/layer actions
  const layers = [];    // every created layer, for signature lookups
  let rafQ = [];
  let rafId = 0;
  let timerQ = [];
  let timerId = 0;
  let clock = 0;

  function makeLayer(kind, a, b) {
    const layer = {
      kind, args: [a, b], el: { style: {} },
      addTo(m) { log.push({ t: "add", kind }); m.layers.push(layer); layer.added = true; return layer; },
      bindTooltip(html, opts) { log.push({ t: "tooltip", kind, html }); layer.tooltip = { html, opts }; return layer; },
      setLatLngs(pts) { layer.latlngs = pts; return layer; },
      getElement() { return layer.el; },
    };
    layers.push(layer);
    return layer;
  }

  function makeMap(id, opts) {
    return {
      id, opts, layers: [], removed: false,
      fitBounds(b, o) { log.push({ t: "fit", points: b.pts, pad: b.padVal, maxZoom: o.maxZoom }); },
      setView(c, z) { log.push({ t: "view", center: c, zoom: z }); },
      invalidateSize(o) { log.push({ t: "invalidateSize", o }); },
      remove() { this.removed = true; log.push({ t: "remove" }); },
    };
  }

  const L = {
    map: (id, opts) => makeMap(id, opts),
    tileLayer: () => ({ addTo() { log.push({ t: "tile" }); return this; } }),
    latLng: (lat, lng) => ({ lat, lng }),
    latLngBounds: (pts) => ({ pts, padVal: undefined, pad(p) { this.padVal = p; return this; } }),
    divIcon: (o) => ({ divIcon: o }),
    polyline: (pts, style) => makeLayer("polyline", pts, style),
    circleMarker: (latlng, style) => makeLayer("circle", latlng, style),
    marker: (latlng, opts) => makeLayer("marker", latlng, opts),
  };

  const saved = {
    L: globalThis.L,
    raf: globalThis.requestAnimationFrame,
    caf: globalThis.cancelAnimationFrame,
    st: globalThis.setTimeout,
    ct: globalThis.clearTimeout,
  };
  globalThis.L = L;
  globalThis.requestAnimationFrame = (fn) => { const id = ++rafId; rafQ.push({ id, fn }); return id; };
  globalThis.cancelAnimationFrame = (id) => { rafQ = rafQ.filter((r) => r.id !== id); };
  globalThis.setTimeout = (fn, ms) => { const id = ++timerId; timerQ.push({ id, fn, ms }); return id; };
  globalThis.clearTimeout = (id) => { timerQ = timerQ.filter((t) => t.id !== id); };

  // one generation of pending rAF callbacks (may enqueue more)
  const tickRaf = () => {
    const batch = rafQ; rafQ = []; clock += 100000;
    for (const r of batch) r.fn(clock);
  };
  // one generation of pending timers, soonest first
  const tickTimers = () => {
    const batch = timerQ.sort((a, b) => a.ms - b.ms); timerQ = [];
    for (const t of batch) t.fn();
  };
  // run everything to quiescence
  const drive = () => {
    let guard = 0;
    while ((rafQ.length || timerQ.length) && guard++ < 10000) {
      if (rafQ.length) tickRaf(); else tickTimers();
    }
  };

  const restore = () => {
    globalThis.L = saved.L;
    globalThis.requestAnimationFrame = saved.raf;
    globalThis.cancelAnimationFrame = saved.caf;
    globalThis.setTimeout = saved.st;
    globalThis.clearTimeout = saved.ct;
  };

  return {
    log, layers, tickRaf, tickTimers, drive, restore,
    pendingTimers: () => timerQ.length,
    pendingRaf: () => rafQ.length,
  };
}

// Run `fn` with the fake env installed, restoring the real globals after.
async function withEnv(fn) {
  const env = installEnv();
  try {
    return await fn(env);
  } finally {
    env.restore();
  }
}

const { renderRevealScene } = await import("../js/revealmap-ui.js");

/* ---------------- fixtures ---------------- */

const T = { lat: 60, lng: 30 };
const G = { lat: 40, lng: -70 };
const TEAMS = { t1: { name: "Alpha" }, t2: { name: "Beta" } };

/* ================================================================
 * ops execution + map setup
 * ================================================================ */

test("static scene: ops run in order, tile added, bindTooltip after addTo", async () => {
  await withEnv((env) => {
    const scene = phoneRevealScene({
      truth: T, pins: [{ id: "t1", lat: 40, lng: -70, superSure: true, superSureOutcome: "won" }],
      decoys: [], teams: TEAMS,
    });
    renderRevealScene("pRevealMap", scene);
    const kinds = env.log.map((e) => e.t);
    // tile first, then fit, then the pin's line/circle, the halo, the truth,
    // and finally the 60ms invalidateSize is still pending (a timer).
    assert.deepEqual(kinds.slice(0, 2), ["tile", "fit"]);
    // every tooltip is logged AFTER its layer's add
    const firstTip = env.log.findIndex((e) => e.t === "tooltip");
    const anyAddBefore = env.log.slice(0, firstTip).some((e) => e.t === "add");
    assert.ok(anyAddBefore, "a layer was added before the first tooltip");
    // the halo tooltip carries the shared SUPER SURE label
    assert.ok(env.log.some((e) => e.t === "tooltip" && e.html === "SUPER SURE ×2"));
  });
});

test("map is built with the frozen LEAFLET_MAP_OPTIONS", async () => {
  await withEnv((env) => {
    let captured;
    const realMap = globalThis.L.map;
    globalThis.L.map = (id, opts) => { captured = opts; return realMap(id, opts); };
    renderRevealScene("m", dailyRevealScene({ truth: T, guess: null, ghost: null, reducedMotion: false }));
    assert.equal(captured, LEAFLET_MAP_OPTIONS);
    void env;
  });
});

test("daily no-guess: a view op sets the fallback center/zoom", async () => {
  await withEnv((env) => {
    renderRevealScene("m", dailyRevealScene({ truth: T, guess: null, ghost: null, reducedMotion: false }));
    const view = env.log.find((e) => e.t === "view");
    assert.deepEqual(view, { t: "view", center: T, zoom: 4 });
  });
});

/* ================================================================
 * the delayed ghost beat
 * ================================================================ */

const ghostLine = (env) => env.layers.find((l) => l.kind === "polyline" && l.args[1].color === "#c9a2ff");
const ghostCircle = (env) => env.layers.find((l) => l.kind === "circle" && l.args[1].fillColor === "#2a2140");
const ghostChip = (env) => env.layers.find((l) => l.kind === "marker" && l.args[1].icon.divIcon.className === "ghost-chip");

test("delayedGroup (delay 400): the ghost holds until its timer fires, then fades circle+chip only", async () => {
  await withEnv((env) => {
    renderRevealScene("m", dailyRevealScene({
      truth: T, guess: G, ghost: { pin: { lat: 51, lng: 0 }, distanceKm: 12 }, reducedMotion: false,
    }));
    // not drawn yet — the group is a pending timer
    assert.equal(ghostCircle(env), undefined);
    env.tickTimers(); // fire the 400ms group (and the 60ms invalidateSize)
    assert.ok(ghostCircle(env), "ghost circle drawn after the timer");
    assert.ok(ghostChip(env));
    // opacity-0 + transition applied to circle + chip, NOT the line
    assert.equal(ghostCircle(env).el.style.transition, "opacity 350ms ease");
    assert.equal(ghostChip(env).el.style.transition, "opacity 350ms ease");
    assert.equal(ghostLine(env).el.style.transition, undefined);
    env.drive(); // run the double-rAF fade-in
    assert.equal(ghostCircle(env).el.style.opacity, "1");
    assert.equal(ghostChip(env).el.style.opacity, "1");
    assert.equal(ghostLine(env).el.style.opacity, undefined);
  });
});

test("delayedGroup (reduced motion): runs synchronously, no fade", async () => {
  await withEnv((env) => {
    renderRevealScene("m", dailyRevealScene({
      truth: T, guess: G, ghost: { pin: { lat: 51, lng: 0 }, distanceKm: 12 }, reducedMotion: true,
    }));
    // drawn immediately, before any timer fires
    assert.ok(ghostCircle(env));
    assert.equal(ghostCircle(env).el.style.transition, undefined);
    assert.equal(ghostCircle(env).el.style.opacity, undefined);
  });
});

test("destroy() before the group timer fires → the group no-ops", async () => {
  await withEnv((env) => {
    const h = renderRevealScene("m", dailyRevealScene({
      truth: T, guess: G, ghost: { pin: { lat: 51, lng: 0 }, distanceKm: 12 }, reducedMotion: false,
    }));
    h.destroy();
    env.tickTimers();
    assert.equal(ghostCircle(env), undefined, "ghost never drawn after destroy");
  });
});

/* ================================================================
 * the cascade
 * ================================================================ */

function cascadeScene() {
  // one forfeit (t1, no guess) leading a guessed entry (t2)
  return tvCascadeRevealScene({
    truth: T,
    entries: [{ id: "t1", superSure: false }, { id: "t2", guess: { lat: 40, lng: -70 }, superSure: false }],
    decoys: [], teams: TEAMS, reducedMotion: false,
  });
}

test("cascade: onStep fires per step (forfeit skips drawing), then onFinish after the finale", async () => {
  await withEnv((env) => {
    const steps = [];
    let finished = 0;
    renderRevealScene("m", cascadeScene(), {
      onStep: (s) => steps.push(s),
      onFinish: () => { finished += 1; },
    });
    env.drive();
    // forfeit step first (index 0, no line drawn), then the guessed step
    assert.deepEqual(steps, [
      { id: "t1", forfeit: true, index: 0 },
      { id: "t2", forfeit: false, index: 1 },
    ]);
    assert.equal(finished, 1);
    // the finale truth ("Answer") landed after the cascade
    assert.ok(env.log.some((e) => e.t === "tooltip" && e.html === "Answer"));
    // exactly one animated line was drawn (the forfeit drew none)
    assert.equal(env.layers.filter((l) => l.kind === "polyline").length, 1);
  });
});

test("cascade line interpolates all the way to the truth", async () => {
  await withEnv((env) => {
    renderRevealScene("m", tvSoloRevealScene({
      truth: T, guess: G, score: { superSure: false }, reducedMotion: false,
    }));
    env.drive();
    const line = env.layers.find((l) => l.kind === "polyline");
    assert.deepEqual(line.latlngs, [G, T]);
  });
});

test("destroy() mid-cascade → no further steps, no onFinish, no throw", async () => {
  await withEnv((env) => {
    const steps = [];
    let finished = 0;
    const h = renderRevealScene("m", cascadeScene(), {
      onStep: (s) => steps.push(s),
      onFinish: () => { finished += 1; },
    });
    env.tickTimers();          // fire the forfeit's first beat → onStep(t1)
    assert.equal(steps.length, 1);
    h.destroy();
    env.drive();               // everything else must no-op
    assert.equal(steps.length, 1, "no further onStep after destroy");
    assert.equal(finished, 0, "onFinish never fires after destroy");
  });
});

/* ================================================================
 * teardown
 * ================================================================ */

test("invalidateSize is scheduled at 60ms and guarded post-destroy", async () => {
  await withEnv((env) => {
    const h = renderRevealScene("m", dailyRevealScene({ truth: T, guess: null, ghost: null, reducedMotion: false }));
    h.destroy();
    env.tickTimers(); // the 60ms invalidateSize must not run against a dead map
    assert.ok(!env.log.some((e) => e.t === "invalidateSize"), "no invalidateSize after destroy");
  });
});

test("invalidateSize runs when the map is alive", async () => {
  await withEnv((env) => {
    renderRevealScene("m", dailyRevealScene({ truth: T, guess: null, ghost: null, reducedMotion: false }));
    env.tickTimers();
    assert.ok(env.log.some((e) => e.t === "invalidateSize"));
  });
});

test("destroy() twice does not throw and removes the map once", async () => {
  await withEnv((env) => {
    const h = renderRevealScene("m", dailyRevealScene({ truth: T, guess: null, ghost: null, reducedMotion: false }));
    h.destroy();
    h.destroy();
    assert.equal(env.log.filter((e) => e.t === "remove").length, 1);
  });
});
