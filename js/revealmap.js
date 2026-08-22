// revealmap.js — pure scene builder for the shared reveal map (design
// docs/revealmap-refactor.md). No DOM, no Leaflet, no network — same
// discipline as game.js / imagery.js. The reveal map is drawn on four
// surfaces (Daily, the h2h phone, the couch TV solo + showdown, the h2h TV);
// this module turns post-reveal round data into a declarative SCENE that
// js/revealmap-ui.js executes op-by-op. Every decision-shaped value — colors,
// radii, dash patterns, tooltip text, sizes, ghost delay, animation
// durations, HTML escaping — lives here and is unit-tested, so the four
// copies can no longer drift.
//
// A scene is:
//   { ops: [Op, ...], cascade: [Step, ...], finale: [Op, ...] }
// ops run synchronously in order; cascade (TV line-draws) runs after; finale
// (the truth marker + "Answer") is added when the cascade completes. Static
// surfaces (Daily / phone) carry an empty cascade and finale — their truth
// marker is a plain op.

import { superSureLabel } from "./supersure.js";
import { formatDistance, teamIds } from "./game.js";
import { motionDuration } from "./fx.js";

// The four team colors as concrete hex — Leaflet paints SVG markers with
// these (CSS var() strings don't resolve inside SVG presentation attrs).
export const TEAM_HEX = ["#ffcf3f", "#4dd6ff", "#ff6ec7", "#7dff8a"];

// Guarded team color: an unknown/absent id falls back to TEAM_HEX[0] rather
// than `undefined` (the safer of the two variants the copies had drifted to).
export function teamHex(teams, id) {
  const i = teamIds(teams).indexOf(id);
  return i >= 0 ? TEAM_HEX[i % TEAM_HEX.length] : TEAM_HEX[0];
}

