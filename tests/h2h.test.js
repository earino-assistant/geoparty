// Tests for js/h2h.js — head-to-head logic: slot claiming, submission
// tracking, reveal ordering, winner selection, and the multi-writer
// invariants the sync design leans on.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  H2H_PHASES,
  h2hCanTransition,
  MAX_TEAMS,
  freeTeamSlot,
  teamForDevice,
  isHostDevice,
  allSubmitted,
  submittedCount,
  pendingTeams,
  submitRank,
  revealOrder,
  roundClosest,
  h2hWinner,
  initialH2hRoomState,
  carryTeams,
  SCREEN_STALE_MS,
  screenAttached,
  liveRivalPins,
  revealPins,
  revealAceKm,
  shouldReanchorViewer,
  panoMoved,
} from "../js/h2h.js";

const teams = {
  t1: { name: "Alpha", total: 500, deviceId: "dev-1" },
  t2: { name: "Bravo", total: 900, deviceId: "dev-2" },
  t3: { name: "Charlie", total: 900, deviceId: "dev-3" },
};

/* ---------------- phase machine ---------------- */

test("h2h phases: no global guessing phase; gameOver is terminal", () => {
  assert.ok(h2hCanTransition("lobby", "roundActive"));
  assert.ok(h2hCanTransition("roundActive", "reveal"));
  assert.ok(h2hCanTransition("reveal", "roundActive"));
  assert.ok(h2hCanTransition("reveal", "gameOver"));
  assert.equal(h2hCanTransition("gameOver", "lobby"), false); // next game = new room
  assert.equal(h2hCanTransition("roundActive", "gameOver"), false);
  assert.deepEqual(
    [...H2H_PHASES].sort(),
    ["gameOver", "lobby", "reveal", "roundActive"].sort()
  );
});

/* ---------------- slots & identity ---------------- */

test("freeTeamSlot: first free of t1..t4, gaps filled, full room is null", () => {
  assert.equal(freeTeamSlot({}), "t1");
  assert.equal(freeTeamSlot(null), "t1");
  assert.equal(freeTeamSlot({ t1: {}, t2: {} }), "t3");
  assert.equal(freeTeamSlot({ t1: {}, t3: {} }), "t2"); // a leaver's slot reopens
  const full = {};
  for (let i = 1; i <= MAX_TEAMS; i++) full[`t${i}`] = {};
  assert.equal(freeTeamSlot(full), null);
});

test("teamForDevice: recognizes a returning phone, null otherwise", () => {
  assert.equal(teamForDevice(teams, "dev-2"), "t2");
  assert.equal(teamForDevice(teams, "dev-9"), null);
  assert.equal(teamForDevice(teams, null), null);
  assert.equal(teamForDevice(null, "dev-1"), null);
});

test("isHostDevice: only the host team's device", () => {
  const state = { hostTeam: "t1", teams };
  assert.equal(isHostDevice(state, "dev-1"), true);
  assert.equal(isHostDevice(state, "dev-2"), false);
  assert.equal(isHostDevice(null, "dev-1"), false);
  assert.equal(isHostDevice({ teams }, "dev-1"), false); // no hostTeam yet
});

/* ---------------- submissions ---------------- */

const partialRound = {
  results: {
    t1: { guess: { lat: 0, lng: 0 }, distanceKm: 100, submittedAt: 1000 },
    t3: { guess: { lat: 1, lng: 1 }, distanceKm: 50, submittedAt: 2000 },
  },
};

test("allSubmitted / submittedCount / pendingTeams track the round", () => {
  assert.equal(allSubmitted(teams, partialRound), false);
  assert.equal(submittedCount(partialRound), 2);
  assert.deepEqual(pendingTeams(teams, partialRound), ["t2"]);

  const complete = {
    results: { ...partialRound.results, t2: { guess: null, submittedAt: 3000 } },
  };
  assert.equal(allSubmitted(teams, complete), true);
  assert.deepEqual(pendingTeams(teams, complete), []);
});

test("allSubmitted: false with no teams or no round", () => {
  assert.equal(allSubmitted({}, partialRound), false);
  assert.equal(allSubmitted(teams, null), false);
  assert.equal(submittedCount(null), 0);
});

