// Tests for js/couchscreen.js — S7: couch without a TV. The invariants this
// module exists to enforce: (1) Start Round is NEVER gated on a screen —
// the TV is an optional accessory; (2) screen liveness is judged on the
// receiving clock (a skewed TV is not a dead TV, and a dead TV's replayed
// last beat is not a live TV); (3) with no live screen the host phone is
// the shared display, and it can render every couch round shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HEARTBEAT_ANCIENT_MS,
  foldHeartbeat,
  screenLive,
  phoneIsScreen,
  lobbyReadiness,
  couchRevealPins,
  crownLine,
} from "../js/couchscreen.js";
import { SCREEN_STALE_MS } from "../js/h2h.js";

const T = 1_700_000_000_000; // an arbitrary "now"

/* ---------------- foldHeartbeat ---------------- */

test("foldHeartbeat: no beat keeps the previous state", () => {
  assert.equal(foldHeartbeat(null, null, T), null);
  assert.equal(foldHeartbeat(null, undefined, T), null);
  const prev = { ts: T - 1000, seenAt: T - 1000 };
  assert.equal(foldHeartbeat(prev, null, T), prev); // room field cleared
});

test("foldHeartbeat: a fresh beat is stamped on the RECEIVING clock", () => {
  // The TV's clock is 4 minutes behind — comparing its value against our
  // clock would read as stale; receipt-stamping keeps it live.
  const beat = foldHeartbeat(null, T - 240_000, T);
  assert.deepEqual(beat, { ts: T - 240_000, seenAt: T });
  // A TV clock AHEAD of ours is fine too.
  assert.deepEqual(foldHeartbeat(null, T + 60_000, T),
    { ts: T + 60_000, seenAt: T });
});

test("foldHeartbeat: a replayed identical beat keeps its original stamp", () => {
  // (Re)subscribing replays the path's last value — that is not a new beat.
  const first = foldHeartbeat(null, T - 1000, T);
  const replay = foldHeartbeat(first, T - 1000, T + 20_000);
  assert.equal(replay, first);
});

test("foldHeartbeat: a dead screen's ancient last beat is ignored", () => {
  // Resume into a room whose TV died an hour ago: the subscription replays
  // its final heartbeat. Stamping that fresh would fake a live TV for 30s.
  assert.equal(foldHeartbeat(null, T - 3_600_000, T), null);
  // The threshold matches the accepted 5-minute client-skew allowance.
  assert.equal(foldHeartbeat(null, T - HEARTBEAT_ANCIENT_MS - 1, T), null);
  assert.deepEqual(
    foldHeartbeat(null, T - HEARTBEAT_ANCIENT_MS, T),
    { ts: T - HEARTBEAT_ANCIENT_MS, seenAt: T });
});

/* ---------------- screenLive / phoneIsScreen ---------------- */

test("screenLive: no beat ever seen means no screen", () => {
  assert.equal(screenLive(null, T), false);
});

test("screenLive: same freshness window as h2h's screenAttached", () => {
  const beat = { ts: T, seenAt: T };
  assert.equal(screenLive(beat, T + SCREEN_STALE_MS - 1), true);
  assert.equal(screenLive(beat, T + SCREEN_STALE_MS), false);
});

test("phoneIsScreen: the phone takes over when the TV detaches mid-game", () => {
  // TV beat received at T; it dies. Ten seconds later it's still "the TV
  // shows the reveal"; past the stale window the phone becomes the screen.
  const beat = foldHeartbeat(null, T, T);
  assert.equal(phoneIsScreen(beat, T + 10_000), false);
  assert.equal(phoneIsScreen(beat, T + SCREEN_STALE_MS), true);
  // And with no TV ever attached, the phone is the screen from the start.
  assert.equal(phoneIsScreen(null, T), true);
});

/* ---------------- lobbyReadiness: the gate is GONE ---------------- */

