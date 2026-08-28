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
  EXCEPTION_PROPS,
  RELEASE_PROPS,
  NETWORK_HOST_ALLOWLIST,
  getConsent,
  setConsent,
  sanitizeEvent,
  sanitizeProps,
  sanitizeBeforeSend,
  maskNetworkRequest,
  makeImageryError,
  oneShotInitOptions,
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
    exceptions: [],
    superProps: null,
    recordings: 0,
    optedOut: false,
    capture(event, props) { this.captured.push({ event, props }); },
    captureException(error, props) { this.exceptions.push({ error, props }); },
    register(props) { this.superProps = { ...(this.superProps || {}), ...props }; },
    startSessionRecording() { this.recordings++; },
    opt_out_capturing() { this.optedOut = true; },
    opt_in_capturing() { this.optedOut = false; },
  };
}

// A posthog-like sink that snapshots the super properties in effect at the
// instant each event is captured — the way to prove ORDERING: a schema event
// must never flush before the registered super properties have been applied.
function orderingFake() {
  return {
    captured: [],
    superProps: null,
    optedOut: false,
    capture(event, props) {
      this.captured.push({
        event, props,
        superAtCapture: this.superProps ? { ...this.superProps } : null,
      });
    },
    register(props) { this.superProps = { ...(this.superProps || {}), ...props }; },
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

test("sanitizeEvent: round_started carries the S6 advance mode, optionally", () => {
  // "auto" | "manual" enriches the between-round-tempo KPI; round 1 has no
  // preceding reveal, so the key is simply absent there — never null/"".
  const auto = sanitizeEvent("round_started", {
    room: "KWPFRT", mode: "h2h", round_number: 2, advance: "auto",
  });
  assert.deepEqual(auto.props, {
    room: "KWPFRT", mode: "h2h", round_number: 2, advance: "auto",
  });
  const first = sanitizeEvent("round_started", {
    room: "KWPFRT", mode: "h2h", round_number: 1,
  });
  assert.deepEqual(first.props, {
    room: "KWPFRT", mode: "h2h", round_number: 1,
  });
});

test("sanitizeEvent: round_started.screen_attached is strictly boolean (S7)", () => {
  // The couch-without-a-TV KPI: false is a real, meaningful value (a game
  // being played with no screen), so it must pass — and nothing truthy-ish
  // may coerce into it.
  const noTv = sanitizeEvent("round_started", {
    room: "KWPFRT", mode: "couch", round_number: 1, screen_attached: false,
  });
  assert.deepEqual(noTv.props, {
    room: "KWPFRT", mode: "couch", round_number: 1, screen_attached: false,
  });
  const junk = sanitizeEvent("round_started", {
    room: "KWPFRT", mode: "couch", round_number: 1, screen_attached: "yes",
  });
  assert.ok(!("screen_attached" in junk.props));
});

test("sanitizeEvent: auto_advance_hold keeps aggregates, strips the rest", () => {
  const out = sanitizeEvent("auto_advance_hold", {
    room: "KWPFRT", mode: "couch", round_number: 3, seconds_left: 8.9,
    team_name: "The Atlas Cats", lat: 1, lng: 2, deadline: "soon",
  });
  assert.deepEqual(out, {
    event: "auto_advance_hold",
    props: { room: "KWPFRT", mode: "couch", round_number: 3, seconds_left: 9 },
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

test("sanitizeEvent: tv_link_shared keeps mode/method, strips the link", () => {
  // The Add a TV affordance: which path was used, never the URL itself.
  const out = sanitizeEvent("tv_link_shared", {
    mode: "couch", method: "share",
    url: "https://example.com/tv.html?room=KWPFRT", // never sent
    room_code: "KWPFRT",
  });
  assert.deepEqual(out, {
    event: "tv_link_shared",
    props: { mode: "couch", method: "share" },
  });
});

test("sanitizeEvent: screen_joined carries the attribution via, nothing extra", () => {
  const out = sanitizeEvent("screen_joined", {
    room: "KWPFRT", mode: "h2h", via: "qr",
    url: "https://example.com/tv.html?room=KWPFRT&via=qr", // never sent
  });
  assert.deepEqual(out, {
    event: "screen_joined",
    props: { room: "KWPFRT", mode: "h2h", via: "qr" },
  });
});

test("sanitizeEvent: result_shared keeps mode/method, strips the card itself", () => {
  // S1: the share card's TEXT (place names!) and link must never ride on
  // the event — only which card and which sharing path.
  const out = sanitizeEvent("result_shared", {
    mode: "daily", method: "copy",
    text: "GeoParty 🌍 We were 3 km from Kyoto…", // never sent
    url: "https://example.com/?utm_source=share", place_name: "Kyoto",
  });
  assert.deepEqual(out, {
    event: "result_shared",
    props: { mode: "daily", method: "copy" },
  });
});

test("sanitizeEvent: daily events carry aggregates only", () => {
  // S2: the run is a date-number and scores — coordinates or place labels
  // aimed at these events are stripped by the allowlist.
  const started = sanitizeEvent("daily_challenge_started", {
    day_number: 37, date: "2026-08-19", device: "d-123",
  });
  assert.deepEqual(started, {
    event: "daily_challenge_started",
    props: { day_number: 37 },
  });
  const done = sanitizeEvent("daily_challenge_completed", {
    day_number: 37, score: 18420.4, rounds_played: 4,
    best_distance_km: 3.14159,
    lat: 35, lng: 135, place_name: "Kyoto, Japan",
  });
  assert.deepEqual(done, {
    event: "daily_challenge_completed",
    props: {
      day_number: 37, score: 18420, rounds_played: 4, best_distance_km: 3.1,
    },
  });
});

test("sanitizeEvent: an all-forfeit daily drops the null best distance", () => {
  const done = sanitizeEvent("daily_challenge_completed", {
    day_number: 2, score: 0, rounds_played: 0, best_distance_km: null,
  });
  assert.deepEqual(done.props, { day_number: 2, score: 0, rounds_played: 0 });
});

/* ---------------- G1–G8 event extensions (spec §7.1) ---------------- */

test("sanitizeEvent: daily events carry the G1/G5/G6 flags, aggregates only", () => {
  const started = sanitizeEvent("daily_challenge_started", {
    day_number: 37, hard: true, vs_ghost: true, streak: 12,
  });
  assert.deepEqual(started.props,
    { day_number: 37, hard: true, vs_ghost: true, streak: 12 });
  const done = sanitizeEvent("daily_challenge_completed", {
    day_number: 37, score: 18420, rounds_played: 5, best_distance_km: 0.4,
    hard: false, vs_ghost: true, streak: 12, pb: true, aces: 2,
  });
  assert.deepEqual(done.props, {
    day_number: 37, score: 18420, rounds_played: 5, best_distance_km: 0.4,
    hard: false, vs_ghost: true, streak: 12, pb: true, aces: 2,
  });
});

test("sanitizeEvent: ghost_duel_completed — outcome + margin, no payload byte", () => {
  const out = sanitizeEvent("ghost_duel_completed", {
    day_number: 37, outcome: "won", margin: 1840, hard: false,
    // None of these may ever ride a ghost event:
    lat: 48.8, lng: 2.3, ghost_payload: "AAAA", team_name: "Cats",
  });
  assert.deepEqual(out.props,
    { day_number: 37, outcome: "won", margin: 1840, hard: false });
});

test("sanitizeEvent: ghost_link_invalid carries only the reason", () => {
  const out = sanitizeEvent("ghost_link_invalid", { reason: "malformed", url: "x#g=Y" });
  assert.deepEqual(out.props, { reason: "malformed" });
});

test("sanitizeEvent: daily_recap_engaged — aggregates only, no place/coordinate", () => {
  const out = sanitizeEvent("daily_recap_engaged", {
    day_number: 37, source: "swipe", vs_ghost: true, hard: false,
    // None of these may ever ride the recap event:
    lat: 35.01, lng: 135.77, place_name: "Kyoto, Japan", pin: "x", guess: { lat: 1 },
  });
  assert.deepEqual(out.props,
    { day_number: 37, source: "swipe", vs_ghost: true, hard: false });
  // Flags strictly boolean across boards.
  const swipe = sanitizeEvent("daily_recap_engaged", {
    day_number: 2, source: "swipe", vs_ghost: false, hard: true,
  });
  assert.deepEqual(swipe.props,
    { day_number: 2, source: "swipe", vs_ghost: false, hard: true });
});

test("sanitizeEvent: party_recap_engaged — aggregates only, no place/coordinate/team", () => {
  const out = sanitizeEvent("party_recap_engaged", {
    room: "ABCDEF", mode: "h2h", surface: "player", rounds_shown: 5, source: "swipe",
    // None of these may ever ride the recap event:
    lat: 35.01, lng: 135.77, place_name: "Kyoto, Japan", team: "Cats", winner_team: "t2",
  });
  assert.deepEqual(out.props,
    { room: "ABCDEF", mode: "h2h", surface: "player", rounds_shown: 5, source: "swipe" });
  // rounds_shown is a strict int; the host surface carries the same shape.
  const host = sanitizeEvent("party_recap_engaged", {
    room: "ZZZZZZ", mode: "couch", surface: "host", rounds_shown: 3.9, source: "swipe",
  });
  assert.deepEqual(host.props,
    { room: "ZZZZZZ", mode: "couch", surface: "host", rounds_shown: 4, source: "swipe" });
});

test("sanitizeEvent: night_champion — mode + games", () => {
  const out = sanitizeEvent("night_champion", { mode: "h2h", games: 4, winner_name: "Cats" });
  assert.deepEqual(out.props, { mode: "h2h", games: 4 });
});

test("sanitizeEvent: result_shared.challenge is strictly boolean", () => {
  const out = sanitizeEvent("result_shared", { mode: "daily", method: "share", challenge: true });
  assert.deepEqual(out.props, { mode: "daily", method: "share", challenge: true });
  assert.ok(!("challenge" in
    sanitizeEvent("result_shared", { mode: "daily", method: "share", challenge: "yes" }).props));
});

test("sanitizeEvent: round_started/guess_submitted twist + decoy are aggregates", () => {
  const rs = sanitizeEvent("round_started", {
    room: "KWPFRT", mode: "h2h", round_number: 3, twist: "blitz",
  });
  assert.equal(rs.props.twist, "blitz");
  const gs = sanitizeEvent("guess_submitted", {
    room: "KWPFRT", mode: "h2h", team_id: "t1", total_score: 3100,
    round_number: 3, twist: "longhaul", decoy: true,
  });
  assert.equal(gs.props.round_number, 3);
  assert.equal(gs.props.twist, "longhaul");
  assert.equal(gs.props.decoy, true);
  // A non-boolean decoy is stripped, never coerced.
  assert.ok(!("decoy" in sanitizeEvent("guess_submitted",
    { room: "R", mode: "h2h", decoy: 1 }).props));
});

test("sanitizeBeforeSend: a ghost #g= fragment leaves zero payload bytes (§3.5.6)", () => {
  // The third, alarm layer of the ghost privacy defense: even if a challenge
  // URL reached a $current_url-class property, no payload survives.
  const payload = "AbCd-_1234567890xyzQWERTYuiopASDFghjklZXCVbnm";
  const ev = sanitizeBeforeSend({
    event: "$pageview",
    properties: {
      $current_url: `https://geoparty.example/daily.html?utm_source=share#g=${payload}`,
      $pathname: "/daily.html",
      $session_entry_url: `https://geoparty.example/daily.html#g=${payload}`,
    },
  });
  for (const key of ["$current_url", "$pathname", "$session_entry_url"]) {
    assert.ok(!ev.properties[key].includes(payload),
      `${key} leaked ghost payload`);
    assert.ok(!ev.properties[key].includes("g="),
      `${key} kept the fragment`);
  }
  assert.equal(ev.properties.$current_url, "https://geoparty.example/daily.html");
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

test("sanitizeEvent: guess_submitted.moved is strictly boolean, ids never ride", () => {
  const base = { room: "KWPFRT", mode: "h2h", total_score: 3100 };
  assert.equal(
    sanitizeEvent("guess_submitted", { ...base, moved: true }).props.moved, true);
  assert.equal(
    sanitizeEvent("guess_submitted", { ...base, moved: false }).props.moved, false);
  // Not a boolean → stripped, never coerced.
  for (const bad of [1, "img-123", null]) {
    const out = sanitizeEvent("guess_submitted", { ...base, moved: bad });
    assert.ok(!("moved" in out.props), `coerced ${JSON.stringify(bad)}`);
  }
  // The image ids the flag is computed from must never be sendable.
  const out = sanitizeEvent("guess_submitted", {
    ...base, moved: true, image_id: "abc", anchored_image_id: "def",
  });
  assert.ok(!("image_id" in out.props));
  assert.ok(!("anchored_image_id" in out.props));
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

test("sanitizeEvent: super_sure_sheet_opened was removed (superseded by modifier_sheet_opened)", () => {
  // The guess-modifier redesign (docs/guess-modifier-design.md §5.1) replaced
  // the SUPER-only event with a per-modifier funnel. The old name is gone from
  // the schema, so it drops entirely — historical data stays in PostHog.
  assert.equal(sanitizeEvent("super_sure_sheet_opened", { mode: "h2h" }), null);
});

test("sanitizeEvent: modifier_callout_shown carries only aggregates", () => {
  const out = sanitizeEvent("modifier_callout_shown", {
    mode: "h2h", modifier: "super", round_number: 3,
    // None of these may ever ride — the callout fires while aiming.
    room: "KWPFRT", team_id: "t2", team_name: "The Atlas Cats",
    lat: 48.85, lng: 2.35, guess: { lat: 1, lng: 2 }, pin: { lat: 1, lng: 2 },
  });
  assert.deepEqual(out, {
    event: "modifier_callout_shown",
    props: { mode: "h2h", modifier: "super", round_number: 3 },
  });
});

test("sanitizeEvent: modifier_sheet_opened carries mode/modifier/via, strips the rest", () => {
  const out = sanitizeEvent("modifier_sheet_opened", {
    mode: "h2h", modifier: "decoy", via: "callout",
    room: "KWPFRT", team_name: "The Atlas Cats", distance_km: 812,
    lat: 1, lng: 2, guess: { lat: 1, lng: 2 },
  });
  assert.deepEqual(out, {
    event: "modifier_sheet_opened",
    props: { mode: "h2h", modifier: "decoy", via: "callout" },
  });
});

test("sanitizeEvent: decoy_planted keeps its aggregates, strips a smuggled coordinate", () => {
  const out = sanitizeEvent("decoy_planted", {
    mode: "h2h", round_number: 4, rounds: 5,
    // The decoy's own coordinates must never leave the device (BANNED_KEY_RE
    // strips "decoy_lat"/"lat"/"lng" before the allowlist is even consulted).
    decoy_lat: 48.85, lat: 48.85, lng: 2.35, team_name: "The Atlas Cats",
  });
  assert.deepEqual(out, {
    event: "decoy_planted",
    props: { mode: "h2h", round_number: 4, rounds: 5 },
  });
});

test("sanitizeEvent: modifier_sheet_opened drops a non-string via", () => {
  for (const bad of [1, null, undefined, true, { via: "chip" }]) {
    const out = sanitizeEvent("modifier_sheet_opened", { mode: "h2h", via: bad });
    assert.ok(!("via" in out.props), `coerced ${JSON.stringify(bad)}`);
  }
});

test("sanitizeEvent: party_choice keeps only the chooser value", () => {
  const out = sanitizeEvent("party_choice", {
    choice: "phones",
    // Nothing else may ride along from the landing:
    room_code: "KWPFRT", team_name: "The Atlas Cats", lat: 1, lng: 2,
    url: "https://example.com/?room=KWPFRT",
  });
  assert.deepEqual(out, { event: "party_choice", props: { choice: "phones" } });
});

test("sanitizeEvent: front_door_join keeps only the routed mode", () => {
  const out = sanitizeEvent("front_door_join", {
    mode: "couch",
    room: "KWPFRT", code: "KWPFRT", lat: 48.85, lng: 2.35, deviceId: "d-1",
  });
  assert.deepEqual(out, { event: "front_door_join", props: { mode: "couch" } });
});

test("sanitizeEvent: game_created carries the difficulty pick, nothing extra", () => {
  // S3: difficulty is the host's pool setting (a fixed enum string) and
  // room is the join key for the tier KPI. Team names and coordinates must
  // never ride along.
  const out = sanitizeEvent("game_created", {
    room: "KWPFRT", mode: "couch", num_teams: 2, num_rounds: 5,
    round_seconds: 120, difficulty: "expert",
    team_name: "The Atlas Cats", lat: 48.85, lng: 2.35,
  });
  assert.deepEqual(out.props, {
    room: "KWPFRT", mode: "couch", num_teams: 2, num_rounds: 5,
    round_seconds: 120, difficulty: "expert",
  });
  // A non-string difficulty is stripped, not coerced.
  assert.deepEqual(sanitizeEvent("game_created", { difficulty: 3 }).props, {});
});

test("sanitizeEvent: game_created.auto_submit is a strict bool (#2)", () => {
  const base = { room: "KWPFRT", mode: "h2h" };
  assert.equal(
    sanitizeEvent("game_created", { ...base, auto_submit: true }).props.auto_submit,
    true);
  assert.equal(
    sanitizeEvent("game_created", { ...base, auto_submit: false }).props.auto_submit,
    false);
  // Anything non-boolean is stripped, never coerced.
  for (const bad of [1, 0, "true", "1", null, undefined, {}]) {
    const out = sanitizeEvent("game_created", { ...base, auto_submit: bad });
    assert.ok(!("auto_submit" in out.props), `coerced ${JSON.stringify(bad)}`);
  }
});

test("sanitizeEvent: reveal_shown.forfeits is an aggregate int, nothing else (#2)", () => {
  const out = sanitizeEvent("reveal_shown", {
    room: "KWPFRT", mode: "h2h", round_number: 3, forfeits: 2,
    team_name: "Losers", lat: 1.2, lng: 3.4,
  });
  assert.deepEqual(out.props, {
    room: "KWPFRT", mode: "h2h", round_number: 3, forfeits: 2,
  });
  // Rounded to an int; non-finite stripped.
  assert.equal(sanitizeEvent("reveal_shown", { forfeits: 1.9 }).props.forfeits, 2);
  assert.ok(!("forfeits" in sanitizeEvent("reveal_shown", { forfeits: NaN }).props));
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

test("sanitizeEvent: pwa_launch carries no properties — the launch is the signal", () => {
  // S5: nothing identifying may ride along on an install-launch event.
  const out = sanitizeEvent("pwa_launch", {
    display: "standalone", device: "d-123", user_agent: "Mozilla/5.0",
  });
  assert.deepEqual(out, { event: "pwa_launch", props: {} });
});

test("sanitizeEvent: sound_toggled keeps surface + strictly-boolean enabled", () => {
  // S4: which surface the 🔊/🔇 toggle was tapped on, nothing else.
  const out = sanitizeEvent("sound_toggled", {
    surface: "tv", enabled: false,
    room: "KWPFRT", team_name: "The Atlas Cats", lat: 1, lng: 2,
  });
  assert.deepEqual(out, {
    event: "sound_toggled",
    props: { surface: "tv", enabled: false },
  });
  // Truthy-but-not-boolean is stripped, never coerced.
  for (const bad of [1, 0, "true", null]) {
    const o = sanitizeEvent("sound_toggled", { surface: "player", enabled: bad });
    assert.ok(!("enabled" in o.props), `coerced ${JSON.stringify(bad)}`);
  }
});

test("sanitizeEvent: howto_opened keeps only the source enum (§6)", () => {
  const out = sanitizeEvent("howto_opened", {
    source: "footer", room: "KWPFRT", team_name: "The Atlas Cats", lat: 1,
  });
  assert.deepEqual(out, { event: "howto_opened", props: { source: "footer" } });
  const out2 = sanitizeEvent("howto_opened", { source: "gameover" });
  assert.deepEqual(out2.props, { source: "gameover" });
});

test("sanitizeEvent: team_name_used keeps mode/source, never the team name text", () => {
  const out = sanitizeEvent("team_name_used", {
    mode: "couch", source: "pun",
    name: "The Atlas Cats", team_name: "The Atlas Cats", // never sent
  });
  assert.deepEqual(out, {
    event: "team_name_used",
    props: { mode: "couch", source: "pun" },
  });
});

test("sanitizeEvent: team_name_used also covers the h2h joiner, never the team name text", () => {
  const out = sanitizeEvent("team_name_used", {
    mode: "h2h", source: "recent",
    name: "The Atlas Cats", team_name: "The Atlas Cats", // never sent
  });
  assert.deepEqual(out, {
    event: "team_name_used",
    props: { mode: "h2h", source: "recent" },
  });
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

// Regression (accept→revoke privacy race): the user taps Accept — which sets
// the stored flag ACCEPTED and starts the PostHog load — then declines/revokes
// BEFORE the script resolves. The accept() completion handler fires late, on a
// now-loaded posthog, and MUST NOT re-opt-in or capture consent_given: the
// decline has to win. ensureLoaded() already drops the queue and opts out; the
// bug was accept()'s late handler undoing that.
test("tracker: decline before the accept load resolves — no opt-in, no consent_given", async () => {
  const storage = memStorage();
  const ph = fakePosthog();
  let release;
  const gate = new Promise((r) => { release = r; });
  const a = createAnalytics({ storage, loadPosthog: () => gate.then(() => ph) });

  const accepted = a.accept();       // sets ACCEPTED, load in flight
  a.decline();                       // revoke before the script lands
  assert.equal(a.consentState(), CONSENT_DECLINED, "decline persists immediately");
  release();
  await accepted;                    // let accept()'s late handler run
  await tick();

  assert.equal(ph.optedOut, true, "the raced session is opted OUT, not in");
  assert.deepEqual(ph.captured.map((c) => c.event), [],
    "consent_given must not be captured for a revoked acceptance");
  // And the decline stays authoritative for subsequent capture attempts.
  assert.equal(a.track("next_game", { mode: "couch" }), false);
});

// The same race but with a product event queued before the decline: the queue
// must be dropped and no consent_denied/consent_given may slip through (decline
// found posthog still null, so it recorded nothing — the privacy-safe outcome).
test("tracker: decline before load resolves also drops queued events", async () => {
  const storage = memStorage();
  const ph = fakePosthog();
  let release;
  const gate = new Promise((r) => { release = r; });
  const a = createAnalytics({ storage, loadPosthog: () => gate.then(() => ph) });

  const accepted = a.accept();
  assert.equal(a.track("game_created", { room: "ABCDEF", mode: "couch" }), true,
    "queued while the gate is (transiently) open");
  a.decline();
  release();
  await accepted;
  await tick();

  assert.equal(ph.captured.length, 0, "no queued event, and no consent_given, survives the revoke");
  assert.equal(ph.optedOut, true);
});

// Guardrail: the fix must not regress the happy path — a fresh accept with no
// revoke still loads, opts in, and captures consent_given exactly once, with
// any synchronously-registered super property already applied (ordering).
test("tracker: uninterrupted fresh accept still captures consent_given after super props are registered", async () => {
  const storage = memStorage();
  const ph = orderingFake();
  let release;
  const gate = new Promise((r) => { release = r; });
  const a = createAnalytics({ storage, loadPosthog: () => gate.then(() => ph) });

  const accepted = a.accept();
  a.register({ release: "abc1234" }); // a synchronous super-property register
  release();
  await accepted;
  await tick();

  assert.equal(ph.optedOut, false, "a genuine acceptance is opted IN");
  const given = ph.captured.filter((c) => c.event === "consent_given");
  assert.equal(given.length, 1, "consent_given fires exactly once");
  assert.equal(given[0].superAtCapture?.release, "abc1234",
    "consent_given must flush AFTER registered super properties are applied");
});

test("tracker: a failed script load degrades silently", async () => {
  const storage = memStorage();
  const a = createAnalytics({
    storage, loadPosthog: () => Promise.reject(new Error("blocked")),
  });
  await a.accept(); // must not throw
  assert.equal(a.track("next_game", { mode: "couch" }), true, "gate still open; delivery is best-effort");
});

/* ================================================================
 * Field observability (docs/field-observability-plan.md)
 * ================================================================ */

test("sanitizeEvent: viewer_init carries construction facts only", () => {
  const out = sanitizeEvent("viewer_init", {
    surface: "host", ok: false, error_class: "webgl_unavailable",
    duration_ms: 12.6, webgl: false, sdk: "4.1.2",
    container: "hostViewer", stack: "at makeViewer (host-ui.js:391)",
  });
  assert.deepEqual(out.props, {
    surface: "host", ok: false, error_class: "webgl_unavailable",
    duration_ms: 13, webgl: false, sdk: "4.1.2",
  });
});

test("sanitizeEvent: imagery_load carries aggregates and the opaque entry id", () => {
  const out = sanitizeEvent("imagery_load", {
    surface: "player", purpose: "anchor", ok: false, after_timeout: true,
    error_class: "network_timeout", duration_ms: 20001, skips: 2,
    pool_entry: "k3x9q0ar", net_type: "3g", online: true,
    // None of these may survive: a raw id, a place, coordinates, a message.
    image_id: "1263588815098567", lat: 51.5, lng: -0.12,
    place_name: "Camden", message: "GET https://graph.mapillary.com/x?access_token=Y",
    exhausted: true,
  });
  assert.deepEqual(out.props, {
    surface: "player", purpose: "anchor", ok: false, after_timeout: true,
    error_class: "network_timeout", duration_ms: 20001, skips: 2,
    pool_entry: "k3x9q0ar", net_type: "3g", online: true,
  });
});

test("sanitizeEvent: imagery_load.pool_entry is never a raw Mapillary id", () => {
  // 16-digit ids are 16 chars, well under STRING_MAX — only the call site's
  // discipline (poolDiagId) keeps them out, so this documents the contract:
  // an 8-char base36 diag id is what the schema is sized and named for.
  const out = sanitizeEvent("imagery_load", { pool_entry: "k3x9q0ar" });
  assert.match(out.props.pool_entry, /^[0-9a-z]{8}$/);
});

test("sanitizeEvent: pano_session keeps the interaction fold, nothing else", () => {
  const out = sanitizeEvent("pano_session", {
    surface: "player", round_number: 3, looks: 12, zoom_changes: 2,
    nav_moves: 4, nav_failures: 1, nav_available: true, reanchors: 0,
    anchor_spatial_edges: 4, anchor_sequence_edges: 2,
    first_move_ms: 1840, pointer_downs: 7,
    team_name: "The Wanderers", image_id: "1263588815098567",
  });
  assert.deepEqual(out.props, {
    surface: "player", round_number: 3, looks: 12, zoom_changes: 2,
    nav_moves: 4, nav_failures: 1, nav_available: true, reanchors: 0,
    anchor_spatial_edges: 4, anchor_sequence_edges: 2,
    first_move_ms: 1840, pointer_downs: 7,
  });
});

test("sanitizeEvent: pano_session edge counts are ints; a known 0 survives (#2)", () => {
  // A genuine cached-zero edge count is signal ("this anchor had no arrows"),
  // so it must NOT be stripped; the caller omits only the UNKNOWN case.
  const zero = sanitizeEvent("pano_session", {
    surface: "player", round_number: 1, anchor_spatial_edges: 0,
    anchor_sequence_edges: 0,
  });
  assert.equal(zero.props.anchor_spatial_edges, 0);
  assert.equal(zero.props.anchor_sequence_edges, 0);
  // A non-numeric edge count never survives to become a fake aggregate.
  const junk = sanitizeEvent("pano_session", {
    surface: "player", round_number: 1, anchor_spatial_edges: "lots",
  });
  assert.ok(!("anchor_spatial_edges" in junk.props));
});

test("sanitizeEvent: pano_session.edge_recoveries survives as an int (issue #2 Phase 2)", () => {
  const out = sanitizeEvent("pano_session", {
    surface: "host", round_number: 2, edge_recoveries: 2,
  });
  assert.equal(out.props.edge_recoveries, 2);
  const junk = sanitizeEvent("pano_session", {
    surface: "host", round_number: 2, edge_recoveries: "two",
  });
  assert.ok(!("edge_recoveries" in junk.props));
});

test("sanitizeEvent: edge_recovery round-trips its full aggregate shape (issue #2 Phase 2)", () => {
  const out = sanitizeEvent("edge_recovery", {
    surface: "host", round_number: 4, attempt: 2, trigger: "zero",
    result: "recovered", spatial_after: 4, sequence_after: 2,
    duration_ms: 2510, net_type: "4g", online: true,
    team_name: "The Wanderers", image_id: "1263588815098567",
  });
  assert.deepEqual(out.props, {
    surface: "host", round_number: 4, attempt: 2, trigger: "zero",
    result: "recovered", spatial_after: 4, sequence_after: 2,
    duration_ms: 2510, net_type: "4g", online: true,
  });
});

test("sanitizeEvent: edge_recovery drops unknown/malformed props, keeps a real 0", () => {
  // spatial_after: 0 is a real, reportable outcome (attempt 1's cached-zero,
  // or a still-stuck recovery) — must not be stripped like an unknown value.
  const zero = sanitizeEvent("edge_recovery", {
    surface: "host", round_number: 1, attempt: 1, trigger: "uncached",
    result: "no_change", spatial_after: 0,
  });
  assert.equal(zero.props.spatial_after, 0);
  const junk = sanitizeEvent("edge_recovery", {
    surface: "host", round_number: 1, attempt: 1, trigger: "uncached",
    result: "no_change", spatial_after: "none",
  });
  assert.ok(!("spatial_after" in junk.props));
});

/* ---- §18 render-death probe (docs/ios-blackout-review.md) ---- */

test("sanitizeEvent: pano_session.render_dead / .partial are strict bools, absent-when-false", () => {
  const flagged = sanitizeEvent("pano_session", {
    surface: "daily", round_number: 3, render_dead: true, partial: true,
  });
  assert.equal(flagged.props.render_dead, true);
  assert.equal(flagged.props.partial, true);
  // Non-boolean junk is stripped, never coerced.
  const junk = sanitizeEvent("pano_session", {
    surface: "daily", round_number: 3, render_dead: "yes", partial: 1,
  });
  assert.ok(!("render_dead" in junk.props));
  assert.ok(!("partial" in junk.props));
});

test("sanitizeEvent: render_probe round-trips its aggregate shape, strips coordinate junk", () => {
  const out = sanitizeEvent("render_probe", {
    surface: "daily", round_number: 3, verdict: "dead", ctx_lost: true,
    canary_ok: false, sample: "blank", since_load_ms: 1500,
    net_type: "4g", online: true,
    // coordinate-shaped and identity junk must never survive.
    lat: 48.85, lng: 2.35, guess: { lat: 1 }, team_name: "The Atlas Cats",
    image_id: "1263588815098567",
  });
  assert.deepEqual(out.props, {
    surface: "daily", round_number: 3, verdict: "dead", ctx_lost: true,
    canary_ok: false, sample: "blank", since_load_ms: 1500,
    net_type: "4g", online: true,
  });
});

test("sanitizeEvent: render_probe drops absent optional signals (ctx_lost/canary_ok)", () => {
  // A "suspect" verdict whose canary never ran and whose ctxLost was unreadable
  // omits both — the schema keeps only strictly-boolean values.
  const out = sanitizeEvent("render_probe", {
    surface: "daily", round_number: 2, verdict: "suspect", sample: "unreadable",
    since_load_ms: 5000, net_type: "3g", online: true,
  });
  assert.ok(!("ctx_lost" in out.props));
  assert.ok(!("canary_ok" in out.props));
  assert.equal(out.props.verdict, "suspect");
});

test("sanitizeEvent: render_recovery round-trips, strips a smuggled coordinate", () => {
  const out = sanitizeEvent("render_recovery", {
    surface: "daily", round_number: 3, attempt: 1, trigger: "context_lost",
    result: "recovered", duration_ms: 2100, net_type: "4g", online: true,
    lat: 48.85, lng: 2.35, guess: "x", device: "iphone", image_id: "1263588815098567",
  });
  assert.deepEqual(out.props, {
    surface: "daily", round_number: 3, attempt: 1, trigger: "context_lost",
    result: "recovered", duration_ms: 2100, net_type: "4g", online: true,
  });
});

test("sanitizeEvent: imagery_report carries the ref code and the consent path", () => {
  const out = sanitizeEvent("imagery_report", {
    surface: "player", ref_code: "GP-4K7QX2", error_class: "image_dead",
    pool_entry: "k3x9q0ar", net_type: "4g", online: true, recent_failures: 3,
    consent: "one_time", note: "the picture never showed up", lat: 1,
  });
  assert.deepEqual(out.props, {
    surface: "player", ref_code: "GP-4K7QX2", error_class: "image_dead",
    pool_entry: "k3x9q0ar", net_type: "4g", online: true, recent_failures: 3,
    consent: "one_time",
  });
});

test("EXCEPTION_PROPS: the allowlist holds no location- or identity-ish key", () => {
  const banned = /lat|lng|lon|coord|pin|guess$|name|email|device|user/i;
  for (const key of Object.keys(EXCEPTION_PROPS)) {
    assert.ok(!banned.test(key), `EXCEPTION_PROPS.${key}`);
  }
  for (const key of Object.keys(RELEASE_PROPS)) {
    assert.ok(!banned.test(key), `RELEASE_PROPS.${key}`);
  }
});

test("sanitizeProps: exception props are allowlisted exactly like events", () => {
  const out = sanitizeProps(EXCEPTION_PROPS, {
    surface: "host", purpose: "anchor", error_class: "image_dead",
    pool_entry: "k3x9q0ar", duration_ms: 511.4, skips: 1, net_type: "4g",
    online: true, webgl: true, ref_code: "GP-4K7QX2",
    message: "raw SDK text", image_id: "1263588815098567", lat: 51.5,
  });
  assert.deepEqual(out, {
    surface: "host", purpose: "anchor", error_class: "image_dead",
    pool_entry: "k3x9q0ar", duration_ms: 511, skips: 1, net_type: "4g",
    online: true, webgl: true, ref_code: "GP-4K7QX2",
  });
});

test("makeImageryError: the captured Error is ours, and already scrubbed", () => {
  const err = makeImageryError(
    "image_dead",
    "GET https://graph.mapillary.com/1263588815098567?access_token=MLY|secret failed",
  );
  assert.equal(err.name, "ImageryError");
  assert.ok(err.message.startsWith("ImageryError: image_dead"));
  assert.ok(!err.message.includes("1263588815098567"));
  assert.ok(!err.message.includes("access_token"));
  assert.equal(makeImageryError("viewer_init", "").message,
    "ImageryError: viewer_init");
});

/* ---------------- trackError: the same gate as track ---------------- */

test("trackError: nothing loads and nothing captures before consent", async () => {
  const { a, loads, ph } = harness();
  assert.equal(a.trackError(new Error("x"), { surface: "host" }), false);
  await tick();
  assert.equal(loads.count, 0, "PostHog must not even be loaded");
  assert.equal(ph.exceptions.length, 0);
});

test("trackError: a declined user never sends an exception", async () => {
  const { a, storage, loads } = harness();
  setConsent(storage, CONSENT_DECLINED);
  assert.equal(a.trackError(new Error("x"), { surface: "host" }), false);
  await tick();
  assert.equal(loads.count, 0);
});

test("trackError: with consent, props are allowlisted before capture", async () => {
  const { a, storage, ph } = harness();
  setConsent(storage, CONSENT_ACCEPTED);
  await a.init();
  const err = makeImageryError("image_dead", "Image <id> not found");
  assert.equal(a.trackError(err, {
    surface: "host", error_class: "image_dead", pool_entry: "k3x9q0ar",
    lat: 51.5, teamName: "Wanderers",
  }), true);
  assert.equal(ph.exceptions.length, 1);
  assert.equal(ph.exceptions[0].error, err);
  assert.deepEqual(ph.exceptions[0].props, {
    surface: "host", error_class: "image_dead", pool_entry: "k3x9q0ar",
  });
});

test("trackError: exceptions queue with events and flush in order", async () => {
  const storage = memStorage();
  const ph = fakePosthog();
  let release;
  const gate = new Promise((r) => { release = r; });
  const a = createAnalytics({ storage, loadPosthog: () => gate.then(() => ph) });
  setConsent(storage, CONSENT_ACCEPTED);
  a.init();
  a.track("imagery_load", { surface: "host", purpose: "anchor", ok: false });
  a.trackError(makeImageryError("image_dead", "dead"), { surface: "host" });
  assert.equal(ph.captured.length, 0);
  release();
  await tick();
  assert.equal(ph.captured.length, 1);
  assert.equal(ph.exceptions.length, 1);
});

test("trackError: a bundle with no captureException degrades to events only", async () => {
  const storage = memStorage();
  const old = fakePosthog();
  delete old.captureException;
  const a = createAnalytics({ storage, loadPosthog: () => Promise.resolve(old) });
  setConsent(storage, CONSENT_ACCEPTED);
  await a.init();
  assert.equal(a.trackError(new Error("x"), { surface: "host" }), true);
  assert.equal(old.captured.length, 0, "no crash, nothing invented");
});

test("trackError: a missing error object is a no-op", async () => {
  const { a, storage } = harness();
  setConsent(storage, CONSENT_ACCEPTED);
  await a.init();
  assert.equal(a.trackError(null, { surface: "host" }), false);
});

/* ---------------- release stamping + recording override ---------------- */

test("register: release super props are gated and allowlisted", async () => {
  const { a, storage, ph } = harness();
  assert.equal(a.register({ release: "abc1234" }), false, "no consent, no stamp");
  setConsent(storage, CONSENT_ACCEPTED);
  await a.init();
  assert.equal(a.register({
    release: "abc1234", commit: "abc1234def", deployed_at: "2026-08-20T10:00:00Z",
    lat: 51.5, secret: "nope",
  }), true);
  assert.deepEqual(ph.superProps, {
    release: "abc1234", commit: "abc1234def", deployed_at: "2026-08-20T10:00:00Z",
  });
});

test("register: a stamp made before the script lands is applied on load", async () => {
  const storage = memStorage();
  const ph = fakePosthog();
  let release;
  const gate = new Promise((r) => { release = r; });
  const a = createAnalytics({ storage, loadPosthog: () => gate.then(() => ph) });
  setConsent(storage, CONSENT_ACCEPTED);
  a.init();
  a.register({ release: "dev" });
  assert.equal(ph.superProps, null);
  release();
  await tick();
  assert.deepEqual(ph.superProps, { release: "dev" });
});

test("register: an empty/garbage stamp is rejected", async () => {
  const { a, storage } = harness();
  setConsent(storage, CONSENT_ACCEPTED);
  await a.init();
  assert.equal(a.register({}), false);
  assert.equal(a.register({ nonsense: 1 }), false);
});

/* ---- release super-property allowlist + registration ordering ---- */

test("release: RELEASE_PROPS is EXACTLY {release, commit, deployed_at}", () => {
  // The allowlist is a hard pin: it can neither silently regrow a key (the
  // retired deployment_channel) nor lose one that js/consent.js registers.
  assert.deepEqual(RELEASE_PROPS,
    { release: "string", commit: "string", deployed_at: "string" });
});

test("release: registration is consent-gated — nothing is stamped before opt-in", async () => {
  const { a, storage, ph } = harness();
  assert.equal(a.register({ release: "abc1234" }), false, "no consent, no stamp");
  setConsent(storage, CONSENT_ACCEPTED);
  await a.init();
  assert.equal(ph.superProps, null, "the pre-consent register buffered nothing to the client");
});

test("release: super props are applied BEFORE queued events flush (returning-visitor flow)", async () => {
  // Mirrors consent.js's returning-visitor path: a register() may run
  // synchronously, then init() resumes the load, then product events queue
  // while the script is in flight. The buffered-register-before-flush
  // property is general consent machinery.
  const storage = memStorage();
  const ph = orderingFake();
  let release;
  const gate = new Promise((r) => { release = r; });
  const a = createAnalytics({ storage, loadPosthog: () => gate.then(() => ph) });
  setConsent(storage, CONSENT_ACCEPTED); // prior session opted in
  a.register({ release: "abc1234" });
  a.init();
  a.track("round_started", { room: "ABCDEF", mode: "couch", round_number: 1 });
  assert.equal(ph.captured.length, 0, "not delivered before the script lands");
  release();
  await tick();
  assert.equal(ph.superProps.release, "abc1234");
  const ev = ph.captured.find((c) => c.event === "round_started");
  assert.ok(ev, "the queued event flushed");
  assert.equal(ev.superAtCapture?.release, "abc1234",
    "the schema event flushed AFTER the release super property was applied");
});

test("release: super props are applied before consent_given flushes (fresh-accept flow)", async () => {
  // Mirrors the banner accept handler: accept() sets consent + starts the
  // load, a register() may run synchronously right after, then product events
  // queue — all before the script lands.
  const storage = memStorage();
  const ph = orderingFake();
  let release;
  const gate = new Promise((r) => { release = r; });
  const a = createAnalytics({ storage, loadPosthog: () => gate.then(() => ph) });
  a.accept();
  a.register({ release: "abc1234" });
  a.track("game_created", { room: "ABCDEF", mode: "couch" });
  assert.equal(ph.captured.length, 0, "nothing before the script lands");
  release();
  await tick();
  assert.equal(ph.superProps.release, "abc1234");
  // EVERY captured event — the flushed game_created AND consent_given — must
  // have seen the super property already applied.
  assert.ok(ph.captured.length >= 2);
  for (const ev of ph.captured) {
    assert.equal(ev.superAtCapture?.release, "abc1234",
      `${ev.event} flushed before the release super property`);
  }
});

test("startRecording: consent-gated, and a no-op on an older bundle", async () => {
  const { a, storage, ph } = harness();
  assert.equal(a.startRecording(), false, "no consent, no recording");
  setConsent(storage, CONSENT_ACCEPTED);
  await a.init();
  assert.equal(a.startRecording(), true);
  assert.equal(ph.recordings, 1);
  delete ph.startSessionRecording;
  assert.equal(a.startRecording(), false);
});

/* ---------------- §10.4 one-time diagnostic consent ---------------- */

function oneShotHarness() {
  const storage = memStorage();
  const main = fakePosthog();
  const shot = fakePosthog();
  const calls = { main: 0, oneShot: 0, options: null };
  const a = createAnalytics({
    storage,
    loadPosthog: () => { calls.main++; return Promise.resolve(main); },
    loadPosthogOneShot: (key, options) => {
      calls.oneShot++;
      calls.options = options;
      calls.key = key;
      return Promise.resolve(shot);
    },
  });
  return { storage, main, shot, calls, a };
}

const REPORT = {
  event: "imagery_report",
  props: {
    surface: "player", ref_code: "GP-4K7QX2", error_class: "image_dead",
    net_type: "4g", online: true, recent_failures: 1, consent: "one_time",
  },
  error: makeImageryError("reported_by_user", "image_dead"),
  errorProps: { surface: "player", ref_code: "GP-4K7QX2" },
};

test("one-time report: a decliner's stored 'no' is never changed", async () => {
  const { a, storage } = oneShotHarness();
  setConsent(storage, CONSENT_DECLINED);
  await a.sendDiagnostic(REPORT);
  assert.equal(getConsent(storage), CONSENT_DECLINED);
});

test("one-time report: sends exactly one bundle, then opts out", async () => {
  const { a, storage, shot, main, calls } = oneShotHarness();
  setConsent(storage, CONSENT_DECLINED);
  assert.equal(await a.sendDiagnostic(REPORT), true);
  assert.equal(calls.main, 0, "the consented instance is never loaded");
  assert.equal(calls.oneShot, 1);
  assert.equal(main.captured.length, 0);
  assert.deepEqual(shot.captured.map((c) => c.event), ["imagery_report"]);
  assert.equal(shot.exceptions.length, 1);
  assert.equal(shot.optedOut, true, "capturing stops immediately after");
});

test("one-time report: works for a user who has made no choice yet", async () => {
  const { a, storage, shot } = oneShotHarness();
  assert.equal(getConsent(storage), null);
  assert.equal(await a.sendDiagnostic(REPORT), true);
  assert.equal(shot.captured.length, 1);
  assert.equal(getConsent(storage), null, "still no stored choice");
});

test("one-time report: the bundle is schema-sanitized like any other event", async () => {
  const { a, storage, shot } = oneShotHarness();
  setConsent(storage, CONSENT_DECLINED);
  await a.sendDiagnostic({
    ...REPORT,
    props: { ...REPORT.props, lat: 51.5, note: "it broke", image_id: "1263588815098567" },
    errorProps: { ...REPORT.errorProps, lat: 51.5 },
  });
  const keys = Object.keys(shot.captured[0].props);
  for (const k of ["lat", "note", "image_id"]) assert.ok(!keys.includes(k), k);
  assert.ok(!("lat" in shot.exceptions[0].props));
});

test("one-time report: an unknown event is refused outright", async () => {
  const { a, storage, calls } = oneShotHarness();
  setConsent(storage, CONSENT_DECLINED);
  assert.equal(await a.sendDiagnostic({ ...REPORT, event: "not_a_real_event" }), false);
  assert.equal(calls.oneShot, 0, "nothing is even loaded for a bad event");
});

test("one-time report: a blocked/failed one-shot load reports failure honestly", async () => {
  const storage = memStorage();
  setConsent(storage, CONSENT_DECLINED);
  const a = createAnalytics({
    storage,
    loadPosthog: () => Promise.resolve(fakePosthog()),
    loadPosthogOneShot: () => Promise.reject(new Error("adblock")),
  });
  assert.equal(await a.sendDiagnostic(REPORT), false);
});

test("one-time report: an accepted user takes the ordinary gated path", async () => {
  const { a, storage, main, shot, calls } = oneShotHarness();
  setConsent(storage, CONSENT_ACCEPTED);
  await a.init();
  assert.equal(await a.sendDiagnostic(REPORT), true);
  assert.equal(calls.oneShot, 0, "no second instance for a consented user");
  assert.equal(shot.captured.length, 0);
  assert.deepEqual(main.captured.map((c) => c.event), ["imagery_report"]);
  assert.equal(main.exceptions.length, 1);
  assert.equal(main.optedOut, false, "consented capture keeps running");
});

test("one-shot init options: memory persistence, no replay, no autocapture", () => {
  const o = oneShotInitOptions();
  assert.equal(o.persistence, "memory");
  assert.equal(o.disable_session_recording, true);
  assert.equal(o.autocapture, false);
  assert.equal(o.capture_pageview, false);
  assert.equal(o.capture_exceptions, false);
  assert.equal(o.api_host, POSTHOG_INIT_OPTIONS.api_host, "still EU-resident");
  assert.equal(o.before_send, sanitizeBeforeSend);
  // A fresh, mutable object every call — posthog.init() writes onto it.
  assert.notEqual(oneShotInitOptions(), o);
  assert.equal(Object.isExtensible(o), true);
});

/* ---------------- replay + before_send configuration ---------------- */

test("init options: replay masking is configured and stays mutable", () => {
  const r = POSTHOG_INIT_OPTIONS.session_recording;
  assert.equal(r.maskAllInputs, true);
  assert.equal(r.captureCanvas, false, "street pixels are never recorded");
  assert.equal(r.recordHeaders, false);
  assert.equal(r.recordBody, false);
  assert.ok(r.maskTextSelector.includes("[data-ph-mask]"));
  assert.ok(r.blockSelector.includes(".leaflet-container"), "map tiles are coordinates");
  assert.equal(typeof r.maskCapturedNetworkRequestFn, "function");
  assert.equal(POSTHOG_INIT_OPTIONS.enable_recording_console_log, true);
  assert.equal(Object.isExtensible(r), true);
  assert.equal(Object.isExtensible(POSTHOG_INIT_OPTIONS.capture_exceptions), true);
});

test("init options: exception + web-vitals autocapture are on, console errors off", () => {
  const e = POSTHOG_INIT_OPTIONS.capture_exceptions;
  assert.equal(e.capture_unhandled_errors, true);
  assert.equal(e.capture_unhandled_rejections, true);
  assert.equal(e.capture_console_errors, false);
  assert.equal(POSTHOG_INIT_OPTIONS.capture_performance.web_vitals, true);
  assert.equal(POSTHOG_INIT_OPTIONS.before_send, sanitizeBeforeSend);
});

test("maskNetworkRequest: allowlisted hosts keep timing, lose the query string", () => {
  const out = maskNetworkRequest(
    { name: "https://graph.mapillary.com/1263588815098567?access_token=MLY|s", duration: 812 },
    "geoparty.example",
  );
  assert.equal(out.name, "https://graph.mapillary.com/<id>");
  assert.equal(out.duration, 812);
});

test("maskNetworkRequest: OSM tiles are dropped — a tile path is a coordinate", () => {
  assert.equal(
    maskNetworkRequest({ name: "https://tile.openstreetmap.org/16/32791/21801.png" }, "x"),
    null,
  );
  assert.ok(!NETWORK_HOST_ALLOWLIST.includes("tile.openstreetmap.org"));
});

test("maskNetworkRequest: non-allowlisted hosts are dropped entirely", () => {
  assert.equal(maskNetworkRequest({ name: "https://tracker.example/beacon" }, "x"), null);
  assert.equal(maskNetworkRequest({ name: "https://evil.graph.mapillary.com.attacker.net/x" }, "x"), null);
  assert.equal(maskNetworkRequest(null, "x"), null);
  assert.equal(maskNetworkRequest({}, "x"), null);
});

test("maskNetworkRequest: our own origin and relative URLs stay visible", () => {
  assert.equal(
    maskNetworkRequest({ name: "release.json" }, "geoparty.example").name,
    "release.json",
  );
  assert.equal(
    maskNetworkRequest({ name: "https://geoparty.example/data/location_pool.json?v=2" },
      "geoparty.example").name,
    "https://geoparty.example/data/location_pool.json",
  );
});

test("maskNetworkRequest: headers and bodies are deleted, not trusted", () => {
  const out = maskNetworkRequest({
    name: "https://graph.mapillary.com/x",
    requestHeaders: { authorization: "Bearer secret" },
    responseBody: "{...}",
    requestBody: "{...}",
    responseHeaders: { "set-cookie": "x" },
  }, "x");
  assert.deepEqual(Object.keys(out), ["name"]);
});

test("sanitizeBeforeSend: strips query strings and ids from URL properties", () => {
  const ev = sanitizeBeforeSend({
    event: "$pageview",
    properties: {
      $current_url: "https://geoparty.example/player.html?room=KWPF&utm_source=share",
      $pathname: "/player.html",
      $referrer: "https://x.example/a?b=c",
      distance_km: 12.4,
    },
  });
  assert.equal(ev.properties.$current_url, "https://geoparty.example/player.html");
  assert.equal(ev.properties.$referrer, "https://x.example/a");
  assert.equal(ev.properties.distance_km, 12.4, "non-URL props untouched");
});

test("sanitizeBeforeSend: scrubs exception values and stack frames", () => {
  const ev = sanitizeBeforeSend({
    event: "$exception",
    properties: {
      $exception_message: "Image 1263588815098567 not found",
      $exception_list: [{
        type: "Error",
        value: "GET https://graph.mapillary.com/1263588815098567?access_token=MLY|s",
        stacktrace: {
          frames: [{
            filename: "https://geoparty.example/js/viewer-ui.js?v=1263588815098567",
            abs_path: "https://geoparty.example/js/viewer-ui.js?v=2",
          }],
        },
      }],
    },
  });
  const ex = ev.properties.$exception_list[0];
  assert.ok(!ex.value.includes("1263588815098567"));
  assert.ok(!ex.value.includes("access_token"));
  assert.equal(ex.stacktrace.frames[0].filename,
    "https://geoparty.example/js/viewer-ui.js");
  assert.ok(!ev.properties.$exception_message.includes("1263588815098567"));
});

test("sanitizeBeforeSend: scrubs coordinate-shaped decimals from exception props", () => {
  const ev = sanitizeBeforeSend({
    event: "$exception",
    properties: {
      $exception_message: "moveTo near 48.8566, 2.3522 failed",
      $exception_list: [{
        type: "Error",
        value: "guess at 48.8566, 2.3522 rejected",
      }],
    },
  });
  assert.ok(!ev.properties.$exception_message.includes("48.8566"));
  assert.ok(!ev.properties.$exception_message.includes("2.3522"));
  assert.ok(!ev.properties.$exception_list[0].value.includes("48.8566"));
  assert.ok(!ev.properties.$exception_list[0].value.includes("2.3522"));
});

test("sanitizeBeforeSend: never drops an event (that is the schema's job)", () => {
  assert.deepEqual(sanitizeBeforeSend({ event: "x" }), { event: "x" });
  assert.equal(sanitizeBeforeSend(null), null);
  const weird = { event: "y", properties: { $exception_list: "nope" } };
  assert.equal(sanitizeBeforeSend(weird), weird);
});
