// revealmap-ui.js — thin Leaflet glue for the shared reveal map
// (docs/revealmap-refactor.md §1). Mirrors viewer-ui.js / imagery.js: every
// DECISION lives in the pure js/revealmap.js scene; this module only executes
// it. It builds the L.map, runs the scene's ops in order, drives the cascade's
// line-draw animation (rAF + animFraction), fires the surface's hooks at the
// beats where surfaces do DOM/sound work, and tears everything down safely.
//
// It contains zero product decisions — every color, radius, string, delay and
// duration comes from the scene object — and imports nothing from
// consent.js/analytics.js (the reveal renderer captures nothing).

import { LEAFLET_MAP_OPTIONS, TILE_URL, TILE_OPTIONS } from "./revealmap.js";
import { animFraction } from "./fx.js";

// Leaflet is a page global (loaded via the pinned <script> tag, like the
// four source copies). Read it lazily so the module imports cleanly in Node.
const leaflet = () => globalThis.L;

/**
 * Render a scene into `containerId`, returning a handle with `destroy()`.
 * hooks (cascade modes only):
 *   onStep({ id, forfeit, index })  a pin's line landed / a forfeit beat fired
 *   onFinish()                      the truth marker landed; do the post-reveal
 * destroy() is safe to call twice; it cancels every pending timer/rAF.
 */
export function renderRevealScene(containerId, scene, hooks = {}) {
  const L = leaflet();
  let map = L.map(containerId, LEAFLET_MAP_OPTIONS);
  L.tileLayer(TILE_URL, TILE_OPTIONS).addTo(map);

  let destroyed = false;
  const timers = new Set();
  const rafs = new Set();
  const later = (fn, ms) => {
    const id = setTimeout(() => { timers.delete(id); if (!destroyed) fn(); }, ms);
    timers.add(id);
    return id;
  };
  const raf = (fn) => {
    const id = requestAnimationFrame((t) => { rafs.delete(id); if (!destroyed) fn(t); });
    rafs.add(id);
    return id;
  };

  const ll = (p) => L.latLng(p.lat, p.lng);

  // Execute one op; return the created Leaflet layer (or null for fit/view).
  function runOp(op) {
    switch (op.op) {
      case "fit":
        map.fitBounds(L.latLngBounds(op.points.map(ll)).pad(op.pad), { maxZoom: op.maxZoom });
        return null;
      case "view":
        map.setView(ll(op.center), op.zoom);
        return null;
      case "line":
        return L.polyline([ll(op.from), ll(op.to)], op.style).addTo(map);
      case "circle": {
        const c = L.circleMarker(ll(op.at), op.style).addTo(map);
        if (op.tooltip) c.bindTooltip(op.tooltip.html, tooltipOpts(op.tooltip));
        return c;
      }
      case "chip": {
        const opts = { icon: L.divIcon({ className: op.className, html: op.html }) };
        // Preserve the source difference: decoys are interactive:false, the
        // ghost chip is not (it omits the option entirely).
        if (op.interactive === false) opts.interactive = false;
        return L.marker(ll(op.at), opts).addTo(map);
      }
      case "delayedGroup":
        runDelayedGroup(op);
        return null;
      default:
        return null;
    }
  }

  function tooltipOpts(t) {
    const o = { permanent: t.permanent, direction: t.direction };
    if (t.className) o.className = t.className;
    return o;
  }

  // A delayed batch (the daily 👻 ghost beat). delayMs 0 runs synchronously so
  // the group paints in its declared op position (reduced motion, matching the
  // source's synchronous addGhost()); a positive delay schedules it. `fade`
  // applies the opacity-0 → double-rAF → opacity-1 technique to the group's
  // circle/chip layers (never the line), exactly as daily-ui did.
  function runDelayedGroup(group) {
    const run = () => {
      const faded = [];
      for (const op of group.ops) {
        const layer = runOp(op);
        if (group.fade && layer && (op.op === "circle" || op.op === "chip")) faded.push(layer);
      }
      if (!group.fade || !faded.length) return;
      const els = faded.map((l) => l.getElement && l.getElement()).filter(Boolean);
      for (const el of els) { el.style.opacity = "0"; el.style.transition = "opacity 350ms ease"; }
      raf(() => raf(() => { for (const el of els) el.style.opacity = "1"; }));
    };
    if (group.delayMs > 0) later(run, group.delayMs);
    else run();
  }

  // The cascade: one animated line per step (forfeits are a bare beat), then
  // the finale ops and onFinish(). Every continuation no-ops after destroy().
  function runCascade(steps, finale) {
    let i = 0;
    const next = () => {
      if (destroyed) return;
      if (i >= steps.length) {
        for (const op of finale) runOp(op);
        if (hooks.onFinish) hooks.onFinish();
        return;
      }
      const step = steps[i];
      const index = i;
      i += 1;
      if (!step.line) {
        if (hooks.onStep) hooks.onStep({ id: step.id, forfeit: step.forfeit, index });
        later(next, step.afterDelayMs);
        return;
      }
      for (const op of step.ops) runOp(op);
      const from = ll(step.line.from);
      const to = ll(step.line.to);
      const line = L.polyline([from], step.line.style).addTo(map);
      const dur = step.line.durationMs;
      let start = null;
      const frame = (t) => {
        if (start === null) start = t;
        const eased = animFraction(t - start, dur);
        line.setLatLngs([
          from,
          L.latLng(from.lat + (to.lat - from.lat) * eased, from.lng + (to.lng - from.lng) * eased),
        ]);
        if (eased < 1) { raf(frame); return; }
        if (hooks.onStep) hooks.onStep({ id: step.id, forfeit: false, index });
        later(next, step.afterDelayMs);
      };
      raf(frame);
    };
    next();
  }

  for (const op of scene.ops) runOp(op);
  // Leaflet needs a nudge once the container has its final size. Guarded
  // post-destroy (the source copies scheduled this unguarded).
  later(() => { if (map) map.invalidateSize({ pan: false }); }, 60);
  if (scene.cascade && scene.cascade.length) runCascade(scene.cascade, scene.finale || []);

  return {
    destroy() {
      destroyed = true;
      for (const id of timers) clearTimeout(id);
      timers.clear();
      for (const id of rafs) cancelAnimationFrame(id);
      rafs.clear();
      if (map) {
        try { map.remove(); } catch { /* already gone */ }
        map = null;
      }
    },
  };
}
