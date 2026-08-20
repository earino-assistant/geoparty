// Tests for js/report-ui.js — the "Report it" flow (field-observability
// plan §10) as reconciled with docs/ui-ux-design-review.md: no permanent
// pano chrome, a reactive inline toast action, a calm-state settings link,
// and an explicit one-time diagnostic consent for users who said no.
//
// The pure parts (ref codes, the bundle fold) are covered in
// tests/imagery.test.js and the gate itself in tests/analytics.test.js.
// What this file proves is the branch that matters most: a decliner sees
// the one-time copy, sends at most one bundle, and their stored "no"
// survives untouched.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

/* ---------------- a fake DOM with real descendant queries ---------------- */

function makeElement(tag) {
  const classes = new Set();
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    listeners: {},
    dataset: {},
    style: {},
    disabled: false,
    _text: "",
    get className() { return [...classes].join(" "); },
    set className(v) {
      classes.clear();
      String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
    },
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
    append(...kids) { kids.forEach((k) => { k.parent = el; }); this.children.push(...kids); },
    appendChild(kid) { kid.parent = el; this.children.push(kid); return kid; },
    addEventListener(name, fn) {
      (this.listeners[name] = this.listeners[name] || []).push(fn);
    },
    removeEventListener() {},
    click() { for (const fn of (this.listeners.click || []).slice()) fn({ preventDefault() {} }); },
    querySelector(sel) {
      const want = sel.replace(/^\./, "");
      const walk = (node) => {
        for (const c of node.children) {
          if (c.classList && c.classList.contains(want)) return c;
          const deep = walk(c);
          if (deep) return deep;
        }
        return null;
      };
      return walk(this);
    },
    cloneNode() {
      const copy = makeElement(tag);
      copy.className = this.className;
      copy.textContent = this._text;
      return copy;
    },
    replaceWith(next) {
      const p = this.parent;
      if (!p) return;
      const i = p.children.indexOf(this);
      if (i >= 0) { p.children[i] = next; next.parent = p; }
    },
  };
  return el;
}

function install(consentValue) {
  const store = new Map();
  if (consentValue) store.set("geoparty_analytics_consent", consentValue);

  const body = makeElement("body");
  const doc = {
    head: makeElement("head"),
    body,
    createElement: (t) => makeElement(t),
    getElementById: () => makeElement("div"),
  };

  const sinks = { main: [], oneShot: [], oneShotExceptions: [], optedOut: false };
  const makePosthog = (kind) => ({
    __loaded: false,
    init(key, opts, name) {
      if (name) return makePosthogNamed(name);
      this.__loaded = true;
      return this;
    },
    capture(e, p) { sinks[kind].push({ event: e, props: p }); },
    captureException(err, p) { sinks[`${kind}Exceptions`].push({ err, props: p }); },
    register() {},
    startSessionRecording() {},
    onFeatureFlags() {},
    isFeatureEnabled: () => true,
    get_session_id: () => "sess-1",
    opt_out_capturing() { sinks.optedOut = true; },
    opt_in_capturing() {},
  });
  const makePosthogNamed = () => {
    const inst = {
      capture(e, p) { sinks.oneShot.push({ event: e, props: p }); },
      captureException(err, p) { sinks.oneShotExceptions.push({ err, props: p }); },
      opt_out_capturing() { sinks.optedOut = true; },
    };
    ph.gpDiag = inst;
    return inst;
  };
  sinks.mainExceptions = [];
  const ph = makePosthog("main");

  const define = (n, v) => Object.defineProperty(globalThis, n,
    { value: v, configurable: true, writable: true });
  define("window", { localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  }, posthog: ph });
  define("document", doc);
  define("location", { hostname: "localhost", pathname: "/player.html" });
  define("navigator", { onLine: true, connection: { effectiveType: "4g" } });
  define("fetch", () => Promise.resolve({ ok: false, status: 404 }));
  define("mapillary", undefined);

  return { store, sinks, body, doc };
}

/* ================================================================ */

let env;
let reportUi;

before(async () => {
  env = install("declined");         // the interesting branch, by default
  reportUi = await import("../js/report-ui.js");
  await new Promise((r) => setTimeout(r, 0));
});

beforeEach(() => {
  env.sinks.main.length = 0;
  env.sinks.oneShot.length = 0;
  env.sinks.oneShotExceptions.length = 0;
  env.sinks.optedOut = false;
});

const sheet = () => env.body.children.find((c) => c.classList.contains("report-sheet"));
const partOf = (cls) => sheet().querySelector(`.${cls}`);
const tick = () => new Promise((r) => setTimeout(r, 0));

test("reactive toast: the message and one inline Report action, nothing more", () => {
  const el = makeElement("div");
  reportUi.toastWithReport(el, "Imagery failed to load", { surface: "player" });
  assert.equal(el.classList.contains("has-action"), true);
  assert.equal(el.children.length, 2, "message + action, no stacking");
  assert.equal(el.children[0].textContent, "Imagery failed to load");
  assert.equal(el.children[1].textContent, "Report");
  assert.equal(el.children[1].tagName, "BUTTON");
});

