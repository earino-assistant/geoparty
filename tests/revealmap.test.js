// Tests for js/revealmap.js — the pure scene builder shared by the four
// reveal surfaces (docs/revealmap-refactor.md §4). This is the drift-proofing
// layer: every style atom is deep-equal'd against the literal values that were
// copied from the four source files, so the collapse can't silently change a
// color, radius, dash, delay or tooltip string.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TEAM_HEX, teamHex, escapeHtml, REVEAL_SIZES,
  LEAFLET_MAP_OPTIONS, TILE_URL, TILE_ATTRIBUTION, TILE_OPTIONS,
  dailyRevealScene, phoneRevealScene, tvSoloRevealScene, tvCascadeRevealScene,
  recapOverviewScene,
} from "../js/revealmap.js";
import { superSureLabel } from "../js/supersure.js";
import { formatDistance } from "../js/game.js";

// Four teams, stable-sorted by key (t1..t4) — teamHex indexes on that order.
const TEAMS = {
  t1: { name: "Alpha" }, t2: { name: "Beta" },
  t3: { name: "Gamma" }, t4: { name: "Delta" },
};

/* ---------------- teamHex + escapeHtml ---------------- */

test("teamHex: 4 known ids map to the 4 hexes in order", () => {
  assert.deepEqual(
    ["t1", "t2", "t3", "t4"].map((id) => teamHex(TEAMS, id)),
    TEAM_HEX
  );
});

test("teamHex: a 5th team cycles the palette", () => {
  const five = { ...TEAMS, t5: { name: "Eps" } };
  assert.equal(teamHex(five, "t5"), TEAM_HEX[0]);
});

test("teamHex: an unknown id falls back to TEAM_HEX[0] (guarded variant)", () => {
  assert.equal(teamHex(TEAMS, "nope"), TEAM_HEX[0]);
  assert.equal(teamHex({}, "t1"), TEAM_HEX[0]);
});

test("escapeHtml: each dangerous char becomes its numeric entity", () => {
  assert.equal(escapeHtml("&"), "&#38;");
  assert.equal(escapeHtml("<"), "&#60;");
  assert.equal(escapeHtml(">"), "&#62;");
  assert.equal(escapeHtml('"'), "&#34;");
  assert.equal(escapeHtml("'"), "&#39;");
});

test("escapeHtml: a hostile team name round-trips inert; plain text untouched", () => {
  assert.equal(
    escapeHtml("<img src=x onerror=alert(1)>"),
    "&#60;img src=x onerror=alert(1)&#62;"
  );
  assert.equal(escapeHtml("Team Awesome"), "Team Awesome");
});

/* ---------------- shared constants ---------------- */

test("LEAFLET_MAP_OPTIONS: the frozen interaction-off set (attribution defaults on)", () => {
  assert.deepEqual(LEAFLET_MAP_OPTIONS, {
    zoomControl: false, dragging: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false,
  });
  assert.ok(Object.isFrozen(LEAFLET_MAP_OPTIONS));
});

test("tile layer: URL + options match the four copies verbatim", () => {
  assert.equal(TILE_URL, "https://tile.openstreetmap.org/{z}/{x}/{y}.png");
  assert.equal(
    TILE_ATTRIBUTION,
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  );
  assert.deepEqual(TILE_OPTIONS, { maxZoom: 19, attribution: TILE_ATTRIBUTION });
});

/* ---------------- dailyRevealScene ---------------- */

const T = { lat: 62.0, lng: 129.7 };   // "truth"
const G = { lat: 40.0, lng: -74.0 };   // "guess"
const GH = { lat: 51.5, lng: -0.1 };   // "ghost pin"

test("dailyRevealScene: guess + ghost → [line, guessPin, delayedGroup, fit, truthPin]", () => {
  const scene = dailyRevealScene({
    truth: T, guess: G, ghost: { pin: GH, distanceKm: 1234.5 }, reducedMotion: false,
  });
  assert.deepEqual(scene.ops.map((o) => o.op),
    ["line", "circle", "delayedGroup", "fit", "circle"]);
  assert.deepEqual(scene.cascade, []);
  assert.deepEqual(scene.finale, []);

  // guess line + guess pin (daily's fixed #4dd6ff, phone sizes, weight 2)
  assert.deepEqual(scene.ops[0], {
    op: "line", from: G, to: T, style: { color: "#4dd6ff", weight: 3, dashArray: "6 8" },
  });
  assert.deepEqual(scene.ops[1], {
    op: "circle", at: G,
    style: { radius: 8, color: "#fff", weight: 2, fillColor: "#4dd6ff", fillOpacity: 1 },
  });

  // fit frames truth + guess + ghost pin
  assert.deepEqual(scene.ops[3], { op: "fit", points: [T, G, GH], pad: 0.25, maxZoom: 10 });

  // truth pin: gold, radius 10, no tooltip
  assert.deepEqual(scene.ops[4], {
    op: "circle", at: T,
    style: { radius: 10, color: "#111", weight: 3, fillColor: "#ffcf3f", fillOpacity: 1 },
  });
});