// Regression guard for the simultaneous-lock-in deadlock: when the last two
// phones lock in at once (the timeout auto-submit makes this the common
// case), each phone's local snapshot predates the other's result, so
// NEITHER sees a complete set at lock time — but once the writes merge,
// any subscriber must be able to detect the complete round and close it.
test("deadlock regression: stale snapshots incomplete, merged state complete", () => {
  const base = { t1: { guess: {}, submittedAt: 900 } };
  const snapshotOnPhone2 = { results: { ...base, t2: { guess: {}, submittedAt: 1000 } } };
  const snapshotOnPhone3 = { results: { ...base, t3: { guess: {}, submittedAt: 1001 } } };
  // At lock time, each racer is blind to the other:
  assert.equal(allSubmitted(teams, snapshotOnPhone2), false);
  assert.equal(allSubmitted(teams, snapshotOnPhone3), false);
  // After both writes land, the merged state is detectably complete — this
  // is the condition player-ui's onState guard flips the room on.
  const merged = {
    results: { ...snapshotOnPhone2.results, ...snapshotOnPhone3.results },
  };
  assert.equal(allSubmitted(teams, merged), true);
});

test("submitRank: 1-based by submittedAt, null for teams not in", () => {
  assert.equal(submitRank(partialRound, "t1"), 1);
  assert.equal(submitRank(partialRound, "t3"), 2);
  assert.equal(submitRank(partialRound, "t2"), null);
  assert.equal(submitRank(null, "t1"), null);
});

/* ---------------- reveal ordering ---------------- */

test("revealOrder: forfeits lead, then farthest to closest", () => {
  const round = {
    results: {
      t1: { guess: { lat: 0, lng: 0 }, distanceKm: 40 },
      t2: { guess: null, distanceKm: null, forfeited: true },
      t3: { guess: { lat: 0, lng: 0 }, distanceKm: 4000 },
    },
  };
  assert.deepEqual(revealOrder(round).map((r) => r.id), ["t2", "t3", "t1"]);
});

test("revealOrder: stable with multiple forfeits (no NaN ordering surprises)", () => {
  const round = {
    results: {
      t1: { guess: null },
      t2: { guess: null },
      t3: { guess: { lat: 0, lng: 0 }, distanceKm: 10 },
    },
  };
  const order = revealOrder(round).map((r) => r.id);
  assert.equal(order.length, 3);
  assert.equal(order[2], "t3"); // the only real guess is drawn last (winner beat)
});

test("roundClosest: crowns the nearest real guess, null if all forfeited", () => {
  const round = {
    results: {
      t1: { guess: {}, distanceKm: 900 },
      t2: { guess: {}, distanceKm: 20 },
    },
  };
  assert.equal(roundClosest(round), "t2");
  assert.equal(roundClosest({ results: { t1: { guess: null } } }), null);
  assert.equal(roundClosest(null), null);
});

/* ---------------- no-screen remote play ---------------- */

test("screenAttached: fresh heartbeat only; stale/missing/no state is false", () => {
  const now = 1_000_000_000;
  assert.equal(screenAttached({ screenHeartbeat: now - 1000 }, now), true);
  assert.equal(
    screenAttached({ screenHeartbeat: now - SCREEN_STALE_MS + 1 }, now), true);
  assert.equal(
    screenAttached({ screenHeartbeat: now - SCREEN_STALE_MS }, now), false);
  assert.equal(screenAttached({ screenHeartbeat: null }, now), false);
  assert.equal(screenAttached({}, now), false);
  assert.equal(screenAttached(null, now), false);
});

test("liveRivalPins: rivals with real pins only, my own pin excluded", () => {
  const round = {
    live: {
      t1: { stage: "map", pin: { lat: 10, lng: 20 } },   // me — excluded
      t2: { stage: "map", pin: { lat: -5, lng: 100 } },  // rival with a pin
      t3: { stage: "explore", pin: null },               // rival, no pin yet
      t4: { stage: "locked" },                           // locked: pin nulled
    },
  };
  assert.deepEqual(liveRivalPins(round, "t1"), [
    { id: "t2", lat: -5, lng: 100 },
  ]);
});

test("liveRivalPins: malformed pins are dropped, empty rounds are empty", () => {
  const round = {
    live: {
      t2: { pin: { lat: "5", lng: 6 } },  // wrong type
      t3: { pin: { lat: 5 } },            // missing lng
    },
  };
  assert.deepEqual(liveRivalPins(round, "t1"), []);
  assert.deepEqual(liveRivalPins(null, "t1"), []);
  assert.deepEqual(liveRivalPins({}, "t1"), []);
});

