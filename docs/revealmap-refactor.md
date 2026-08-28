# The shared reveal-map renderer — `js/revealmap.js` + `js/revealmap-ui.js`

> **STATUS: DESIGN — awaiting owner approval, then an Opus build (one change,
> one commit per surface).** Authored by the architect (Fable) 2026-08-22
> against `3e77c05`. Pure deduplication: the reveal map is currently written
> four times and the copies have already drifted.

## 0. Verified current state (what the builder is deduplicating)

| Surface | File / function | Container | Mode |
|---|---|---|---|
| Daily | `daily-ui.js` `renderRevealMap(guess, ghostRes)` (552–626) | `#dRevealMap` | static; delayed 👻 ghost beat (+400 ms, fade) |
| h2h phone | `player-ui.js` `renderRevealMap(round)` (1928–1988) | `#pRevealMap` | static; all pins + halos + 🎭 decoys |
| Couch TV solo | `screen-ui.js` `renderReveal` (689–766) | `#revealMap` | 1 pin, 1000 ms animated line, truth lands at end |
| Couch TV showdown | `screen-ui.js` `renderShowdownReveal` (805–902) | `#revealMap` | cascade, 800 ms lines, 300 ms gaps |
| h2h TV | `screen-h2h.js` `runRevealAnimation` (587–700) | `#h2hRevealMap` | cascade, 800 ms lines, 300/250 ms gaps, decoys first |

Confirmed drift already present:
- **`teamHex` in two variants**: guarded (`i >= 0 ? … : TEAM_HEX[0]`) in
  `screen-ui.js:60` / `screen-h2h.js:27`, unguarded (`indexOf(id) % 4` →
  `undefined` on a miss) in `player-ui.js:139` / `host-ui.js:114`.
- **`escapeHtml`** (XSS-relevant — Leaflet tooltip content is HTML, team names
  are user input) copied in `screen-ui.js:66`, `screen-h2h.js:31`,
  `host-ui.js:118`.
- **player-ui inlines the super-sure verdict string** (`player-ui.js:1963–64`)
  instead of calling `superSureLabel()` (`supersure.js:92`) — identical text
  today, one copy edit from silently diverging.

Latent bugs the current copies share: the TV cascade closures
(`screen-ui.js:859`, `screen-h2h.js:660`) add layers via the *module-level*
`revealMap` variable, so a mid-cascade re-render bleeds old markers into the
new map; and `screen-ui.js:727` / `screen-h2h.js:614` schedule an unguarded
`revealMap.invalidateSize()` that throws if the map is destroyed within 60 ms.

## 1. Architecture — two files, mirroring `viewer-ui.js` / `imagery.js`

- **`js/revealmap.js`** — pure, no DOM, no Leaflet, no network. Turns round data
  into a declarative **scene**: an ordered list of draw operations plus a cascade
  plan. Everything decision-shaped lives here: colors, radii, dash patterns,
  tooltip text, sizes per surface, ghost delay, animation durations, escaping.
  Unit-tested in `tests/revealmap.test.js`.
- **`js/revealmap-ui.js`** — thin Leaflet glue. One entry point that builds the
  `L.map`, executes a scene op-by-op, drives the line-draw animation with
  `animFraction` + `requestAnimationFrame`, and calls surface hooks at the beats
  where surfaces do DOM/sound work. It contains **zero** decisions: every color,
  radius, string, and delay comes from the scene object.

### The glue API

```js
import { renderRevealScene } from "./revealmap-ui.js";
const handle = renderRevealScene(containerId, scene, hooks?);
// hooks (cascade modes only):
//   onStep({ id, forfeit, index })  — a pin's line just landed (or a forfeit's beat fired)
//   onFinish()                      — the truth marker just landed; surface does its post-reveal
handle.destroy();  // safe to call twice; cancels pending timers/rAF continuations
```

`renderRevealScene` owns, identically to all four copies today:
- `L.map(containerId, LEAFLET_MAP_OPTIONS)` — the frozen interaction-off option
  set (`zoomControl/dragging/scrollWheelZoom/doubleClickZoom/boxZoom/keyboard/
  touchZoom: false`; `attributionControl` defaults on, as today).
- The OSM tile layer (`https://tile.openstreetmap.org/{z}/{x}/{y}.png`,
  `maxZoom: 19`, the exact attribution string).