test("dailyRevealScene: the ghost delayedGroup (delay 400, fade, exact ops)", () => {
  const scene = dailyRevealScene({
    truth: T, guess: G, ghost: { pin: GH, distanceKm: 42.3 }, reducedMotion: false,
  });
  const grp = scene.ops[2];
  assert.equal(grp.op, "delayedGroup");
  assert.equal(grp.delayMs, 400);
  assert.equal(grp.fade, true);
  assert.deepEqual(grp.ops, [
    { op: "line", from: GH, to: T, style: { color: "#c9a2ff", weight: 2, dashArray: "3 5" } },
    { op: "circle", at: GH, style: { radius: 8, color: "#c9a2ff", weight: 2, dashArray: "3 3", fillColor: "#2a2140", fillOpacity: 0.85 } },
    { op: "chip", at: GH, className: "ghost-chip", html: `👻 ${formatDistance(42.3)}` },
  ]);
});

test("dailyRevealScene: reduced motion → delay 0, fade off", () => {
  const scene = dailyRevealScene({
    truth: T, guess: G, ghost: { pin: GH, distanceKm: 5 }, reducedMotion: true,
  });
  const grp = scene.ops[2];
  assert.equal(grp.delayMs, 0);
  assert.equal(grp.fade, false);
});

test("dailyRevealScene: no guess → [view(truth,4), truthPin]", () => {
  const scene = dailyRevealScene({ truth: T, guess: null, ghost: null, reducedMotion: false });
  assert.deepEqual(scene.ops.map((o) => o.op), ["view", "circle"]);
  assert.deepEqual(scene.ops[0], { op: "view", center: T, zoom: 4 });
});

test("dailyRevealScene: ghost but no guess still fits (bounds > 1)", () => {
  const scene = dailyRevealScene({
    truth: T, guess: null, ghost: { pin: GH, distanceKm: 9 }, reducedMotion: false,
  });
  assert.deepEqual(scene.ops.map((o) => o.op), ["delayedGroup", "fit", "circle"]);
  assert.deepEqual(scene.ops[1], { op: "fit", points: [T, GH], pad: 0.25, maxZoom: 10 });
});

/* ---------------- phoneRevealScene ---------------- */

function pin(id, lat, lng, extra = {}) {
  return { id, lat, lng, distanceKm: 100, superSure: false, superSureOutcome: null, ...extra };
}

test("phoneRevealScene: per-pin triplet [line, circle, halo?], fit first, truth last", () => {
  const pins = [
    pin("t1", 10, 20),
    pin("t2", 30, 40, { superSure: true, superSureOutcome: "won" }),
  ];
  const scene = phoneRevealScene({ truth: T, pins, decoys: [], teams: TEAMS });
  assert.deepEqual(scene.ops.map((o) => o.op),
    ["fit", "line", "circle", "line", "circle", "circle", "circle"]);
  // fit = truth + all pins
  assert.deepEqual(scene.ops[0],
    { op: "fit", points: [T, { lat: 10, lng: 20 }, { lat: 30, lng: 40 }], pad: 0.25, maxZoom: 10 });
  // t1: line + circle in team color, no halo
  assert.deepEqual(scene.ops[1],
    { op: "line", from: { lat: 10, lng: 20 }, to: T, style: { color: TEAM_HEX[0], weight: 3, dashArray: "6 8" } });
  assert.deepEqual(scene.ops[2],
    { op: "circle", at: { lat: 10, lng: 20 }, style: { radius: 8, color: "#fff", weight: 2, fillColor: TEAM_HEX[0], fillOpacity: 1 } });
  // t2: super-sure halo with the shared label + phone size 14
  assert.deepEqual(scene.ops[5], {
    op: "circle", at: { lat: 30, lng: 40 },
    style: { radius: 14, color: "#ffcf3f", weight: 3, fill: false, dashArray: "4 6", interactive: false },
    tooltip: { html: "SUPER SURE ×2", direction: "bottom", permanent: true, className: "ss-tooltip" },
  });
  assert.equal(scene.ops[5].tooltip.html, superSureLabel(pins[1]));
  // truth last, phone size 10, no tooltip
  assert.deepEqual(scene.ops[6],
    { op: "circle", at: T, style: { radius: 10, color: "#111", weight: 3, fillColor: "#ffcf3f", fillOpacity: 1 } });
});

