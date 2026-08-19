// Tests for js/analytics.js — consent state, the event schema sanitizer,
// and the gated tracker (PostHog must not load before opt-in).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONSENT_KEY,
  CONSENT_ACCEPTED,
  CONSENT_DECLINED,
  POSTHOG_PROJECT_KEY,
  POSTHOG_INIT_OPTIONS,
  EVENT_SCHEMA,
  getConsent,
  setConsent,
  sanitizeEvent,
  createAnalytics,
} from "../js/analytics.js";

/* ---------------- test doubles ---------------- */

// localStorage-shaped in-memory store.
function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

// posthog-like capture sink.
function fakePosthog() {
  return {
    captured: [],
    optedOut: false,
    capture(event, props) { this.captured.push({ event, props }); },
    opt_out_capturing() { this.optedOut = true; },
    opt_in_capturing() { this.optedOut = false; },
  };
}

// Harness: an analytics instance whose "loader" resolves synchronously-ish
// to a fake posthog, counting how often it was asked to load.
function harness() {
  const storage = memStorage();
  const ph = fakePosthog();
  const loads = { count: 0, key: null, options: null };
  const a = createAnalytics({
    storage,
    loadPosthog: (key, options) => {
      loads.count++;
      loads.key = key;
      loads.options = options;
      return Promise.resolve(ph);
    },
  });
  return { storage, ph, loads, a };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/* ---------------- consent flag ---------------- */

test("getConsent: null when nothing is stored", () => {
  assert.equal(getConsent(memStorage()), null);
});

test("getConsent: round-trips accepted and declined", () => {
  const s = memStorage();
  setConsent(s, CONSENT_ACCEPTED);
  assert.equal(getConsent(s), CONSENT_ACCEPTED);
  setConsent(s, CONSENT_DECLINED);
  assert.equal(getConsent(s), CONSENT_DECLINED);
});

test("getConsent: tampered/legacy values read as no-choice", () => {
  const s = memStorage();
  s.setItem(CONSENT_KEY, "yes please");
  assert.equal(getConsent(s), null);
});

test("getConsent: a throwing storage reads as no-choice", () => {
  const s = { getItem() { throw new Error("blocked"); } };
  assert.equal(getConsent(s), null);
});

test("setConsent: rejects anything but the two legal values", () => {
  const s = memStorage();
  assert.throws(() => setConsent(s, "maybe"), TypeError);
  assert.throws(() => setConsent(s, true), TypeError);
});

/* ---------------- sanitizeEvent ---------------- */

test("sanitizeEvent: unknown events are dropped entirely", () => {
  assert.equal(sanitizeEvent("made_up_event", { mode: "couch" }), null);
  assert.equal(sanitizeEvent("", {}), null);
});

test("sanitizeEvent: allowlisted, well-typed props pass through", () => {
  const out = sanitizeEvent("round_started", {
    room: "KWPFRT", mode: "couch", round_number: 3,
  });
  assert.deepEqual(out, {
    event: "round_started",
    props: { room: "KWPFRT", mode: "couch", round_number: 3 },
  });
});

test("sanitizeEvent: coordinates and identity-ish keys never pass", () => {
  const out = sanitizeEvent("guess_submitted", {
    room: "KWPFRT", mode: "h2h", team_id: "t2",
    distance_km: 812.34, time_bonus: 120, total_score: 3100,
    time_seconds: 23.7,
    lat: 48.85, lng: 2.35, latitude: 48.85, longitude: 2.35,
    guess: { lat: 1, lng: 2 }, pin: "x", team_name: "The Atlas Cats",
    deviceId: "d-123", email: "a@b.c",
  });
  assert.deepEqual(Object.keys(out.props).sort(), [
    "distance_km", "mode", "room", "team_id", "time_bonus",
    "time_seconds", "total_score",
  ]);
});

test("sanitizeEvent: no schema key may look location- or identity-shaped", () => {
  // Guards future schema edits: the banned-key patterns must never overlap
  // the allowlist, or legitimate properties would silently vanish.
  const banned = /lat|lng|lon|coord|pin|guess$|name|email|device|user/i;
  for (const [event, schema] of Object.entries(EVENT_SCHEMA)) {
    for (const key of Object.keys(schema)) {
      assert.ok(!banned.test(key), `${event}.${key} matches a banned pattern`);
    }
  }
});

test("sanitizeEvent: invite_shared keeps mode/method, strips everything else", () => {
  const out = sanitizeEvent("invite_shared", {
    mode: "h2h", method: "copy",
    url: "https://example.com/player.html?room=KWPFRT", // never sent
    room_code: "KWPFRT", team_name: "The Atlas Cats", lat: 1, lng: 2,
  });
  assert.deepEqual(out, {
    event: "invite_shared",
    props: { mode: "h2h", method: "copy" },
  });
});

test("sanitizeEvent: guess_submitted.super_sure is strictly boolean", () => {
  const base = { room: "KWPFRT", mode: "h2h", total_score: 3100 };
  assert.equal(
    sanitizeEvent("guess_submitted", { ...base, super_sure: true }).props.super_sure,
    true);
  assert.equal(
    sanitizeEvent("guess_submitted", { ...base, super_sure: false }).props.super_sure,
    false);
  // Truthy-but-not-boolean is stripped, never coerced.
  for (const bad of [1, 0, "true", "yes", null, {}]) {
    const out = sanitizeEvent("guess_submitted", { ...base, super_sure: bad });
    assert.ok(!("super_sure" in out.props), `coerced ${JSON.stringify(bad)}`);
  }
});

test("sanitizeEvent: super_sure_resolved keeps its aggregates, strips the rest", () => {
  const out = sanitizeEvent("super_sure_resolved", {
    mode: "h2h", round_number: 3, rounds: 5,
    outcome: "won", round_total: 4180.4,
    // None of these may ever leave the device:
    room_code: "KWPFRT", team_name: "The Atlas Cats", team_id: "t2",
    lat: 48.85, lng: 2.35, guess: { lat: 1, lng: 2 }, deviceId: "d-1",
  });
  assert.deepEqual(out, {
    event: "super_sure_resolved",
    props: {
      mode: "h2h", round_number: 3, rounds: 5,
      outcome: "won", round_total: 4180,
    },
  });
});

test("sanitizeEvent: wrong-typed props are stripped, not coerced", () => {
  const out = sanitizeEvent("game_created", {
    mode: 5, num_teams: "two", num_rounds: 5, round_seconds: 120,
  });
  assert.deepEqual(out.props, { num_rounds: 5, round_seconds: 120 });
});

test("sanitizeEvent: non-finite numbers are stripped", () => {
  const out = sanitizeEvent("guess_submitted", {
    distance_km: NaN, time_bonus: Infinity, total_score: 4200,
  });
  assert.deepEqual(out.props, { total_score: 4200 });
});

test("sanitizeEvent: ints round to integers, float1 to one decimal", () => {
  const out = sanitizeEvent("guess_submitted", {
    distance_km: 812.3456, time_seconds: 23.7777, total_score: 4200.6,
  });
  assert.equal(out.props.distance_km, 812.3);
  assert.equal(out.props.time_seconds, 23.8);
  assert.equal(out.props.total_score, 4201);
});

test("sanitizeEvent: overlong and empty strings are stripped", () => {
  const out = sanitizeEvent("screen_joined", {
    room: "X".repeat(41), mode: "",
  });
  assert.deepEqual(out.props, {});
});

test("sanitizeEvent: consent events carry no properties", () => {
  const out = sanitizeEvent("consent_given", { room: "KWPFRT", extra: 1 });
  assert.deepEqual(out, { event: "consent_given", props: {} });
});

test("sanitizeEvent: missing props object is fine", () => {
  assert.deepEqual(sanitizeEvent("next_game"), {
    event: "next_game", props: {},
  });
});

/* ---------------- gated tracker: opt-in is a hard gate ---------------- */

test("tracker: nothing loads and nothing captures before consent", async () => {
  const { a, loads, ph } = harness();
  assert.equal(a.track("round_started", { room: "ABCDEF", mode: "couch", round_number: 1 }), false);
  await a.init();
  await tick();
  assert.equal(loads.count, 0, "PostHog must not load without consent");
  assert.equal(ph.captured.length, 0);
});

test("tracker: decline means PostHog is never loaded", async () => {
  const { a, loads } = harness();
  a.decline();
  assert.equal(a.consentState(), CONSENT_DECLINED);
  assert.equal(a.track("next_game", { mode: "h2h" }), false);
  await a.init();
  await tick();
  assert.equal(loads.count, 0);
});

test("tracker: accept loads once with the verbatim key+options and records consent_given", async () => {
  const { a, loads, ph } = harness();
  await a.accept();
  await a.accept(); // idempotent
  assert.equal(loads.count, 1);
  assert.equal(loads.key, POSTHOG_PROJECT_KEY);
  assert.equal(loads.options, POSTHOG_INIT_OPTIONS);
  assert.equal(loads.options.api_host, "https://eu.i.posthog.com");
  assert.equal(loads.options.defaults, "2026-05-30");
  assert.equal(loads.options.person_profiles, "identified_only");
  assert.deepEqual(ph.captured.map((c) => c.event), ["consent_given", "consent_given"]);
});

// Regression: posthog.init() mutates the options object it receives (it sets
// defaults like `debug` onto it), so a frozen options object makes init throw
// "Cannot add property debug, object is not extensible" and analytics
// silently stays off. The init options — including the nested autocapture
// config, which posthog-js may also mutate — must stay extensible.
test("init options are mutable: posthog.init() writes onto them", () => {
  assert.equal(Object.isExtensible(POSTHOG_INIT_OPTIONS), true);
  assert.equal(Object.isFrozen(POSTHOG_INIT_OPTIONS), false);
  assert.equal(Object.isExtensible(POSTHOG_INIT_OPTIONS.autocapture), true);
  assert.equal(Object.isFrozen(POSTHOG_INIT_OPTIONS.autocapture), false);
  // Simulate the exact mutation posthog-js performs during _init.
  POSTHOG_INIT_OPTIONS.debug = false;
  assert.equal(POSTHOG_INIT_OPTIONS.debug, false);
  delete POSTHOG_INIT_OPTIONS.debug;
});

test("tracker: events queued while the script loads flush in order", async () => {
  const storage = memStorage();
  const ph = fakePosthog();
  let release;
  const gate = new Promise((r) => { release = r; });
  const a = createAnalytics({ storage, loadPosthog: () => gate.then(() => ph) });
  setConsent(storage, CONSENT_ACCEPTED); // prior session opted in
  a.init();
  assert.equal(a.track("round_started", { room: "ABCDEF", mode: "couch", round_number: 1 }), true);
  assert.equal(a.track("reveal_shown", { room: "ABCDEF", mode: "couch", round_number: 1 }), true);
  assert.equal(ph.captured.length, 0, "not delivered before the script lands");
  release();
  await tick();
  assert.deepEqual(ph.captured.map((c) => c.event), ["round_started", "reveal_shown"]);
});

test("tracker: after load, capture is immediate and sanitized", async () => {
  const { a, ph } = harness();
  await a.accept();
  a.track("guess_submitted", {
    room: "ABCDEF", mode: "couch", team_id: "t1",
    distance_km: 12.3456, time_bonus: 300, total_score: 5100,
    time_seconds: 14.2, lat: 4, lng: 5,
  });
  const last = ph.captured.at(-1);
  assert.equal(last.event, "guess_submitted");
  assert.equal(last.props.distance_km, 12.3);
  assert.ok(!("lat" in last.props) && !("lng" in last.props));
});

test("tracker: unknown events are rejected even with consent", async () => {
  const { a, ph } = harness();
  await a.accept();
  assert.equal(a.track("totally_new_event", {}), false);
  assert.deepEqual(ph.captured.map((c) => c.event), ["consent_given"]);
});

test("tracker: init resumes a prior session's acceptance without re-consent", async () => {
  const storage = memStorage();
  setConsent(storage, CONSENT_ACCEPTED);
  const ph = fakePosthog();
  let count = 0;
  const a = createAnalytics({
    storage, loadPosthog: () => { count++; return Promise.resolve(ph); },
  });
  await a.init();
  assert.equal(count, 1);
  assert.equal(a.hasConsent(), true);
});

test("tracker: revoke sends one final consent_denied, then opts out and stops", async () => {
  const { a, ph } = harness();
  await a.accept();
  a.decline();
  assert.equal(ph.captured.at(-1).event, "consent_denied");
  assert.equal(ph.optedOut, true);
  assert.equal(a.track("next_game", { mode: "couch" }), false);
  assert.equal(ph.captured.at(-1).event, "consent_denied", "nothing after the revoke");
});

test("tracker: re-accept after a revoke opts back in and resumes", async () => {
  const { a, ph, loads } = harness();
  await a.accept();
  a.decline();
  await a.accept();
  assert.equal(loads.count, 1, "script is only ever loaded once");
  assert.equal(ph.optedOut, false);
  assert.equal(a.track("next_game", { mode: "couch" }), true);
  assert.equal(ph.captured.at(-1).event, "next_game");
});

test("tracker: revoke while the script is in flight drops the queue", async () => {
  const storage = memStorage();
  const ph = fakePosthog();
  let release;
  const gate = new Promise((r) => { release = r; });
  const a = createAnalytics({ storage, loadPosthog: () => gate.then(() => ph) });
  setConsent(storage, CONSENT_ACCEPTED);
  a.init();
  a.track("round_started", { room: "ABCDEF", mode: "couch", round_number: 1 });
  a.decline(); // changed their mind before the script landed
  release();
  await tick();
  assert.equal(ph.captured.length, 0, "buffered events must not flush");
  assert.equal(ph.optedOut, true);
});

test("tracker: a failed script load degrades silently", async () => {
  const storage = memStorage();
  const a = createAnalytics({
    storage, loadPosthog: () => Promise.reject(new Error("blocked")),
  });
  await a.accept(); // must not throw
  assert.equal(a.track("next_game", { mode: "couch" }), true, "gate still open; delivery is best-effort");
});