// Leaflet tooltip content is HTML; team names are user input. The charCode
// variant, verbatim from the couch/h2h TV copies.
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Marker radii per surface family: phone (Daily + h2h phone), tv (showdown +
// h2h cascade), tvSolo (couch solo).
export const REVEAL_SIZES = {
  phone: { guess: 8, halo: 14, truth: 10 },
  tv: { guess: 10, halo: 16, truth: 12 },
  tvSolo: { guess: 12, halo: 18, truth: 12 },
};

// The frozen interaction-off Leaflet map options, identical on all four
// surfaces. attributionControl is omitted, so it defaults on (as today).
export const LEAFLET_MAP_OPTIONS = Object.freeze({
  zoomControl: false, dragging: false, scrollWheelZoom: false,
  doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false,
});

export const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
export const TILE_OPTIONS = Object.freeze({
  maxZoom: 19, attribution: TILE_ATTRIBUTION,
});

/* ================================================================
 * Shared op builders — the style atoms every surface draws from.
 * ================================================================ */

const pt = (p) => ({ lat: p.lat, lng: p.lng });

// The gold answer pin. `tooltip` null on Daily/phone; "Answer" on the TV.
function truthCircle(at, radius, tooltip) {
  const op = {
    op: "circle", at,
    style: { radius, color: "#111", weight: 3, fillColor: "#ffcf3f", fillOpacity: 1 },
  };
  if (tooltip) op.tooltip = tooltip;
  return op;
}

// The SUPER SURE verdict halo (dashed ring + label). Reveal-only.
function haloCircle(at, radius, label) {
  return {
    op: "circle", at,
    style: {
      radius, color: "#ffcf3f", weight: 3, fill: false,
      dashArray: "4 6", interactive: false,
    },
    tooltip: { html: label, direction: "bottom", permanent: true, className: "ss-tooltip" },
  };
}

// A planted G7 decoy 🎭 — muted, non-interactive, no line.
function decoyChip(at) {
  return { op: "chip", at, className: "decoy-marker reveal", html: "🎭", interactive: false };
}

/* ================================================================
 * Daily — static: guess pin + guess→truth line, a delayed 👻 ghost beat,
 * then the truth. `guess` may be null (a round the player never pinned).
 * ================================================================ */

export function dailyRevealScene({ truth, guess, ghost, reducedMotion }) {
  const t = pt(truth);
  const ops = [];
  const points = [t];
  if (guess) {
    const g = pt(guess);
    ops.push({ op: "line", from: g, to: t, style: { color: "#4dd6ff", weight: 3, dashArray: "6 8" } });
    ops.push({ op: "circle", at: g, style: { radius: REVEAL_SIZES.phone.guess, color: "#fff", weight: 2, fillColor: "#4dd6ff", fillOpacity: 1 } });
    points.push(g);
  }
  if (ghost && ghost.pin) {
    const gp = pt(ghost.pin);
    ops.push({
      op: "delayedGroup",
      delayMs: reducedMotion ? 0 : 400,
      fade: !reducedMotion,
      ops: [
        { op: "line", from: gp, to: t, style: { color: "#c9a2ff", weight: 2, dashArray: "3 5" } },
        { op: "circle", at: gp, style: { radius: 8, color: "#c9a2ff", weight: 2, dashArray: "3 3", fillColor: "#2a2140", fillOpacity: 0.85 } },
        { op: "chip", at: gp, className: "ghost-chip", html: `👻 ${formatDistance(ghost.distanceKm)}` },
      ],
    });
    points.push(gp);
  }
  if (points.length > 1) ops.push({ op: "fit", points, pad: 0.25, maxZoom: 10 });
  else ops.push({ op: "view", center: t, zoom: 4 });
  ops.push(truthCircle(t, REVEAL_SIZES.phone.truth, null));
  return { ops, cascade: [], finale: [] };
}

/* ================================================================
 * h2h phone — static: every guess pin + line + optional SUPER SURE halo,
 * then decoys, then the truth. `pins` is revealPins(round) verbatim.
 * ================================================================ */

export function phoneRevealScene({ truth, pins, decoys, teams }) {
  const t = pt(truth);
  const ops = [{ op: "fit", points: [t, ...pins.map(pt)], pad: 0.25, maxZoom: 10 }];
  for (const p of pins) {
    const at = pt(p);
    const color = teamHex(teams, p.id);
    ops.push({ op: "line", from: at, to: t, style: { color, weight: 3, dashArray: "6 8" } });
    ops.push({ op: "circle", at, style: { radius: REVEAL_SIZES.phone.guess, color: "#fff", weight: 2, fillColor: color, fillOpacity: 1 } });
    if (p.superSure) ops.push(haloCircle(at, REVEAL_SIZES.phone.halo, superSureLabel(p)));
  }
  for (const d of decoys) ops.push(decoyChip(pt(d)));
  ops.push(truthCircle(t, REVEAL_SIZES.phone.truth, null));
  return { ops, cascade: [], finale: [] };
}

/* ================================================================
 * Couch TV solo — one grey guess pin (tooltip "Guess"), an optional halo,
 * then a ~1s animated line to the gold truth ("Answer").
 * ================================================================ */

export function tvSoloRevealScene({ truth, guess, score, reducedMotion }) {
  const t = pt(truth);
  const g = pt(guess);
  const ops = [{
    op: "circle", at: g,
    style: { radius: REVEAL_SIZES.tvSolo.guess, color: "#fff", weight: 3, fillColor: "#555", fillOpacity: 1 },
    tooltip: { html: "Guess", direction: "top", permanent: true },
  }];
  if (score && score.superSure) ops.push(haloCircle(g, REVEAL_SIZES.tvSolo.halo, superSureLabel(score)));
  ops.push({ op: "fit", points: [t, g], pad: 0.25, maxZoom: 10 });
  const cascade = [{
    id: null, forfeit: false, ops: [],
    line: { from: g, to: t, style: { color: "#ffcf3f", weight: 4, dashArray: "8 10" }, durationMs: motionDuration(1000, reducedMotion) },
    afterDelayMs: 0,
  }];
  const finale = [truthCircle(t, REVEAL_SIZES.tvSolo.truth, { html: "Answer", direction: "top", permanent: true })];
  return { ops, cascade, finale };
}

/* ================================================================
 * TV cascade — the showdown + h2h reveal: decoys, then a fit, then one
 * animated line per entry (in the surface-chosen order — this builder never
 * re-sorts), forfeits leading with no line, then the gold truth ("Answer").
 * ================================================================ */

export function tvCascadeRevealScene({ truth, entries, decoys, teams, reducedMotion }) {
  const t = pt(truth);
  const guessed = entries.filter((e) => e.guess);
  const ops = [];
  for (const d of decoys) ops.push(decoyChip(pt(d)));
  ops.push({ op: "fit", points: [t, ...guessed.map((e) => pt(e.guess))], pad: 0.25, maxZoom: 10 });
  const cascade = entries.map((e) => {
    if (!e.guess) return { id: e.id, forfeit: true, ops: [], line: null, afterDelayMs: 250 };
    const at = pt(e.guess);
    const color = teamHex(teams, e.id);
    const stepOps = [{
      op: "circle", at,
      style: { radius: REVEAL_SIZES.tv.guess, color: "#fff", weight: 3, fillColor: color, fillOpacity: 1 },
      tooltip: { html: escapeHtml(teams[e.id].name), direction: "top", permanent: true },
    }];
    if (e.superSure) stepOps.push(haloCircle(at, REVEAL_SIZES.tv.halo, superSureLabel(e)));
    return {
      id: e.id, forfeit: false, ops: stepOps,
      line: { from: at, to: t, style: { color, weight: 4, dashArray: "8 10" }, durationMs: motionDuration(800, reducedMotion) },
      afterDelayMs: 300,
    };
  });
  const finale = [truthCircle(t, REVEAL_SIZES.tv.truth, { html: "Answer", direction: "top", permanent: true })];
  return { ops, cascade, finale };
}

/* ================================================================
 * Daily recap overview — a static at-a-glance mini-map: one numbered chip
 * per round (1..N), then a fit (≥2 pins) or a single view (1 pin). `n` is
 * our own integer, so the chip html carries no user text to escape. Empty
 * pins → an empty scene. The daily-ui glue queries `.recap-pin` after render
 * to wire tap → jump-to-card. Blocked in replay like every reveal map.
 * ================================================================ */

export function recapOverviewScene({ pins } = {}) {
  const ps = Array.isArray(pins) ? pins : [];
  const ops = [];
  const points = [];
  for (const p of ps) {
    const at = { lat: p.lat, lng: p.lng };
    ops.push({ op: "chip", at, className: "recap-pin", html: `${p.n}` });
    points.push(at);
  }
  if (points.length >= 2) ops.push({ op: "fit", points, pad: 0.25, maxZoom: 10 });
  else if (points.length === 1) ops.push({ op: "view", center: points[0], zoom: 4 });
  return { ops, cascade: [], finale: [] };
}