- `setTimeout(() => map && map.invalidateSize({ pan: false }), 60)` after fit.
- Teardown: `try { map.remove() } catch { /* already gone */ }`.

Surfaces keep: their own handle variable, their render-once latches
(`revealMapShownFor`, `revealShownForRound`), all off-map DOM (boards, rows,
place name, stat tiles), all fx (`playSound`, `stampFlash`, count-up), and all
*ordering policy* (who computes `revealOrder` / showdown order — the WHEN and
WHAT per the hidden-until-reveal rule).

## 2. The scene schema (what `revealmap.js` emits, what the glue executes)

```js
{
  ops: [Op, ...],          // executed synchronously, in order
  cascade: [Step, ...],    // [] for daily/phone; run after ops
  finale: [Op, ...],       // cascade modes: added when the cascade completes
}                          //   (the truth marker + "Answer"), then onFinish()
```

Op variants (each carries a full, literal Leaflet options object so tests pin
exact bytes):
- `{ op: "fit", points: [{lat,lng},...], pad: 0.25, maxZoom: 10 }`
- `{ op: "view", center: {lat,lng}, zoom: 4 }` — daily's no-guess fallback
- `{ op: "line", from, to, style: {color, weight, dashArray} }` — static polyline
- `{ op: "circle", at, style: {radius, color, weight, fillColor?, fillOpacity?, fill?, dashArray?, interactive?}, tooltip?: {html, direction, permanent: true, className?} }`
- `{ op: "chip", at, className, html }` — `L.marker` with `L.divIcon`, `interactive: false` (👻 chip, 🎭 decoys)
- `{ op: "delayedGroup", delayMs, fade, ops: [...] }` — glue schedules
  `setTimeout(delayMs)`, no-ops if the handle was destroyed, and when `fade` is
  true applies the exact opacity-0 → double-`requestAnimationFrame` → opacity-1,
  `transition: opacity 350ms ease` technique from `daily-ui.js:595–605`.

Cascade Step: `{ id, forfeit: bool, ops: [circle ops + optional halo], line: {from, to, style, durationMs} | null, afterDelayMs }`. Glue per step: add `ops`;
animate `line` (rAF + `animFraction`, `setLatLngs` interpolation); on landing
call `onStep`, then `setTimeout(next, afterDelayMs)`. Forfeit steps (no ops, no
line) call `onStep` immediately then wait `afterDelayMs`. z-order note: `chip`
markers live in Leaflet's marker pane, always above vector layers, so
decoys-before-pins vs after pins paint identically — builders still emit today's
per-surface order.

## 3. Pure builders — exact signatures and values

`js/revealmap.js` exports (importing only pure modules: `superSureLabel` from
`supersure.js`, `formatDistance` from `game.js`, `motionDuration` from `fx.js`,
`teamIds` from `game.js`):

```js
export const TEAM_HEX = ["#ffcf3f", "#4dd6ff", "#ff6ec7", "#7dff8a"];
export function teamHex(teams, id)      // guarded variant (miss → TEAM_HEX[0])
export function escapeHtml(s)           // the /[&<>"']/ charCode variant, verbatim
export const REVEAL_SIZES = {
  phone:  { guess: 8,  halo: 14, truth: 10 },   // daily + player
  tv:     { guess: 10, halo: 16, truth: 12 },   // showdown + h2h cascade
  tvSolo: { guess: 12, halo: 18, truth: 12 },
};
export function dailyRevealScene({ truth, guess, ghost, reducedMotion })
export function phoneRevealScene({ truth, pins, decoys, teams })
export function tvSoloRevealScene({ truth, guess, score, reducedMotion })
export function tvCascadeRevealScene({ truth, entries, decoys, teams, reducedMotion })
```