test("lobbyReadiness: Start Round is never gated, in any state (S7)", () => {
  for (const live of [true, false]) {
    for (const connected of [true, false]) {
      const r = lobbyReadiness(live, connected);
      assert.equal(r.canStart, true,
        `gated at live=${live} connected=${connected}`);
      assert.ok(r.note.length > 0);
    }
  }
});

test("lobbyReadiness: the note names the mode the couch is in", () => {
  const tv = lobbyReadiness(true, true);
  assert.ok(tv.ok);
  assert.ok(tv.note.includes("TV connected"));
  const offline = lobbyReadiness(false, false);
  assert.ok(!offline.ok);
  assert.ok(offline.note.includes("Offline"));
  // No TV online: the phone-as-screen promise, and the TV stays on offer.
  const solo = lobbyReadiness(false, true);
  assert.ok(!solo.ok);
  assert.ok(solo.note.includes("No TV"));
  assert.ok(solo.note.includes("Add a TV"));
});

/* ---------------- couchRevealPins ---------------- */

const TRUTH = { lat: 62.03, lng: 129.73, name: "Yakutsk" };

test("couchRevealPins: nothing without a round or its truth", () => {
  assert.deepEqual(couchRevealPins(null, "t1"), []);
  assert.deepEqual(couchRevealPins({ guess: { lat: 1, lng: 2 } }, "t1"), []);
});

test("couchRevealPins: a solo round yields the active team's one pin", () => {
  const round = {
    truth: TRUTH,
    guess: { lat: 48.85, lng: 2.35 },
    score: { points: 3100, distanceKm: 5200.4 },
  };
  assert.deepEqual(couchRevealPins(round, "t2"), [{
    id: "t2", lat: 48.85, lng: 2.35, distanceKm: 5200.4,
    superSure: false, superSureOutcome: null,
  }]);
});

test("couchRevealPins: a solo SUPER SURE verdict rides to the map", () => {
  const round = {
    truth: TRUTH,
    guess: { lat: 62, lng: 129.7 },
    score: { points: 4900, distanceKm: 3.7, superSure: true, superSureOutcome: "won" },
  };
  const [pin] = couchRevealPins(round, "t1");
  assert.equal(pin.superSure, true);
  assert.equal(pin.superSureOutcome, "won");
});

test("couchRevealPins: a solo round with no confirmed pin draws nothing", () => {
  assert.deepEqual(couchRevealPins({ truth: TRUTH, guess: null }, "t1"), []);
});

test("couchRevealPins: the showdown yields every pin, farthest first", () => {
  // Same draw order as the TV and the h2h phone map: build toward the winner.
  const round = {
    truth: TRUTH,
    showdown: true,
    results: {
      t1: { guess: { lat: 61, lng: 129 }, distanceKm: 120, points: 4600 },
      t2: { guess: { lat: -33, lng: 151 }, distanceKm: 10_000, points: 60,
            superSure: true, superSureOutcome: "lost" },
    },
  };
  const pins = couchRevealPins(round, "t1");
  assert.deepEqual(pins.map((p) => p.id), ["t2", "t1"]);
  assert.equal(pins[0].superSure, true);
  assert.equal(pins[0].superSureOutcome, "lost");
  assert.equal(pins[1].distanceKm, 120);
});

/* ---------------- crownLine ---------------- */

test("crownLine: names the leader, crown first", () => {
  const teams = {
    t1: { name: "Wolves", total: 9000 },
    t2: { name: "Owls", total: 12_000 },
  };
  assert.equal(crownLine(teams), "👑 Owls wins!");
});

test("crownLine: a single-team co-op game has no rivalry to crown", () => {
  assert.equal(crownLine({ t1: { name: "Everyone", total: 9000 } }), null);
  assert.equal(crownLine({}), null);
});

test("crownLine: a tie crowns the first-ranked team, like the TV podium", () => {
  const teams = {
    t2: { name: "Owls", total: 9000 },
    t1: { name: "Wolves", total: 9000 },
  };
  // standings() ranks stably over sorted team ids — t1 leads the tie.
  assert.equal(crownLine(teams), "👑 Wolves wins!");
});
