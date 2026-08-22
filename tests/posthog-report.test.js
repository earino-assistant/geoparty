// Tests for the offline metrics tooling — the pure digest builder
// (tools/posthog_report.mjs) and the stable-window contract
// (tools/posthog_metrics.mjs). No network is touched: the digest is built
// from hand-authored bags, and the window builder is pure date math. These
// cover the two demonstrated P0s of the EM review — a failed query must never
// render as a healthy zero, and a null exception stack must not crash — plus
// the reproducibility contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDigest, fmtStack } from "../tools/posthog_report.mjs";
import { buildWindows, resolveAsof } from "../tools/posthog_metrics.mjs";

// A fully-populated, all-ok bag we can selectively break in each test.
function fullBag() {
  return {
    generated_at: "2026-08-22T00:00:00.000Z",
    asof: "2026-08-22",
    window: { asof: "2026-08-22", end: "2026-08-22", start14: "2026-08-08", start30: "2026-07-23" },
    ok: true,
    errors: [],
    metrics: {
      core_30d: { label: "Core", rows: [[10, 6, 2, 40, 120, 33]] },
      mode_mix_30d: { label: "Mode", rows: [["couch", 5, 3], ["h2h", 5, 3]] },
      funnel_14d: { label: "Funnel", rows: [["party_choice", 20], ["game_created", 10], ["round_started", 40], ["game_completed", 6]] },
      modifier_funnel_14d: { label: "Mod", rows: [[8, 4, 1, 2]] },
      exceptions_14d: { label: "Exc", rows: [['["a","b","boom"]', false, 3, 1]] },
      guess_distance_14d: { label: "Guess", rows: [[120.5, 80.1, 1.2, 900.0, 120]] },
      edge_recovery_14d: { label: "Edge", rows: [["recovered", "uncached", 3], ["no_change", "zero", 1]] },
      daily_30d: { label: "Daily", rows: [[12, 7, 2]] },
    },
  };
}

test("all-error bag renders NO DATA markers, never zeros", () => {
  const bag = fullBag();
  for (const k of Object.keys(bag.metrics)) bag.metrics[k] = { label: k, error: true };
  bag.ok = false;
  bag.errors = Object.keys(bag.metrics);
  const out = buildDigest(bag, null);

  // Every section prints the failure marker...
  const markers = out.split("\n").filter((l) => l.includes("NO DATA")).length;
  assert.ok(markers >= 7, `expected a marker per failed section, got ${markers}`);
  // ...and the incomplete-pull banner is loud.
  assert.match(out, /metrics pull incomplete/);
  // A failed core must NOT masquerade as a real zero.
  assert.doesNotMatch(out, /Rooms created: \*\*0\*\*/);
});

test("zero-row edge_recovery renders explicitly, not a missing line", () => {
  const bag = fullBag();
  bag.metrics.edge_recovery_14d = { label: "Edge", rows: [] };
  const out = buildDigest(bag, null);
  assert.match(out, /Navigation recovery \(14d\):/);
  assert.match(out, /none in window \(no recovery attempts needed\)/);
});

test("recovery rate KPI is computed from the result mix", () => {
  const out = buildDigest(fullBag(), null);
  // 3 recovered of 4 total attempts.
  assert.match(out, /recovery rate: \*\*75%\*\* \(3\/4 attempts recovered\)/);
});

test("zero-row mode mix and exceptions render 'none in window'", () => {
  const bag = fullBag();
  bag.metrics.mode_mix_30d = { label: "Mode", rows: [] };
  bag.metrics.exceptions_14d = { label: "Exc", rows: [] };
  const out = buildDigest(bag, null);
  const modeSection = out.slice(out.indexOf("Mode mix"));
  assert.match(modeSection, /none in window/);
  const excSection = out.slice(out.indexOf("Errors (14d)"));
  assert.match(excSection, /none in window/);
});

test("null / garbage $exception_functions does not crash", () => {
  assert.equal(fmtStack(null), "(no stack)");
  assert.equal(fmtStack(undefined), "(no stack)");
  assert.equal(fmtStack(""), "(no stack)");
  assert.equal(fmtStack("not json at all"), "not json at all");
  assert.equal(fmtStack('["x","y","z"]'), "y › z");
  assert.equal(fmtStack(["x", "y", "z"]), "y › z");
  assert.equal(fmtStack(42), "(no stack)");

  const bag = fullBag();
  bag.metrics.exceptions_14d = { label: "Exc", rows: [[null, false, 5, 1], ["{garbage", true, 2, 1]] };
  let out;
  assert.doesNotThrow(() => { out = buildDigest(bag, null); });
  assert.match(out, /\(no stack\)/);
  assert.match(out, /⚠ UNHANDLED/);
});