test("reactive toast: toastPlain restores an ordinary, non-interactive toast", () => {
  const el = makeElement("div");
  reportUi.toastWithReport(el, "broken", { surface: "player" });
  reportUi.toastPlain(el, "Location pool exhausted!");
  assert.equal(el.classList.contains("has-action"), false);
  assert.equal(el.textContent, "Location pool exhausted!");
  assert.equal(el.children.length, 0);
});

test("a decliner is asked for explicit one-time consent, in the plan's words", () => {
  reportUi.openReportSheet({ surface: "player" });
  assert.equal(partOf("report-title").textContent,
    "Send a one-time diagnostic report?");
  const body = partOf("report-body").textContent;
  assert.ok(body.includes("You’ve said no to analytics"));
  assert.ok(body.includes("one report, not ongoing tracking"));
  assert.ok(body.includes("Never your location, guesses, or names"));
  assert.equal(partOf("report-send").textContent, "Send one report");
  assert.equal(partOf("report-cancel").textContent, "No thanks");
});

test("opening the sheet sends NOTHING until the user taps send", async () => {
  reportUi.openReportSheet({ surface: "player" });
  await tick();
  assert.equal(env.sinks.oneShot.length, 0);
  assert.equal(env.sinks.main.length, 0);
});

test("cancelling sends nothing and closes the sheet", async () => {
  reportUi.openReportSheet({ surface: "player" });
  partOf("report-cancel").click();
  await tick();
  assert.equal(env.sinks.oneShot.length, 0);
  assert.equal(sheet().classList.contains("hidden"), true);
});

test("sending: one bundle through the one-shot path, then opt out", async () => {
  reportUi.openReportSheet({ surface: "player" });
  partOf("report-send").click();
  await tick();
  await tick();

  assert.equal(env.sinks.oneShot.length, 1, "exactly one event");
  const ev = env.sinks.oneShot[0];
  assert.equal(ev.event, "imagery_report");
  assert.equal(ev.props.consent, "one_time");
  assert.equal(ev.props.surface, "player");
  assert.match(ev.props.ref_code, /^GP-[0-9A-HJKMNP-TV-Z]{6}$/);
  assert.equal(env.sinks.oneShotExceptions.length, 1);
  assert.equal(env.sinks.main.length, 0, "the consented instance stays silent");
  assert.equal(env.sinks.optedOut, true);
});

test("sending: the stored decline is never rewritten", async () => {
  assert.equal(env.store.get("geoparty_analytics_consent"), "declined");
  reportUi.openReportSheet({ surface: "player" });
  partOf("report-send").click();
  await tick();
  await tick();
  assert.equal(env.store.get("geoparty_analytics_consent"), "declined");
});

test("sending: the confirmation shows the reference code to quote to support",
  async () => {
    reportUi.openReportSheet({ surface: "player" });
    partOf("report-send").click();
    await tick();
    await tick();
    const body = partOf("report-body").textContent;
    assert.ok(body.startsWith("Your reference code is GP-"));
    assert.ok(body.includes("Mention it if you get in touch"));
    assert.equal(partOf("report-title").textContent, "Thanks — sent.");
    // The code shown is the code sent.
    assert.ok(body.includes(env.sinks.oneShot.slice(-1)[0].props.ref_code));
  });

test("each report gets its own reference code", async () => {
  for (let i = 0; i < 2; i++) {
    reportUi.openReportSheet({ surface: "player" });
    partOf("report-send").click();
    await tick();
    await tick();
  }
  const codes = env.sinks.oneShot.map((e) => e.props.ref_code);
  assert.equal(codes.length, 2);
  assert.notEqual(codes[0], codes[1]);
});

test("the send button disables on tap, so a double-tap cannot double-send",
  async () => {
    reportUi.openReportSheet({ surface: "player" });
    const send = partOf("report-send");
    send.click();
    assert.equal(send.disabled, true);
    await tick();
    await tick();
    assert.equal(env.sinks.oneShot.length, 1);
  });

test("a blocked/failed send reports the failure honestly and collects nothing",
  async (t) => {
    // Kill the one-shot instance path the way an ad blocker would. Restore via
    // t.after so a mid-test assertion failure can't leave posthog.init broken
    // for every later test (review test-credibility item).
    const realInit = window.posthog.init;
    t.after(() => { window.posthog.init = realInit; });
    window.posthog.init = () => { throw new Error("blocked"); };
    delete window.posthog.gpDiag;
    reportUi.openReportSheet({ surface: "player" });
    partOf("report-send").click();
    await tick();
    await tick();
    assert.equal(partOf("report-title").textContent, "Not sent");
    assert.ok(partOf("report-body").textContent.includes("No data was collected"));
    assert.equal(env.sinks.oneShot.length, 0);
  });

test("openReportFromSettings: the calm-state entry point needs only a surface",
  () => {
    reportUi.openReportFromSettings("host");
    assert.equal(sheet().classList.contains("hidden"), false);
    partOf("report-cancel").click();
  });
