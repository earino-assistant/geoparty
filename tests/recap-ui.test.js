// Tests for js/recap-ui.js — the shared recap carousel glue (the one carousel
// builder for the Daily done screen + party game-over). Mirrors the
// revealmap-ui.test.js fake-`L` precedent: a fake `document`, a fake
// IntersectionObserver the test drives by hand, and a fake `renderRevealScene`
// via a stubbed global `L`, so the eager-init, lazy-init, engagement latch and
// teardown are deterministic in CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recapEagerCount } from "../js/recap.js";

/* ================================================================
 * A tiny fake DOM + a hand-driven IntersectionObserver, plus a fake
 * Leaflet so renderRevealScene builds a destroyable map handle.
 * ================================================================ */

function makeEl(className = "") {
  const el = {
    className,
    dataset: {},
    children: [],
    _listeners: {},
    _classes: new Set(className ? className.split(" ") : []),
    classList: {
      add: (...cs) => cs.forEach((c) => el._classes.add(c)),
      remove: (...cs) => cs.forEach((c) => el._classes.delete(c)),
      contains: (c) => el._classes.has(c),
    },
    append: (...kids) => { el.children.push(...kids); },
    appendChild: (kid) => { el.children.push(kid); return kid; },
    addEventListener: (type, fn) => { (el._listeners[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => {
      el._listeners[type] = (el._listeners[type] || []).filter((f) => f !== fn);
    },
    set textContent(v) { if (v === "") el.children = []; el._text = v; },
    get textContent() { return el._text; },
    fire: (type) => { for (const fn of el._listeners[type] || []) fn(); },
  };
  return el;
}

function installEnv() {
  const saved = {
    doc: globalThis.document, IO: globalThis.IntersectionObserver, L: globalThis.L,
  };
  const observers = [];
  globalThis.document = {
    createElement: () => makeEl(),
  };
  class FakeIO {
    constructor(cb, opts) { this.cb = cb; this.opts = opts; this.observed = []; this.disconnected = false; observers.push(this); }
    observe(el) { this.observed.push(el); }
    unobserve(el) { this.observed = this.observed.filter((o) => o !== el); }
    disconnect() { this.disconnected = true; }
    // test helper: fire an intersection for `el`
    intersect(el) { this.cb([{ isIntersecting: true, target: el }]); }
  }
  globalThis.IntersectionObserver = FakeIO;
  // A fake Leaflet so renderRevealScene (imported by recap-ui) builds a
  // handle whose destroy() we can count.
  let mapCount = 0;
  const removed = [];
  globalThis.L = {
    map: () => { const id = ++mapCount; return { _id: id, layers: [], fitBounds() {}, setView() {}, invalidateSize() {}, remove() { removed.push(id); } }; },
    tileLayer: () => ({ addTo() { return this; } }),
    latLng: (lat, lng) => ({ lat, lng }),
    latLngBounds: (pts) => ({ pts, pad() { return this; } }),
    polyline: () => ({ addTo() { return this; }, setLatLngs() {} }),
    circleMarker: () => ({ addTo() { return this; }, bindTooltip() { return this; } }),
    marker: () => ({ addTo() { return this; } }),
    divIcon: (o) => o,
  };
  const restore = () => {
    globalThis.document = saved.doc;
    globalThis.IntersectionObserver = saved.IO;
    globalThis.L = saved.L;
  };
  return { observers, mapsMade: () => mapCount, removed, restore };
}

const { createRecapCarousel } = await import("../js/recap-ui.js");

const CARDS = [
  { round: 1, foo: "a" }, { round: 2, foo: "b" },
  { round: 3, foo: "c" }, { round: 4, foo: "d" },
];
const sceneFor = () => ({ ops: [], cascade: [], finale: [] });
const captionFor = (c) => `cap-${c.round}`;

async function withEnv(fn) {
  const env = installEnv();
  try { return await fn(env); } finally { env.restore(); }
}

/* ---------------- tests ---------------- */

test("N cards → N .recap-card elements with captions from captionFor", async () => {
  await withEnv(() => {
    const box = makeEl("recap hidden");
    const carousel = makeEl("recap-carousel");
    createRecapCarousel({ box, carousel, cards: CARDS, sceneFor, captionFor });
    assert.equal(carousel.children.length, 4);
    for (let i = 0; i < 4; i++) {
      const card = carousel.children[i];
      assert.equal(card.className, "recap-card");
      assert.equal(card.dataset.round, String(i + 1));
      const cap = card.children[1];
      assert.equal(cap.className, "recap-caption");
      assert.equal(cap.textContent, `cap-${i + 1}`);
    }
    assert.ok(!box.classList.contains("hidden"), "box shown when cards exist");
  });
});

test("exactly recapEagerCount(N) maps are initialized before any intersection", async () => {
  await withEnv((env) => {
    const box = makeEl();
    const carousel = makeEl();
    createRecapCarousel({ box, carousel, cards: CARDS, sceneFor, captionFor });
    assert.equal(env.mapsMade(), recapEagerCount(CARDS.length)); // 2
  });
});

test("an intersection initializes that card's map exactly once", async () => {
  await withEnv((env) => {
    const box = makeEl();
    const carousel = makeEl();
    createRecapCarousel({ box, carousel, cards: CARDS, sceneFor, captionFor });
    const before = env.mapsMade();               // 2 eager
    const io = env.observers[0];
    const lazyCard = carousel.children[3];        // card 4, not eager
    io.intersect(lazyCard);
    assert.equal(env.mapsMade(), before + 1);
    io.intersect(lazyCard);                       // unobserved → no re-init
    assert.equal(env.mapsMade(), before + 1);
  });
});

test("onEngage fires exactly once across multiple scroll events", async () => {
  await withEnv(() => {
    const box = makeEl();
    const carousel = makeEl();
    let n = 0;
    createRecapCarousel({ box, carousel, cards: CARDS, sceneFor, captionFor, onEngage: () => { n++; } });
    carousel.fire("scroll");
    carousel.fire("scroll");
    carousel.fire("scroll");
    assert.equal(n, 1);
  });
});

test("destroy() is idempotent: observer disconnected, maps destroyed, carousel emptied, box hidden", async () => {
  await withEnv((env) => {
    const box = makeEl();
    const carousel = makeEl();
    const handle = createRecapCarousel({ box, carousel, cards: CARDS, sceneFor, captionFor });
    // realize all four maps so all four handles must be destroyed
    for (const c of carousel.children) env.observers[0].intersect(c);
    assert.equal(env.mapsMade(), 4);
    handle.destroy();
    assert.ok(env.observers[0].disconnected);
    assert.deepEqual(env.removed.sort(), [1, 2, 3, 4]);
    assert.equal(carousel.children.length, 0);
    assert.ok(box.classList.contains("hidden"));
    handle.destroy();   // no throw on second call
  });
});

test("zero cards → box hidden, no observer created, inert handle", async () => {
  await withEnv((env) => {
    const box = makeEl();
    const carousel = makeEl();
    const handle = createRecapCarousel({ box, carousel, cards: [], sceneFor, captionFor });
    assert.ok(box.classList.contains("hidden"));
    assert.equal(env.observers.length, 0);
    assert.equal(carousel.children.length, 0);
    handle.destroy();   // inert, no throw
  });
});

test("no IntersectionObserver → all maps initialized eagerly", async () => {
  await withEnv((env) => {
    const savedIO = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = undefined;
    try {
      const box = makeEl();
      const carousel = makeEl();
      createRecapCarousel({ box, carousel, cards: CARDS, sceneFor, captionFor });
      assert.equal(env.mapsMade(), 4);
    } finally {
      globalThis.IntersectionObserver = savedIO;
    }
  });
});
