// Tests for tools/pool_watch.mjs — the DAILY early-warning pool watcher (the
// fast lane; field-observability plan §13). The live pipeline (PostHog query,
// Mapillary probe, git push) is never exercised here; what matters is the pure
// decision core, mirroring tests/pool-health.test.js:
//   - the candidate filter (≥ MIN_FAILS AND zero successes),
//   - the reverse diagId → raw-id table built from the pool,
//   - the traffic-level outage guard,
//   - the two-attempt probe classification, verified against a STUBBED fetcher
//     so no network call ever happens.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectCandidates,
  isTrafficOutage,
  buildReverseTable,
  classifyProbeAttempts,
  verifyDead,
  scrub,
} from "../tools/pool_watch.mjs";
import { poolDiagId } from "../js/imagery.js";

/* ---------------- candidate filter ---------------- */

test("selectCandidates: ≥3 fails AND zero successes is a candidate", () => {
  const rows = [
    ["deadish", 6, 0, 4], // the incident shape: many fails, no oks
    ["mixed", 5, 2, 3],   // someone still got through → not a candidate
    ["unlucky", 2, 0, 1], // below the floor → one bad player, not rot
    ["healthy", 0, 40, 0],
  ];
  const cands = selectCandidates(rows);
  assert.deepEqual(cands.map((c) => c.pool), ["deadish"]);
  assert.equal(cands[0].fails, 6);
  assert.equal(cands[0].failSessions, 4);
});

test("selectCandidates: exactly MIN_FAILS with zero oks qualifies", () => {
  assert.equal(selectCandidates([["x", 3, 0, 1]]).length, 1);
  assert.equal(selectCandidates([["x", 3, 1, 1]]).length, 0, "a single ok clears it");
});

test("selectCandidates: a custom floor and empty/blank rows", () => {
  assert.equal(selectCandidates([["x", 4, 0, 1]], 5).length, 0);
  assert.equal(selectCandidates([["", 9, 0, 1]]).length, 0, "blank pseudonym skipped");
  assert.deepEqual(selectCandidates(null), []);
});

/* ---------------- outage guard ---------------- */

test("isTrafficOutage: fires only above the pct AND with real volume", () => {
  assert.equal(isTrafficOutage(0, 0), false, "no traffic → no outage");
  assert.equal(isTrafficOutage(4, 10), false, "40% but only 4 fails is below the volume floor");
  assert.equal(isTrafficOutage(8, 15), true, "8/15 ≈ 53% with volume → outage");
  assert.equal(isTrafficOutage(7, 100), false, "7 fails in 100 is one rotten entry, not an outage");
  assert.equal(isTrafficOutage(60, 100), true);
});

test("isTrafficOutage: the boundary is strictly greater-than", () => {
  // 40% exactly is NOT an outage (a rotten entry can push a slow hour to 40%).
  assert.equal(isTrafficOutage(8, 20, { minFails: 6 }), false, "exactly 40% is not > 40%");
  assert.equal(isTrafficOutage(9, 20, { minFails: 6 }), true, "45% is");
});

/* ---------------- reverse table ---------------- */

test("buildReverseTable: diagId → raw id, matching the forward hash", () => {
  const pool = [
    { image_id: "1263588815098567" },
    { image_id: "144692807618687" },
  ];
  const rev = buildReverseTable(pool);
  for (const e of pool) {
    assert.deepEqual(rev.get(poolDiagId(e.image_id)), [e.image_id]);
  }
});

test("buildReverseTable: numeric ids are stringified, junk entries skipped", () => {
  const rev = buildReverseTable([
    { image_id: 42 },
    { name: "no id here" },
    null,
    { image_id: "7" },
  ]);
  assert.deepEqual(rev.get(poolDiagId("42")), ["42"]);
  assert.deepEqual(rev.get(poolDiagId("7")), ["7"]);
  assert.equal([...rev.values()].flat().length, 2, "only the two real ids");
});

test("buildReverseTable: a diag collision keeps every colliding raw id", () => {
  // Force a collision by hand: two entries whose ids we pretend fold the same.
  const rev = buildReverseTable([{ image_id: "a" }, { image_id: "a" }]);
  assert.deepEqual(rev.get(poolDiagId("a")), ["a", "a"]);
});

/* ---------------- two-attempt probe classification (pure) ---------------- */

