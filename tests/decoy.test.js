// Tests for js/decoy.js — the Decoy Pin (G7, spec §3.7, §6.1). Availability
// (spent / blind-twist / after carry), the deploy-state fold, reveal exposure,
// and the hidden-in-play guarantee: the live-pin feed carries no decoy marker.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decoyAvailable,
  decoyInitialState,
  decoyDeployFold,
  canLockWithDecoy,
  plantedDecoy,
  revealDecoys,
  teamPlantedDecoy,
} from "../js/decoy.js";
import { carryTeams, liveRivalPins } from "../js/h2h.js";

/* ---------------- availability ---------------- */

test("decoyAvailable: true while unspent, false when spent or during Blind Duel", () => {
  const teams = { t1: { name: "A" }, t2: { name: "B", decoyUsed: 2 } };
  assert.equal(decoyAvailable(teams, "t1", null), true);
  assert.equal(decoyAvailable(teams, "t2", null), false);        // spent
  assert.equal(decoyAvailable(teams, "t1", "blind"), false);     // blind twist
  assert.equal(decoyAvailable(teams, "t1", "blitz"), true);      // other twists fine
  assert.equal(decoyAvailable(teams, "tX", null), false);        // no such team
});

test("carryTeams resets decoyUsed for the next game (mirrors superSureUsed)", () => {
  const teams = { t1: { name: "A", total: 50, decoyUsed: 3, deviceId: "d1" } };
  const next = carryTeams(teams);
  assert.equal(next.t1.decoyUsed, undefined);
  assert.equal(decoyAvailable(next, "t1", null), true);
});

/* ---------------- deploy-state fold ---------------- */

test("decoyDeployFold: arm → first tap plants the decoy → rest place the real pin", () => {
  let { state } = { state: decoyInitialState() };
  // Before arming, a tap just places the real pin.
  let r = decoyDeployFold(state, "tap");
  assert.equal(r.place, "pin");
  // Arm from the sheet.
  r = decoyDeployFold(state, "arm");
  state = r.state;
  assert.deepEqual(state, { armed: true, planted: false });
  assert.equal(r.place, null);
  // First tap after arming plants the decoy.
  r = decoyDeployFold(state, "tap");
  state = r.state;
  assert.equal(r.place, "decoy");
  assert.deepEqual(state, { armed: true, planted: true });
  // Every tap after that moves the real pin.
  r = decoyDeployFold(state, "tap");
  assert.equal(r.place, "pin");
  assert.deepEqual(r.state, { armed: true, planted: true });
});

test("canLockWithDecoy: a planted decoy alone is not a lockable guess", () => {
  assert.equal(canLockWithDecoy(false), false);
  assert.equal(canLockWithDecoy(true), true);
});

/* ---------------- reveal exposure ---------------- */

test("plantedDecoy / revealDecoys / teamPlantedDecoy read the results subtree", () => {
  const round = {
    results: {
      t1: { guess: { lat: 1, lng: 2 }, distanceKm: 10, decoy: { lat: 40, lng: -3 } },
      t2: { guess: { lat: 5, lng: 6 }, distanceKm: 20 },   // no decoy
      t3: { guess: null, decoy: { lat: -33, lng: -70 } },  // planted, forfeited real pin
    },
  };
  assert.deepEqual(plantedDecoy(round, "t1"), { lat: 40, lng: -3 });
  assert.equal(plantedDecoy(round, "t2"), null);
  assert.deepEqual(revealDecoys(round).map((d) => d.id), ["t1", "t3"]);
  assert.equal(teamPlantedDecoy(round, "t1"), true);
  assert.equal(teamPlantedDecoy(round, "t2"), false);
});

/* ---------------- hidden-in-play: the live feed carries no decoy marker ------ */

test("live-surface absence: a decoyed team's live pin is indistinguishable", () => {
  // The decoy rides round/live/tN/pin as ORDINARY coordinates — the whole point
  // is that a rival can't tell. liveRivalPins must expose only {id,lat,lng},
  // never a decoy flag, on the in-play path (the SUPER SURE hidden-in-play rule).
  const round = {
    live: {
      t1: { pin: { lat: 48.8, lng: 2.3 } },          // real pin
      t2: { pin: { lat: -34.6, lng: -58.4 } },        // a planted decoy — looks identical
    },
  };
  const pins = liveRivalPins(round, "t3");
  for (const p of pins) {
    assert.deepEqual(Object.keys(p).sort(), ["id", "lat", "lng"]);
    assert.equal("decoy" in p, false);
  }
});