test("phoneRevealScene: a lost bet uses the '— 0' label", () => {
  const pins = [pin("t1", 1, 2, { superSure: true, superSureOutcome: "lost" })];
  const scene = phoneRevealScene({ truth: T, pins, decoys: [], teams: TEAMS });
  const halo = scene.ops.find((o) => o.tooltip);
  assert.equal(halo.tooltip.html, "SUPER SURE — 0");
});

test("phoneRevealScene: decoys come after the pins, before the truth", () => {
  const scene = phoneRevealScene({
    truth: T, pins: [pin("t1", 1, 2)],
    decoys: [{ id: "t2", lat: 5, lng: 6 }], teams: TEAMS,
  });
  assert.deepEqual(scene.ops.map((o) => o.op), ["fit", "line", "circle", "chip", "circle"]);
  assert.deepEqual(scene.ops[3],
    { op: "chip", at: { lat: 5, lng: 6 }, className: "decoy-marker reveal", html: "🎭", interactive: false });
});

/* ---------------- tvSoloRevealScene ---------------- */

test("tvSoloRevealScene: grey Guess pin, animated line, gold Answer finale", () => {
  const scene = tvSoloRevealScene({
    truth: T, guess: G, score: { superSure: false }, reducedMotion: false,
  });
  assert.deepEqual(scene.ops.map((o) => o.op), ["circle", "fit"]);
  assert.deepEqual(scene.ops[0], {
    op: "circle", at: G,
    style: { radius: 12, color: "#fff", weight: 3, fillColor: "#555", fillOpacity: 1 },
    tooltip: { html: "Guess", direction: "top", permanent: true },
  });
  assert.equal(scene.cascade.length, 1);
  assert.deepEqual(scene.cascade[0], {
    id: null, forfeit: false, ops: [],
    line: { from: G, to: T, style: { color: "#ffcf3f", weight: 4, dashArray: "8 10" }, durationMs: 1000 },
    afterDelayMs: 0,
  });
  assert.deepEqual(scene.finale, [{
    op: "circle", at: T,
    style: { radius: 12, color: "#111", weight: 3, fillColor: "#ffcf3f", fillOpacity: 1 },
    tooltip: { html: "Answer", direction: "top", permanent: true },
  }]);
});

test("tvSoloRevealScene: super-sure adds an r18 halo; reduced motion → duration 0", () => {
  const scene = tvSoloRevealScene({
    truth: T, guess: G, score: { superSure: true, superSureOutcome: "won" }, reducedMotion: true,
  });
  assert.deepEqual(scene.ops.map((o) => o.op), ["circle", "circle", "fit"]);
  assert.equal(scene.ops[1].style.radius, 18);
  assert.equal(scene.ops[1].tooltip.html, "SUPER SURE ×2");
  assert.equal(scene.cascade[0].line.durationMs, 0);
});

/* ---------------- tvCascadeRevealScene ---------------- */

function entry(id, lat, lng, extra = {}) {
  return { id, guess: { lat, lng }, distanceKm: 100, superSure: false, superSureOutcome: null, ...extra };
}

test("tvCascadeRevealScene: entry order is preserved (no re-sort)", () => {
  const entries = [entry("t3", 3, 3), entry("t1", 1, 1), entry("t2", 2, 2)];
  const scene = tvCascadeRevealScene({ truth: T, entries, decoys: [], teams: TEAMS, reducedMotion: false });
  assert.deepEqual(scene.cascade.map((s) => s.id), ["t3", "t1", "t2"]);
});

test("tvCascadeRevealScene: guessed step shape (pin tooltip escaped, line, delay 300)", () => {
  const entries = [entry("t2", 30, 40, { superSure: true, superSureOutcome: "won" })];
  const scene = tvCascadeRevealScene({ truth: T, entries, decoys: [], teams: TEAMS, reducedMotion: false });
  const step = scene.cascade[0];
  assert.equal(step.forfeit, false);
  assert.equal(step.afterDelayMs, 300);
  assert.deepEqual(step.ops[0], {
    op: "circle", at: { lat: 30, lng: 40 },
    style: { radius: 10, color: "#fff", weight: 3, fillColor: TEAM_HEX[1], fillOpacity: 1 },
    tooltip: { html: "Beta", direction: "top", permanent: true },
  });
  // halo (tv size 16) present for the bet
  assert.deepEqual(step.ops[1], {
    op: "circle", at: { lat: 30, lng: 40 },
    style: { radius: 16, color: "#ffcf3f", weight: 3, fill: false, dashArray: "4 6", interactive: false },
    tooltip: { html: "SUPER SURE ×2", direction: "bottom", permanent: true, className: "ss-tooltip" },
  });
  assert.deepEqual(step.line, {
    from: { lat: 30, lng: 40 }, to: T,
    style: { color: TEAM_HEX[1], weight: 4, dashArray: "8 10" }, durationMs: 800,
  });
});