test("liveRivalPins: stable team-id order for consistent map layering", () => {
  const round = {
    live: {
      t3: { pin: { lat: 3, lng: 3 } },
      t2: { pin: { lat: 2, lng: 2 } },
    },
  };
  assert.deepEqual(liveRivalPins(round, "t1").map((p) => p.id), ["t2", "t3"]);
});

// R4: the Blind Duel gate. In a 🔒 blind-twist round every device suppresses
// rival live pins — the phone's own guess map must never leak a rival's aim,
// exactly as the TV panels don't. This test fails if the guard is removed:
// without it, the two real rival pins below would come through.
test("liveRivalPins: a Blind Duel round returns NO rival pins (fails if the guard is removed)", () => {
  const round = {
    twist: { id: "blind" },
    live: {
      t1: { stage: "map", pin: { lat: 10, lng: 20 } },   // me
      t2: { stage: "map", pin: { lat: -5, lng: 100 } },  // rival, real pin
      t3: { stage: "map", pin: { lat: 44, lng: -70 } },  // rival, real pin
    },
  };
  // The identical round without the twist DOES surface the rivals — proving the
  // pins are otherwise valid and it is the blind guard doing the suppression.
  const unblind = { ...round, twist: null };
  assert.deepEqual(liveRivalPins(unblind, "t1").map((p) => p.id), ["t2", "t3"]);
  // With the Blind Duel twist, nothing leaks.
  assert.deepEqual(liveRivalPins(round, "t1"), []);
});

/* ---------------- revealAceKm (R3 — the TV ACE burst gate) ---------------- */

// R3 (C2): the ACE burst on the h2h reveal + couch Final Showdown cascades
// rides the CLOSEST pin landing. revealAceKm returns that minimum distance so
// the renderer prices the sub-1km medal; nothing here touches points.
test("revealAceKm: the closest (minimum) pin distance drives the ACE burst", () => {
  const round = {
    results: {
      t1: { guess: { lat: 1, lng: 1 }, distanceKm: 0.4 },  // an ACE (< 1 km)
      t2: { guess: { lat: 2, lng: 2 }, distanceKm: 812 },
      t3: { guess: { lat: 3, lng: 3 }, distanceKm: 30 },
    },
  };
  assert.equal(revealAceKm(round), 0.4);
});

test("revealAceKm: no sub-1km pin → the minimum, which the renderer reads as no ACE", () => {
  const round = {
    results: {
      t1: { guess: { lat: 1, lng: 1 }, distanceKm: 12 },
      t2: { guess: { lat: 2, lng: 2 }, distanceKm: 3 },
    },
  };
  assert.equal(revealAceKm(round), 3);   // medalForDistance(3).ace === false
});

test("revealAceKm: forfeits are skipped; an all-forfeit round returns null", () => {
  const round = {
    results: {
      t1: { guess: null, distanceKm: null },   // forfeit
      t2: { guess: { lat: 2, lng: 2 }, distanceKm: 0.7 },
    },
  };
  assert.equal(revealAceKm(round), 0.7);
  assert.equal(revealAceKm({ results: { t1: { distanceKm: null } } }), null);
  assert.equal(revealAceKm({}), null);
  assert.equal(revealAceKm(null), null);
});

test("revealPins: real guesses only, farthest first (the reveal draw order)", () => {
  const round = {
    results: {
      t1: { guess: { lat: 1, lng: 1 }, distanceKm: 40 },
      t2: { guess: null, forfeited: true },
      t3: { guess: { lat: 3, lng: 3 }, distanceKm: 4000 },
    },
  };
  assert.deepEqual(revealPins(round), [
    { id: "t3", lat: 3, lng: 3, distanceKm: 4000,
      superSure: false, superSureOutcome: null },
    { id: "t1", lat: 1, lng: 1, distanceKm: 40,
      superSure: false, superSureOutcome: null },
  ]);
  assert.deepEqual(revealPins(null), []);
  assert.deepEqual(revealPins({ results: { t1: { guess: null } } }), []);
});