Style atoms every builder shares (assert as exported constants so tests pin):
- Truth pin: `{radius: SIZES.truth, color:"#111", weight:3, fillColor:"#ffcf3f", fillOpacity:1}`; on TV it carries tooltip `{html:"Answer", direction:"top", permanent:true}` and sits in `finale`.
- Guess pin: `{radius: SIZES.guess, color:"#fff", weight:2|3, fillColor:<color>, fillOpacity:1}` — weight 2 on phone/daily, 3 on TV.
- Super-sure halo: `{radius: SIZES.halo, color:"#ffcf3f", weight:3, fill:false, dashArray:"4 6", interactive:false}` + tooltip `{html: superSureLabel(entry), direction:"bottom", permanent:true, className:"ss-tooltip"}`.
- Static guess line: `{color: <teamHex>, weight:3, dashArray:"6 8"}`; animated cascade line: `{color: <teamHex>, weight:4, dashArray:"8 10"}`.
- Ghost (daily only): line `{color:"#c9a2ff", weight:2, dashArray:"3 5"}`, circle `{radius:8, color:"#c9a2ff", weight:2, dashArray:"3 3", fillColor:"#2a2140", fillOpacity:0.85}`, chip `{className:"ghost-chip", html:"👻 "+formatDistance(distanceKm)}`, in `delayedGroup {delayMs: reducedMotion?0:400, fade:!reducedMotion}`. The ghost pin is included in fit points.
- Decoy: `{op:"chip", className:"decoy-marker reveal", html:"🎭"}`.
- Durations: `motionDuration(1000, reducedMotion)` solo, `motionDuration(800, reducedMotion)` cascade; `afterDelayMs` 300 (pin) / 250 (forfeit).

Builder specifics:
- `dailyRevealScene`: `guess` may be null → `ops` end with `{op:"view", center:truth, zoom:4}`; else `{op:"fit"}` over `[truth, guess, ghost?.pin]`. Cascade empty.
- `phoneRevealScene`: `pins` is `revealPins(round)` output verbatim; per pin emit `[line, circle, halo?]` with `teamHex(teams,id)`, halo label via `superSureLabel(pin)`. Fit first, decoys after the pin loop, truth last, no tooltips on pins.
- `tvSoloRevealScene`: guess pin with tooltip `"Guess"` (top) + halo if `score.superSure`; cascade = one step `{id:null, forfeit:false, ops:[], line:{color:"#ffcf3f", durationMs:motionDuration(1000)}, afterDelayMs:0}`; finale = truth + `"Answer"`.
- `tvCascadeRevealScene`: `entries` in the surface-chosen order (builder must NOT re-sort). Per guessed entry: step ops = name pin (`tooltip {html: escapeHtml(teams[id].name), direction:"top"}`) + halo if `entry.superSure`, line in `teamHex`, `afterDelayMs:300`. Forfeit entry: `{forfeit:true, ops:[], line:null, afterDelayMs:250}`. `ops` prelude = decoy chips + fit over `[truth, ...guessed]` (forfeits excluded). Finale = truth + `"Answer"`.

## 4. Test matrix

`tests/revealmap.test.js` (pure — the drift-proofing layer):
- `teamHex`: 4 known ids → 4 hexes; 5th team cycles; unknown id → `TEAM_HEX[0]`.
- `escapeHtml`: each of `& < > " '` escaped; `<img src=x onerror=…>` team name
  round-trips inert; plain text untouched.
- `dailyRevealScene`: op order `[line, guessPin, delayedGroup, fit, truthPin]`
  with guess+ghost; no-guess → `[view(truth,4), truthPin]`; ghost `delayMs` 400 vs
  0 / `fade` under `reducedMotion`; chip html exactly `👻 `+`formatDistance(km)`;
  fit includes the ghost pin; exact style objects (deep-equal).
- `phoneRevealScene`: per-pin triplet `[line, circle, halo?]`; halo only when
  `superSure`; halo labels match `superSureLabel` for both outcomes; decoys after
  pins, truth last; phone sizes 8/14/10; fit = truth + all pins.
- `tvSoloRevealScene`: `"Guess"`/`"Answer"` tooltip text + directions; halo r18 iff
  `score.superSure`; `durationMs` 1000 → 0 under reduced motion; solo sizes
  12/18/12; line `#ffcf3f`.
- `tvCascadeRevealScene`: entry order preserved (no re-sort); forfeit step shape;
  guessed step `afterDelayMs:300`; tooltip name escaped (hostile-name case); halo
  iff `superSure` with `superSureLabel`; decoys in prelude; fit excludes forfeits;
  finale = truth + `"Answer"`; tv sizes 10/16/12.
- Constants: `LEAFLET_MAP_OPTIONS`, tile URL + attribution, every style atom
  deep-equals the literal values from today's four files (copy from the current
  source, not this spec, when writing the assertions).