test("classifyProbeAttempts: both attempts dead → dead", () => {
  assert.equal(classifyProbeAttempts(["dead", "dead"]), "dead");
  assert.equal(classifyProbeAttempts(["transient_5xx", "transient_5xx"]), "dead");
  assert.equal(classifyProbeAttempts(["transient_5xx", "dead"]), "dead");
});

test("classifyProbeAttempts: any alive wins, immediately", () => {
  assert.equal(classifyProbeAttempts(["alive"]), "alive");
  assert.equal(classifyProbeAttempts(["transient_5xx", "alive"]), "alive");
});

test("classifyProbeAttempts: an inconclusive attempt is never evidence", () => {
  assert.equal(classifyProbeAttempts(["rate_limited"]), "inconclusive");
  assert.equal(classifyProbeAttempts(["error"]), "inconclusive");
  assert.equal(classifyProbeAttempts(["transient_5xx", "error"]), "inconclusive",
    "a death that did not reproduce is not a strike");
  assert.equal(classifyProbeAttempts([]), "inconclusive");
});

test("classifyProbeAttempts: a single death is not enough (needs both)", () => {
  assert.equal(classifyProbeAttempts(["dead"], 2), "inconclusive");
  assert.equal(classifyProbeAttempts(["dead"], 1), "dead", "…unless one attempt is configured");
});

/* ---------------- verifyDead over a STUBBED fetcher (no network) ---------------- */

// A fetcher stub that replays a scripted queue of {status, body} responses.
const stub = (responses) => {
  let i = 0;
  const calls = [];
  const fetcher = async (id) => {
    calls.push(id);
    return responses[Math.min(i++, responses.length - 1)];
  };
  return { fetcher, calls };
};

test("verifyDead: the incident shape — is_transient 5xx twice → dead", async () => {
  const body = { error: { is_transient: true } };
  const { fetcher, calls } = stub([{ status: 500, body }, { status: 500, body }]);
  const verdict = await verifyDead("144692807618687", "tok", { fetcher, delayMs: 0 });
  assert.equal(verdict, "dead");
  assert.equal(calls.length, 2, "it re-probed the same id");
});

test("verifyDead: a 200 on the first attempt is decisively alive, no re-probe", async () => {
  const { fetcher, calls } = stub([{ status: 200, body: { data: [{ id: "1" }] } }]);
  assert.equal(await verifyDead("1", "tok", { fetcher, delayMs: 0 }), "alive");
  assert.equal(calls.length, 1, "a live id is not probed twice");
});

test("verifyDead: a transient 5xx that recovers on retry is not dead", async () => {
  const responses = [
    { status: 500, body: { error: { is_transient: true } } },
    { status: 200, body: { data: [{ id: "1" }] } },
  ];
  const { fetcher } = stub(responses);
  assert.equal(await verifyDead("1", "tok", { fetcher, delayMs: 0 }), "alive");
});

test("verifyDead: 404 twice → dead; a lone 429 → inconclusive", async () => {
  const gone = stub([{ status: 404, body: null }, { status: 404, body: null }]);
  assert.equal(await verifyDead("x", "tok", { fetcher: gone.fetcher, delayMs: 0 }), "dead");

  const limited = stub([{ status: 429, body: null }]);
  assert.equal(await verifyDead("x", "tok", { fetcher: limited.fetcher, delayMs: 0 }),
    "inconclusive");
  assert.equal(limited.calls.length, 1, "a rate-limit stops the probe — never evidence");
});

test("verifyDead: a non-transient 5xx is inconclusive, never dead", async () => {
  // Stricter than the original Python (which treated any 5xx as death): the
  // shared SDK probe only strikes on a Graph-confirmed is_transient 5xx.
  const { fetcher } = stub([
    { status: 500, body: { error: { is_transient: false } } },
    { status: 500, body: { error: { is_transient: false } } },
  ]);
  assert.equal(await verifyDead("x", "tok", { fetcher, delayMs: 0 }), "inconclusive");
});

/* ---------------- secret scrub ---------------- */

test("scrub: every known secret is masked out of a report line", () => {
  const line = "pushed with OAuth SECRET123 and key phk_ABC done";
  assert.equal(
    scrub(line, ["SECRET123", "phk_ABC"]),
    "pushed with OAuth «token» and key «token» done");
  assert.equal(scrub("nothing here", []), "nothing here");
  assert.equal(scrub("empty secret ignored", ["", null]), "empty secret ignored");
});