test("revealPins: SUPER SURE verdict rides along for the phone reveal map", () => {
  // Reveal-only surface — the no-screen h2h phones badge the bet here.
  const round = {
    results: {
      t1: { guess: { lat: 1, lng: 1 }, distanceKm: 40,
            superSure: true, superSureOutcome: "won" },
      t2: { guess: { lat: 2, lng: 2 }, distanceKm: 900 },
    },
  };
  const pins = revealPins(round);
  assert.deepEqual(
    pins.map((p) => [p.id, p.superSure, p.superSureOutcome]),
    [["t2", false, null], ["t1", true, "won"]]);
});

/* ---------------- winner & handoff ---------------- */

test("h2hWinner: clear leader wins", () => {
  const t = {
    t1: { name: "A", total: 100 },
    t2: { name: "B", total: 900 },
  };
  assert.equal(h2hWinner(t, "KWPF"), "t2");
});

test("h2hWinner: ties break deterministically to a tied team", () => {
  // t2 and t3 tie at 900. Every phone must independently agree.
  const w1 = h2hWinner(teams, "KWPF");
  const w2 = h2hWinner(teams, "KWPF");
  assert.equal(w1, w2);
  assert.ok(["t2", "t3"].includes(w1), `winner ${w1} not among the tied`);
  // The flip is seeded by the room code, so across many codes both tied
  // teams win sometimes (unbiased across rooms).
  const codes = ["AAAA", "BBBB", "CCCC", "DDDD", "KWPF", "QXJM", "ZZZZ", "HHJK"];
  const winners = new Set(codes.map((c) => h2hWinner(teams, c)));
  assert.ok(winners.size > 1, "coin flip never varies across room codes");
});

test("h2hWinner: null on an empty room", () => {
  assert.equal(h2hWinner({}, "KWPF"), null);
});

test("carryTeams: same slots and identity, zeroed scores", () => {
  const withMeta = {
    t1: { name: "A", total: 700, deviceId: "dev-1", joinedAt: 111 },
    t2: { name: "B", total: 300 },
  };
  const next = carryTeams(withMeta);
  assert.deepEqual(next.t1, { name: "A", total: 0, deviceId: "dev-1", joinedAt: 111 });
  // Missing metadata becomes explicit nulls (RTDB rejects undefined).
  assert.deepEqual(next.t2, { name: "B", total: 0, deviceId: null, joinedAt: null });
});

test("initialH2hRoomState: lobby, h2h mode, host recorded", () => {
  const state = initialH2hRoomState({ roundCount: 5 }, { t1: { name: "A", total: 0 } }, "t1");
  assert.equal(state.mode, "h2h");
  assert.equal(state.phase, "lobby");
  assert.equal(state.hostTeam, "t1");
  assert.equal(state.poolCursor, 0);
  assert.equal(state.round, null);
});

/* ---------------- viewer anchoring (movement bounce) ---------------- */

test("shouldReanchorViewer: anchors a fresh viewer to the round image", () => {
  assert.equal(shouldReanchorViewer(null, null, "img-anchor"), true);
});

test("shouldReanchorViewer: steady state stays put", () => {
  assert.equal(shouldReanchorViewer("img-anchor", "img-anchor", "img-anchor"), false);
});

test("shouldReanchorViewer: player movement NEVER snaps back (the bounce)", () => {
  // The regression: the player walked to a neighbor image, then a state
  // echo (own or a rival's ≤4/s live write) re-rendered the round. Where
  // the player currently is must be irrelevant — only the anchor counts.
  assert.equal(shouldReanchorViewer("img-anchor", "img-neighbor", "img-anchor"), false);
  assert.equal(shouldReanchorViewer("img-anchor", "img-far-away", "img-anchor"), false);
});

test("shouldReanchorViewer: a new round's anchor re-anchors", () => {
  assert.equal(shouldReanchorViewer("img-r1", "img-r1-neighbor", "img-r2"), true);
});

test("shouldReanchorViewer: no round image means no move", () => {
  assert.equal(shouldReanchorViewer(null, null, null), false);
  assert.equal(shouldReanchorViewer("img-a", "img-a", undefined), false);
});

test("panoMoved: true only when the pin's pano left the anchor", () => {
  assert.equal(panoMoved("img-anchor", "img-neighbor"), true);
  assert.equal(panoMoved("img-anchor", "img-anchor"), false);
  // Unknown state (no viewer yet, forfeit paths) is never "moved".
  assert.equal(panoMoved(null, "img-x"), false);
  assert.equal(panoMoved("img-x", null), false);
  assert.equal(panoMoved(null, null), false);
});