`tests/revealmap-ui.test.js` (glue — mirror the `viewer-ui.test.js` fake-`L`
precedent with a ~60-line fake `L`): ops execute in order; `bindTooltip` after
`addTo`; cascade fires `onStep` per step then `onFinish` after finale; forfeit
beats skip drawing; `destroy()` before a `delayedGroup` fires → group no-ops;
`destroy()` mid-cascade → no further work; the 60 ms `invalidateSize` guarded
post-destroy; `destroy()` twice doesn't throw.

## 5. Per-surface adoption (each collapses to: build inputs → pick builder → render → hooks)

- **`daily-ui.js`**: `renderRevealMap` becomes ~6 lines:
  `handle = renderRevealScene("dRevealMap", dailyRevealScene({truth: current,
  guess, ghost: ghostRes?.pin ? {pin: ghostRes.pin, distanceKm: ghostRes.distanceKm} : null, reducedMotion: prefersReducedMotion()}))`.
  `destroyRevealMap` → `handle?.destroy()`. No hooks. Deletes ~70 lines.
- **`player-ui.js`**: keep the `revealMapShownFor` latch + truth guard; body
  becomes `phoneRevealScene({truth: round.truth, pins: revealPins(round), decoys: revealDecoys(round), teams: room.teams})`. Delete local `TEAM_HEX`/`teamHex`, import from `revealmap.js` (other call sites take the shared guarded variant). Deletes ~55 lines.
- **`screen-h2h.js`**: `runRevealAnimation` keeps place-name prep, totals board,
  row builder, `order`/`closestId`; the map block becomes `tvCascadeRevealScene({truth: round.truth, entries: order, decoys: revealDecoys(round), teams: state.teams, reducedMotion: prefersReducedMotion()})` with `onStep: ({index}) => addRow(order[index])`, `onFinish` = today's `finish()` minus the truth-marker lines. Delete local `teamHex`/`escapeHtml`. Deletes ~80 lines.
- **`screen-ui.js`**: solo → `tvSoloRevealScene({truth: round.truth, guess: round.guess, score: round.score, reducedMotion})`, `onFinish` = place pop, sting, `countUpPoints`, ACE. Showdown → `tvCascadeRevealScene({entries: order.map(id=>({id,...results[id]})), decoys:[], …})`, `onStep` builds the row, `onFinish` = crown + ACE. Delete local `TEAM_HEX`/`teamHex`/`escapeHtml`. Deletes ~120 lines.

Net: ~330 duplicated lines → ~150-line glue module + ~200-line pure module, and
the XSS-relevant escaping drops from 3 copies to 1.

## 6. Replay masking + analytics

- **Masking**: no new DOM outside `.leaflet-container`. Since the
  2026-08-28 owner decision maps are replay-visible, so nothing here needs
  `blockSelector`; any new reveal label that carries a team name or room
  code still needs `data-ph-mask`. Add a line to `docs/replay-mask-checklist.md` §maps
  noting the four reveal maps are now rendered by `js/revealmap-ui.js` and any
  new reveal label must be added as a scene op, then re-run the doc's
  verify-on-a-real-recording step.
- **Analytics**: **no new events** (byte-identical dedup; no new decision point;
  no current renderer has a `track()` call). No schema change → no
  `BANNED_KEY_RE` exposure. `revealmap-ui.js` must import nothing from
  `consent.js`/`analytics.js`.

## 7. Hidden-until-reveal

The shared module is invoked only from the four existing reveal call sites, each
already behind its surface's reveal-phase gate + render-once latch.
`revealmap.js` takes post-reveal data as arguments and never reads room state
itself, so it cannot be wired into an in-play path by accident. The
super-sure/decoy reveal-only invariants live in one place instead of four.

## 8. Deliberate divergences (the only three; everything else byte-identical, tested)

1. `teamHex` unifies on the **guarded** variant (safer; output-identical for every
   reachable reveal input).
2. **Post-destroy continuations no-op** (fixes a latent cascade race + the
   unguarded 60 ms `invalidateSize`; unreachable in normal flow).
3. player-ui's inline super-sure ternary becomes `superSureLabel()` (identical
   strings today).

## 9. Explicitly out of scope

- `host-ui.js` — the couch *guess* map + its `teamHex`/`escapeHtml` copies (a
  reasonable follow-up import swap, not this change).
- `couchscreen.js` live-pin panels, player-ui's live guess map, daily's guess map.
- Any change to animation timings, colors, sounds, copy, CSS, HTML, or reveal
  ordering policy. New analytics events. Ghost-Duel payload handling.