test("tvCascadeRevealScene: a hostile team name is escaped in the pin tooltip", () => {
  const teams = { t1: { name: "<b>x</b>" } };
  const scene = tvCascadeRevealScene({
    truth: T, entries: [entry("t1", 1, 2)], decoys: [], teams, reducedMotion: false,
  });
  assert.equal(scene.cascade[0].ops[0].tooltip.html, "&#60;b&#62;x&#60;/b&#62;");
});

test("tvCascadeRevealScene: a forfeit is a no-line beat with delay 250", () => {
  const entries = [{ id: "t1", superSure: false }, entry("t2", 2, 2)];
  const scene = tvCascadeRevealScene({ truth: T, entries, decoys: [], teams: TEAMS, reducedMotion: false });
  assert.deepEqual(scene.cascade[0], { id: "t1", forfeit: true, ops: [], line: null, afterDelayMs: 250 });
});

test("tvCascadeRevealScene: decoys lead the prelude; fit excludes forfeits", () => {
  const entries = [{ id: "t1", superSure: false }, entry("t2", 2, 2)];
  const scene = tvCascadeRevealScene({
    truth: T, entries,
    decoys: [{ id: "t3", lat: 9, lng: 9 }], teams: TEAMS, reducedMotion: false,
  });
  assert.deepEqual(scene.ops.map((o) => o.op), ["chip", "fit"]);
  assert.deepEqual(scene.ops[0],
    { op: "chip", at: { lat: 9, lng: 9 }, className: "decoy-marker reveal", html: "🎭", interactive: false });
  // fit frames only truth + the one guessed pin (the forfeit is excluded)
  assert.deepEqual(scene.ops[1], { op: "fit", points: [T, { lat: 2, lng: 2 }], pad: 0.25, maxZoom: 10 });
});

test("tvCascadeRevealScene: finale is the gold Answer truth pin (tv size 12)", () => {
  const scene = tvCascadeRevealScene({
    truth: T, entries: [entry("t1", 1, 2)], decoys: [], teams: TEAMS, reducedMotion: false,
  });
  assert.deepEqual(scene.finale, [{
    op: "circle", at: T,
    style: { radius: 12, color: "#111", weight: 3, fillColor: "#ffcf3f", fillOpacity: 1 },
    tooltip: { html: "Answer", direction: "top", permanent: true },
  }]);
});

/* ---------------- recapOverviewScene ---------------- */

test("recapOverviewScene: numbered chips + a fit for ≥2 pins", () => {
  const scene = recapOverviewScene({ pins: [
    { n: 1, lat: 10, lng: 20 }, { n: 2, lat: 30, lng: 40 }, { n: 3, lat: 50, lng: 60 },
  ] });
  assert.deepEqual(scene.ops.map((o) => o.op), ["chip", "chip", "chip", "fit"]);
  assert.deepEqual(scene.cascade, []);
  assert.deepEqual(scene.finale, []);
  assert.deepEqual(scene.ops[0],
    { op: "chip", at: { lat: 10, lng: 20 }, className: "recap-pin", html: "1" });
  assert.deepEqual(scene.ops[2],
    { op: "chip", at: { lat: 50, lng: 60 }, className: "recap-pin", html: "3" });
  assert.deepEqual(scene.ops[3], {
    op: "fit",
    points: [{ lat: 10, lng: 20 }, { lat: 30, lng: 40 }, { lat: 50, lng: 60 }],
    pad: 0.25, maxZoom: 10,
  });
});

test("recapOverviewScene: a single pin uses a view, not a fit", () => {
  const scene = recapOverviewScene({ pins: [{ n: 1, lat: 10, lng: 20 }] });
  assert.deepEqual(scene.ops.map((o) => o.op), ["chip", "view"]);
  assert.deepEqual(scene.ops[1], { op: "view", center: { lat: 10, lng: 20 }, zoom: 4 });
});

test("recapOverviewScene: the chip number is our own int (html is the integer)", () => {
  const scene = recapOverviewScene({ pins: [{ n: 5, lat: 1, lng: 2 }] });
  assert.equal(scene.ops[0].html, "5");
});

test("recapOverviewScene: no pins → an empty scene", () => {
  assert.deepEqual(recapOverviewScene({ pins: [] }), { ops: [], cascade: [], finale: [] });
  assert.deepEqual(recapOverviewScene({}), { ops: [], cascade: [], finale: [] });
});

/* ---------------- size table ---------------- */

test("REVEAL_SIZES: phone 8/14/10, tv 10/16/12, tvSolo 12/18/12", () => {
  assert.deepEqual(REVEAL_SIZES, {
    phone: { guess: 8, halo: 14, truth: 10 },
    tv: { guess: 10, halo: 16, truth: 12 },
    tvSolo: { guess: 12, halo: 18, truth: 12 },
  });
});