test("boolean handled classification splits UNHANDLED vs handled", () => {
  const bag = fullBag();
  bag.metrics.exceptions_14d = {
    label: "Exc",
    rows: [['["boom"]', false, 3, 1], ['["ok"]', true, 9, 2]],
  };
  const out = buildDigest(bag, null);
  assert.match(out, /⚠ UNHANDLED boom: \*\*3\*\*/);
  assert.match(out, /· handled ok: \*\*9\*\*/);
  assert.match(out, /> Unhandled: boom \(3\)/);
});

test("delta math: completed / active devices / funnel step deltas", () => {
  const cur = fullBag();
  const prev = fullBag();
  prev.metrics.core_30d = { label: "Core", rows: [[8, 4, 1, 30, 90, 25]] };
  prev.metrics.funnel_14d = { label: "Funnel", rows: [["game_created", 7], ["game_completed", 4]] };
  const out = buildDigest(cur, prev);
  assert.match(out, /Rooms created: \*\*10\*\* \(\+2 vs last week\)/);
  assert.match(out, /active devices: \*\*33\*\* \(\+8 vs last week\)/);
  assert.match(out, /Completed: \*\*6\*\* \(\+2 vs last week\)/);
  assert.match(out, /game_created: \*\*10\*\* \(\+3 vs last week\)/);
});

test("missing baseline (no prev) suppresses deltas cleanly", () => {
  const out = buildDigest(fullBag(), null);
  assert.doesNotMatch(out, /vs last week/);
  assert.doesNotMatch(out, /baseline unreliable/);
});

test("unreliable baseline (prev.ok=false) suppresses deltas with a warning", () => {
  const prev = fullBag();
  prev.ok = false;
  prev.errors = ["core_30d"];
  const out = buildDigest(fullBag(), prev);
  assert.match(out, /⚠ baseline unreliable/);
  assert.doesNotMatch(out, /vs last week/);
});

test("header prints asof and the resolved window bounds", () => {
  const out = buildDigest(fullBag(), null);
  assert.match(out, /as of 2026-08-22/);
  assert.match(out, /30d 2026-07-23→2026-08-22/);
  assert.match(out, /14d 2026-08-08→2026-08-22/);
});

/* ---------------- window-builder (reproducibility) ---------------- */

test("buildWindows: 14d/30d literal bounds anchored to asof", () => {
  const w = buildWindows("2026-08-22");
  assert.equal(w.end, "2026-08-22");
  assert.equal(w.start14, "2026-08-08");
  assert.equal(w.start30, "2026-07-23");
  assert.match(w.w14, /timestamp >= toDate\('2026-08-08'\) and timestamp < toDate\('2026-08-22'\)/);
  assert.match(w.w30, /timestamp >= toDate\('2026-07-23'\) and timestamp < toDate\('2026-08-22'\)/);
  // No now() — the whole point of the stable-window contract.
  assert.doesNotMatch(w.w14, /now\(\)/);
  assert.doesNotMatch(w.w30, /now\(\)/);
});

test("buildWindows: re-run reproduces the same bounds (month boundary)", () => {
  assert.deepEqual(buildWindows("2026-03-05"), buildWindows("2026-03-05"));
  // Crossing into February / January exercises the UTC date math.
  const w = buildWindows("2026-03-05");
  assert.equal(w.start14, "2026-02-19");
  assert.equal(w.start30, "2026-02-03");
});

test("resolveAsof: accepts real dates, rejects malformed and impossible ones", () => {
  assert.equal(resolveAsof("2026-08-22"), "2026-08-22");
  assert.throws(() => resolveAsof("2026-8-2"), /YYYY-MM-DD/);
  assert.throws(() => resolveAsof("2026-13-01"), /not a real date/);
  assert.throws(() => resolveAsof("2026-02-30"), /not a real date/);
  assert.throws(() => resolveAsof("garbage"), /YYYY-MM-DD/);
  // Omitted → today UTC, a valid YYYY-MM-DD.
  assert.match(resolveAsof(null), /^\d{4}-\d{2}-\d{2}$/);
});
