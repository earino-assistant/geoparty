# iOS Daily black-pano — diagnosis + fix design (Fable review)

**Author:** Fable (design/EM seat) · **Date:** 2026-08-28
**Baseline:** repo `99df25d` (the served release) + the verified PostHog brief
(`.brief-fable-ios-daily-blackout.md`, Yichen's queries of 2026-08-28).
**Status:** design only — no source edits. Build is a follow-up task.

The incident: Chrome iOS 151, Daily round 3. `imagery_load ok:true, 987ms`,
then a fully black pano with the HUD alive, zero exceptions, zero
`webgl_context_lost`, network healthy. The failure is invisible to every
signal we ship today.

---

## 0. Corrections to the brief (verified against `99df25d`)

Three claims in the brief needed checking before designing on top of them:

1. **"Daily destroys/rebuilds viewers per round" is wrong.** `startRound()`
   only constructs a viewer when none exists (`if (!iv) makeViewer()`,
   daily-ui.js:341); `destroyViewer()` (daily-ui.js:389) runs only at
   `finishRun()`, on a hard-mode restart, and on the stub-viewer degraded
   path. One viewer serves all five rounds. Her timeline confirms it:
   exactly one `viewer_init` (09:11:47) for three rounds of play. This
   demotes hypothesis (b) — the destroy/create churn it postulates does not
   exist on this page.

2. **"Attach webglcontextlost at the container level" cannot work.**
   `webglcontextlost` fires on the canvas and **does not bubble**. The only
   viable fix is re-querying the canvas and re-binding per canvas (see §4).

3. **The `imagery.js:405` "stub/dispose race" note** is about the
   `setFilter()` promise rejecting when edge recovery races a teardown — it
   is bounded by the `edgeRecovery !== state` guards in viewer-ui.js and
   cannot black a canvas. Not a candidate mechanism.

One reading the brief leaves open, worth settling: **the post-reload silence
(09:17:09 pageview, then no `viewer_init`) is most likely abandonment, not a
second failure.** A mid-run Daily reload loses all run state (the run is
memory-only until completion), so she landed back on the intro screen facing
a full replay of rounds 1–2. `viewer_init` only fires after tapping "Play
Today's Daily" and a successful pool load. No event we ship distinguishes
"never tapped" from "tapped and pool load silently failed" (the
`startChallenge` catch is eventless — gap G4, §4), but "gave up at the
intro" is the parsimonious read — and it means a **reload does not even
recover this failure cheaply**, which raises the value of in-place recovery
(§3).

---

## 1. Ranked root-cause hypotheses

### H1 (leading, ~70%): WebKit GPU-process death / GPU resource eviction, with no `webglcontextlost` delivered

Chrome on iOS is a WebKit/WKWebView shell (caveat noted below). WebKit runs
page JS in the WebContent process and all GPU work — including every WebGL
canvas — in a separate GPU process. Under memory pressure iOS jetsams or
recycles the GPU process; the page's JS keeps running untouched, and the
canvas's backing IOSurface is zeroed or partially evicted. WebKit is
**unreliable about delivering `webglcontextlost`** in this path — the event
may arrive late (e.g. on the next foreground transition) or never.

Fit to the evidence — this is the only hypothesis that fits **every** datum:

- **Silent by construction.** No JS exception (nothing threw — the JS
  process is fine), no `webglcontextlost` (WebKit didn't deliver it), and
  `imagery_load ok:true` (the SDK's `moveTo` settles on the graph/network
  layer, which lives in JS — "loaded" has never meant "painted").
- **HUD alive, canvas black.** Only GPU-process-owned surfaces died; the
  DOM (timer, arrows chrome, buttons) is WebContent-rendered.
- **The cream fragment.** A single surviving texture tile floating in black
  is the signature of *partial* GPU resource eviction — most textures gone,
  one still resident/stale in the compositor.
- **The broken-image glyph.** A DOM `<img>` that fails to (re)decode under
  memory pressure renders the broken glyph even with a healthy network —
  iOS evicts decoded image buffers under the same pressure. A second,
  independent memory-pressure fingerprint in the same screenshot.
- **Timing.** Round 3, ~2 minutes in, is when this session's GPU footprint
  peaks: three rounds of pano texture sets on one long-lived viewer (the
  SDK caches textures/meshes for the nav graph), a Leaflet tile map opened
  at least twice, session replay (rrweb) buffering, 84+ pointer-downs of
  continuous repaint — on a 375pt-wide (older, smaller-RAM) iPhone.
- **JS demonstrably alive after the death:** `$web_vitals` at 09:14:54,
  autocapture flowing until the reload.
- **Cohort shape.** Chrome iOS 151 worst (1/8 completions) vs Mobile Safari
  (4/6): the Chrome shell adds its own memory overhead on top of the same
  WebKit, and its user base skews toward the same devices Safari serves
  with more headroom. Small n, but the gradient points the same way.
- **Same phone fine on Aug 21** does not contradict — memory pressure is a
  condition of the moment (other apps, tabs, thermal state), not the device.

Caveat: if Chrome iOS 151 in the EU has moved to Blink under the DMA
browser-engine allowance, the mechanism has a direct analog (Chrome GPU
process crash) but Blink is *much* more reliable about firing
`webglcontextlost` — which would shift weight toward H2. The detection
design below (poll `isContextLost()` rather than trust the event) is
deliberately robust to either engine. Worth one query: PostHog `$browser`
version cuts don't record the engine; the recording's user agent might.

### H2 (~20%): the context WAS lost and an event fired, but our listener missed it

The instrumented gap the brief flags: `attachCanvas()` binds to the canvas
found at t0 / t0+1.5s (viewer-ui.js:572–580) and never again.

Fit: produces the identical silent outcome; cheap to close regardless.

Against, at `99df25d` on this page:

- MapillaryJS 4.1.2 creates its render canvas once per `Viewer` and does
  not replace it across `moveTo` calls (verify against the pinned bundle —
  §7 checklist). One viewer lived the whole session, so the canvas at
  t0+1.5s was almost certainly *the* canvas — her round-1 image was already
  painted at t0+2s, so the canvas existed inside the attach window.
- If the listener was correctly bound and the event fired, we would have
  the issue: she had consent, a fresh exception budget, and
  `webgl_context_lost` is not deduped.

Residual sub-risk that keeps H2 alive: `el.querySelector("canvas")` takes
the **first** canvas in the container. If 4.1.2 renders any auxiliary canvas
ahead of the WebGL one in DOM order, we bound the wrong element from day
one and every historical "no context-lost event" datum is unreliable.
Verification step §7-V2; the §4 fix (re-query per load, bind by actual
WebGL-context-holding canvas) closes it either way.

### H3 (~10%): MapillaryJS internal render-loop death on the round-2→3 transition

The SDK's RAF loop or an RxJS render subscription dies (an error swallowed
inside the SDK), possibly aggravated by round-2's edge-recovery
`setFilter()` racing the round-3 anchor `moveTo` (her window: `pano_session`
round 2 at 09:13:37.566 → `imagery_load` ok 09:13:38.557).

Against:

- The brief's churn premise is wrong (§0.1) — there is no per-round
  destroy/create on Daily, so the postulated stress pattern doesn't exist.
- The round-1→2 transition (09:12:42→43) had the same ~1s shape and was
  healthy.
- A dead render loop **freezes the last presented frame**; it does not
  blacken the canvas or evict single textures. The screenshot shows black +
  one fragment — an eviction signature, not a freeze. (The narrow variant
  "SDK cleared for the new image, then died before drawing" would show
  clean black, but not the floating fragment or the broken `<img>` glyph.)
- An error escaping an RxJS subscription in the SDK re-throws async →
  `window.onerror` → `$exception`. She had zero.

The recovery design (§3) handles H3 anyway: a full viewer rebuild resets
the SDK's render loop no matter why it died.

### Ruled out: the round-transition cover stuck down

The cover lifts synchronously in the same tick that resolves `moveTo` and
emits `imagery_load ok` (viewer-ui.js:783–789) — and the screenshot shows
SDK chrome that lives *inside* the container rendering above where the
cover would sit. The cover lifted; what it revealed was a dead canvas. The
cover interplay is real but as an **amplifier**: it guarantees that
paint-death after a "successful" load presents as pure black rather than a
stale-but-recognizable previous pano.

---

## 2. Detection design — the render-death probe

Goal: make this class LOUD, with a false-positive rate low enough that the
recovery path (§3) can trust a "dead" verdict enough to destroy a viewer.

### 2.1 The trap in the brief's proposal, and the primary signal

The brief proposes sampling canvas pixels / `gl.readPixels` 1–2s after
`imagery_load ok`. **A naive pixel read is wrong on healthy devices:**
MapillaryJS 4.x renders via three.js, whose `WebGLRenderer` defaults to
`preserveDrawingBuffer: false` — the drawing buffer is cleared after every
composite, so a read performed outside the frame that rendered it returns
transparent black **on a perfectly healthy canvas**. A probe built on
pixels alone would fire `render_dead` on working phones and trigger
destructive rebuilds. (Verification step §7-V3 confirms the flag in the
pinned bundle before anyone "simplifies" the probe.)

The reliable, cheap, synchronous primary signal is **`gl.isContextLost()`**
on the SDK's own context:

- `canvas.getContext("webgl2") || canvas.getContext("webgl") ||
  canvas.getContext("experimental-webgl")` returns the **existing** context
  when the type matches what the SDK created (and `null` for the
  non-matching types) — it never creates a second context on that canvas.
- In the H1 jetsam path the context object *is* lost — `isContextLost()`
  returns `true` even when the event was never delivered. This is the exact
  "silent" case: the state is queryable; only the notification is lost.
- Zero false positives: `isContextLost() === true` never happens on a
  rendering canvas.

### 2.2 Probe signals (glue, viewer-ui.js)

Each probe gathers a small signal record — every read individually
try/wrapped, unreadable → `null`, never throws:

| signal | how | meaning |
|---|---|---|
| `visible` | `document.visibilityState === "visible"` | never judge a hidden page — background canvases are legitimately blank/throttled |
| `canvasFound` / `canvasConnected` | re-query the container each probe; `canvas.isConnected` | the SDK's canvas exists and is in the DOM (re-query also feeds the §4 rebind fix) |
| `ctxLost` | `gl.isContextLost()` via the existing-context trick above; `null` if no context obtainable | **the primary death signal** |
| `canaryOk` | see below; `null` when not run | GPU layer works *at all* right now |
| `sample` | `drawImage(canvas)` onto a small offscreen 2D canvas + `getImageData` → `"content"` \| `"blank"` \| `"unreadable"` | **corroboration only** — `"content"` proves paint; `"blank"` proves nothing (2.1) |

**The canary** answers the case `isContextLost()` cannot: GPU process dead
enough that even context state queries lie, or the SDK's context replaced
under us. It is one persistent 1×1 offscreen WebGL context owned by the
probe (never in the DOM): clear to a known color, `readPixels`
synchronously **in the same task** (spec-valid even with
`preserveDrawingBuffer: false` — the buffer survives until the task yields
to compositing). Creation failure, `isContextLost()` on the canary, or a
wrong pixel ⇒ the GPU layer is down for the whole page.

Canary rules (iOS punishes context churn — browsers cap live WebGL contexts
and evict the oldest, so a carelessly-churned canary could *cause* the SDK's
context loss):

- Create **lazily**, only the first time a probe is suspicious; keep the one
  instance for the page's life; never create per-probe.
- On teardown intent, release via the `WEBGL_lose_context` extension.
- Never create while `ctxLost === true` already decides the verdict — the
  canary is for the ambiguous middle only.

### 2.3 Pure core (imagery.js) — new §18

```
// constants (mutation-guard tested like EDGE_RECOVERY_*)
RENDER_PROBE_FIRST_MS   = 1500   // anchor/resume ok → first probe
RENDER_PROBE_SECOND_MS  = 5000   // anchor/resume ok → second probe
RENDER_PROBE_VISIBLE_MS = 300    // visibilitychange→visible → re-probe
                                 // (let the compositor re-present first)

// classifyRenderProbe(signals) → "alive" | "dead" | "suspect" | "unknown"
// Pure, total, first-match-wins (the decideEdgeRecovery style):
//   !visible                        → "unknown"   (reschedule on visible)
//   ctxLost === true                → "dead"
//   canaryOk === false              → "dead"
//   !canvasFound || !canvasConnected→ "suspect"   (mid-teardown ≠ death)
//   sample === "content"            → "alive"
//   otherwise                       → "suspect"
//     (ctxLost false/null + blank/unreadable sample: real paint-death
//      variants land here, but so does preserveDrawingBuffer:false on a
//      healthy canvas — NEVER "dead" on this branch. Test-enforced.)

// createRenderWatch() → { probes: 0, verdict: null, done: false }
// decideRenderProbe(state, ctx) → {act:"probe"|"skip"|"stop"}
//   stop when: done, viewer stub, round closed; skip when a moveTo is in
//   flight (the load path re-arms its own probes).
```

The two-verdict split is the deliberate EM posture:

- **`"dead"` is confirmed** (context lost or GPU layer down) — it may
  trigger the §3 rebuild.
- **`"suspect"` is instrumented but never acted on** in v1. It becomes a
  measurable field stream (`render_probe` events, §5) that tells us the
  real base rate of blank-sample-on-healthy-canvas vs. genuine
  backbuffer-zeroed-context-alive deaths. If the field shows suspects
  clustering exactly like her incident (iOS, round ≥2, HUD alive), widening
  the rebuild trigger is a one-line policy change in the pure core — made
  on data, not on a guess that could rebuild healthy viewers.

### 2.4 Scheduling (glue)

Armed at the same spot as `armEdgeRecovery`/`armNavHint` — on every
**anchor/resume** load success: probes at +1500ms and +5000ms. Additional
probes on `visibilitychange → visible` (+300ms) while a round is open, and
on `webglcontextrestored` (the restore path repaints; verify it did).
All timers route through one `scheduleTick`-pattern seam
(`__renderProbeTickForTests`), cancelled by `endRound()`, `destroy()`, and
any new `attempt()` — exactly the edge-recovery lifecycle, which is already
proven and tested in this file.

On a `"dead"` verdict, the glue:

1. `trackError(makeImageryError("render_dead", …))` — new error class,
   added to `ERROR_CLASSES` and `HARD_FAILURE_CLASSES` (the player saw a
   broken game; `classifySessionHealth` → `failed`), through the normal
   budget/consent gates. **This alone converts the silent class into a
   PostHog issue.**
2. `track("render_probe", …)` (schema in §5) — also emitted for
   `"suspect"` verdicts, capped by the probe schedule (≤4/round).
3. `startRecording()` — §9.3 force, so the footage of the death is kept.
4. Folds `{type:"render_dead"}` into the open pano session → a
   `render_dead: true` flag on that round's `pano_session` for funnel
   joins.
5. Hands the verdict to the recovery state machine (§3).

---

## 3. Recovery design — bounded in-place rebuild

She should never have to reload — and per §0, reloading doesn't even help
(the run restarts from round 1). Recovery must be in-place, mid-round,
without consuming the round or desyncing the Daily's shared order.

### 3.1 Shape: rebuild inside the instrumented wrapper, not the page

Two candidate shapes were considered:

- *Page-level*: an `onRenderDead` callback; daily-ui destroys and recreates
  the viewer. Rejected: `destroy()` → `endRound()` emits a partial
  `pano_session` mid-round (double-emission for the round), every surface
  (host/player later) must reimplement the dance, and the page holds a raw
  `viewer` alias that goes stale.
- **Wrapper-level (chosen)**: `createViewer` retains its creation args
  (`{surface, container, component, moveAllowed}`); `instrument()` gains an
  internal `rebuild(trigger)` that replaces the raw SDK viewer **behind the
  stable `iv` façade**. The pano fold, round number, move lever, and every
  caller reference survive; one `pano_session` per round stays true; any
  surface gets recovery for free.

Rebuild steps (glue):

1. Guard via the pure `decideRenderRecovery` (below). Never rebuild while a
   `moveTo` is in flight, while no round is open, while hidden, or on a
   stub viewer.
2. Tear down the raw viewer only: `viewer.remove()` (try-wrapped — removing
   a context-lost viewer may throw), detach the canvas listener, clear the
   canvas ref, cancel edge-recovery/nav-hint timers.
3. `new mapillary.Viewer(...)` with the retained args, `direction` resolved
   through `directionComponentConfig` against the **current**
   `iv.moveEnabled` (a hard-mode viewer must come back frozen). Rebind the
   `on(...)` handlers (they close over the rebindable `viewer` variable),
   `applyMove()`, fresh canvas attach. Constructor throw ⇒ outcome
   `rebuild_failed`, stop.
4. `iv.moveTo(targetImageId, "resume")` — `resume` gets the cover, the
   20s timeout, an `imagery_load` with `purpose:"resume"`, and re-arms
   edge recovery, the nav hint, **and the render probe** (which becomes the
   rebuild's own verification pass). Target: the current image if the
   player had navigated off the anchor (`lastImage.id` — live ref, already
   held, never serialized), else the anchor id. She resumes where she was
   standing.
5. Outcome classification (pure): `"recovered"` (resume ok + follow-up
   probe alive), `"rebuild_failed"` (constructor/moveTo failed),
   `"still_dead"` (resume ok but the re-armed probe returns dead again —
   the GPU layer is simply gone right now). Emit one `render_recovery`
   event (§5) per attempt, fold `{type:"render_rebuild"}` into the pano
   session.

### 3.2 Bounds (pure core)

```
RENDER_REBUILD_MAX_PER_ROUND   = 1
RENDER_REBUILD_MAX_PER_SESSION = 2

createRenderRecovery() → { roundRebuilds: 0, sessionRebuilds: 0 }
decideRenderRecovery(state, ctx{verdict, viewerOk, roundOpen, inFlight,
                                visible}) → "rebuild" | "skip" | "stop"
```

One shot per round, two per session: a device under persistent GPU pressure
must not enter a destroy/create loop that *worsens* memory pressure — the
failure mode the bound exists for. Exhausted budget ⇒ stop probing too
(nothing left to act on; the exception already fired).

### 3.3 Player-facing behavior

- **Successful rebuild is silent** — the cover drops and lifts exactly like
  a round transition. No toast: docs/ui-ux-design-review.md §4's calm-state
  rule; the pill/toast layer is for things the player must act on.
- **`rebuild_failed` / `still_dead`**: one
  `toastWithReport("Street imagery crashed on this phone — you can still guess from the map.", { surface })`.
  Honest, and true: the map-guess path is fully functional (her screenshot
  shows exactly that button alive). The round is not consumed and the timer
  keeps running — she can still score. The existing full-screen
  `showImageryDegraded` overlay stays reserved for the *pre-round* failure
  path where no round is live; overlaying it mid-round would eat the timer
  and the map affordance.

### 3.4 A required alias cleanup

daily-ui.js keeps a raw `viewer = iv.viewer` alias used once
(`viewer.resize()` in `backToStreet`, daily-ui.js:436). After a rebuild that
alias is a destroyed viewer. The build must switch the call to `iv.resize()`
and delete the alias — a two-line change, but a ship-blocker for recovery
correctness. (Grep confirms host/player/screen glue for the same pattern
during the build.)

---

## 4. Instrumentation-gap fixes

**G1 — `webglcontextlost` orphan (brief mandate #4).** The event does not
bubble, so container-level attach is off the table (§0.2). Fix: on **every
successful `attempt()`** (any purpose), re-query the container's canvas; if
the element differs from the bound one, detach from the old and attach to
the new — `webglcontextlost` **and** `webglcontextrestored` (today we don't
listen for restores at all; a restore should schedule a probe to confirm
the repaint actually happened). The probe's own per-probe re-query (§2.2)
is the belt to this suspender. Cost: one `querySelector` per load.

**G2 — "loaded" ≠ "painted".** `imagery_load ok:true` asserts `moveTo`
settlement, a JS-layer fact. The probe (§2) is the fix; no change to
`imagery_load` semantics — dashboards keep their meaning, and
`render_probe`/`render_dead` carry the paint-layer truth.

**G3 — a torn-down round loses its `pano_session`.** Her round 3 fold
(would have read: 0 looks after the death — corroborating evidence) died
with the reload. Fix: a `pagehide` listener that, when a round fold is
open, emits it with a new `partial: true` prop (posthog-js flushes on
pagehide via beacon). Keeps the fold's aggregates-only shape; `partial`
lets dashboards exclude or study torn rounds explicitly.

**G4 — the silent `startChallenge` catch.** Pool-load failure after reload
is indistinguishable from intro abandonment (§0). Optional, small:
`track("daily_start_failed", { reason: "pool" })`-class event, or fold into
an existing error path. Not required for this incident's class; listed so
the owner can decide with the funnel in front of them.

**G5 — raw `viewer` alias** — see §3.4.

---

## 5. Schema + event changes (analytics contract)

New error class: `"render_dead"` → `ERROR_CLASSES`, `HARD_FAILURE_CLASSES`.
`EXCEPTION_PROPS` already carries everything the exception needs.

New events (both aggregates-only; no key matches `BANNED_KEY_RE` —
`ctx_lost`, `canary_ok`, `sample`, `verdict`, `trigger`, `result` all
clear it):

```js
// One per non-alive render probe verdict (≤4/round by the probe schedule).
// The measurement stream for the §2.3 "suspect" policy decision.
render_probe: {
  surface: "string", round_number: "int",
  verdict: "string",        // "dead" | "suspect"
  ctx_lost: "bool",         // gl.isContextLost() (absent when unreadable)
  canary_ok: "bool",        // absent when the canary didn't run
  sample: "string",         // "content" | "blank" | "unreadable" | "skipped"
  since_load_ms: "int",     // anchor/resume ok → this probe
  net_type: "string", online: "bool",
},

// One per rebuild attempt (≤2/session by the pure bounds).
render_recovery: {
  surface: "string", round_number: "int", attempt: "int",
  trigger: "string",        // "context_lost" | "canary_dead"
  result: "string",         // "recovered" | "rebuild_failed" | "still_dead"
  duration_ms: "int",       // verdict → outcome classified
  net_type: "string", online: "bool",
},
```

Extended events: `pano_session` gains `render_dead: "bool"` and
`partial: "bool"` (both absent-when-false, the `edge_recoveries`
convention).

**Why a new `render_recovery` event rather than the brief's "emit
`edge_recovery` with a new reason class":** `edge_recovery`'s
trigger/result vocabulary (`uncached`/`zero` →
`recovered`/`no_change`/`error`) is the setFilter state machine's contract,
and its KPI (spatial-edge recovery rate, currently the Phase-3 fix's
success measure) would be polluted by mixing in viewer rebuilds — a
`result:"recovered"` would mean two unrelated things. Same event *shape*,
separate stream. If the owner prefers strict brief compliance, the schema
cost of folding in (`trigger:"render_dead"`, `result:"rebuilt"`) is small —
but the dashboard cost is permanent.

**KPIs (docs/analytics.md rows to add):**

- *Render-death rate*: `render_dead` issues ÷ `viewer_init ok` by
  `$os`/`$browser` — the number that was invisible on 2026-08-28.
- *Suspect base rate*: `render_probe verdict=suspect` per healthy session,
  by platform — the §2.3 widening decision's input.
- *Recovery efficacy*: `render_recovery result=recovered` ÷ `render_dead`.
- *The product outcome*: iOS Daily started→completed converging toward
  Android's (47% → 74% neighborhood) — the number the owner's wife is a
  datapoint in.

Consent posture: everything above rides `track()`/`trackError()` behind the
existing gate; the probe reads only our own viewer's pixels and none of its
signals encode a location, image id, or user input. Replay: no new screens,
no new maps; the probe's 2D sample canvas and the canary are offscreen and
never enter the DOM (and `captureCanvas: false` stands regardless).
`docs/replay-mask-checklist.md` gets a same-change note recording that
audit ("render probe: no maskable surface added").

---

## 6. Test plan (repo contract)

**Pure core — `tests/imagery.test.js`:**

- `classifyRenderProbe`: every rule; first-match ordering; the two
  mutation-guard tests that encode the design's soul: (1) a blank/unreadable
  sample with `ctxLost !== true` and no canary verdict is **never**
  `"dead"` (the preserveDrawingBuffer trap, §2.1); (2) `visible: false` is
  always `"unknown"` (background pages are never judged).
- `decideRenderProbe` / `createRenderWatch`: stop on done/stub/closed
  round; skip on in-flight; probe count bounded by the schedule.
- `decideRenderRecovery` / bounds: `RENDER_REBUILD_MAX_PER_ROUND === 1`,
  `RENDER_REBUILD_MAX_PER_SESSION === 2` mutation guards (the
  `EDGE_RECOVERY_MAX_ATTEMPTS` precedent); no rebuild while in-flight /
  hidden / round closed; budget exhaustion ⇒ `"stop"` forever after.
- Outcome classifier: `recovered` / `rebuild_failed` / `still_dead`
  mapping.

**Glue — `tests/viewer-ui.test.js`** (stub viewer + the existing seam
conventions; add `__renderProbeTickForTests`):

- Anchor success arms probes; `endRound`/`destroy`/new `attempt` cancel
  them (the edge-recovery cancellation suite's mirror).
- Dead verdict ⇒ exactly one `render_dead` trackError, `render_probe`
  event, recording forced, pano fold flagged, rebuild invoked.
- Rebuild: raw viewer replaced behind the same `iv`; `moveTo(:, "resume")`
  issued with the right target (navigated vs. anchor); moveEnabled
  re-asserted (hard mode comes back frozen); second dead verdict in the
  same round ⇒ no second rebuild.
- Canvas rebind: a stubbed container whose canvas changes between loads ⇒
  listener detached from old, attached to new; `webglcontextrestored`
  schedules a probe.
- Stub viewer (`iv.ok === false`) ⇒ zero probes, zero rebuilds.

**Schema — `tests/analytics.test.js` + `tests/track-schema.test.js`:**

- `render_probe` / `render_recovery` present in `EVENT_SCHEMA`; sanitizer
  test feeding coordinate-shaped junk (`lat`, `lng`, `guess`) into both and
  asserting it strips; `pano_session.render_dead` / `.partial` accept only
  booleans; no schema key matches `BANNED_KEY_RE` (the existing fence test
  should catch this automatically — confirm it sweeps new entries).
- New `track()`/`trackError()` call sites covered by the schema-fence test.

**Docs, same change:** `docs/analytics.md` (both events + the four KPIs +
the `pano_session` extensions), `docs/replay-mask-checklist.md` (§5 note),
`docs/failure-injection.md` + a `__gpChaos.killContext` hook (below).

Gate: `npm test` all green, `npm run check`.

---

## 7. Pre-build verification checklist (against the real pinned bundle)

**CTO verification, 2026-08-28: V1–V3 are now CONFIRMED against the served
bundle (`cdn.jsdelivr.net/npm/mapillary-js@4.1.2/dist/mapillary.js`, fetched
and grepped). The design's load-bearing facts hold:**

- **V1 ✓** — the renderer context acquisition tries `webgl2` first, then
  `webgl`, then `experimental-webgl` (bundle: `["webgl2","webgl","experimental-webgl"]`
  fallback chain; `getContext("webgl2",e))return!0`). The probe's getContext
  order matches the SDK's own.
- **V3 ✓** — `preserveDrawingBuffer:!1` is the renderer default (and the flag
  defaults false even when options are passed). The §2.1 trap is real: pixel
  reads outside the frame return transparent black on healthy canvases. Sample
  stays corroboration-only. Design cannot be "simplified" back to pixels.
- **V2 (upgraded, better than designed)** — the SDK exposes
  `viewer.getCanvas()` (bundle: `getCanvas(){return this._container.canvas}`).
  The probe/rebind should use `iv.viewer.getCanvas()` as the PRIMARY canvas
  source (querySelector("canvas") demoted to fallback), eliminating the
  first-canvas-in-DOM-order risk this checklist worried about. Build note.
- **V4** — `viewer.remove()` runs a dispose chain (customRenderer →
  customCameraControls → observer → componentController → navigator →
  container). Throw-wrapping stands; no leak evidence either way.

**Live-fire harness:** a `__gpChaos.killContext` hook (dev-host-gated like
every chaos hook) that grabs the viewer canvas's context and calls
`WEBGL_lose_context.loseContext()` — drives the entire
detect→emit→rebuild→resume pipeline in a real browser, including on a real
iPhone via local serving. This is the closest reproducible stand-in for the
jetsam path and becomes a scenario row in docs/failure-injection.md.

**Field verification after ship:** the §5 KPIs, plus one PostHog watch:
`render_dead` issues should begin appearing precisely in the cohort that is
currently silent (iOS, zero `$exception` history). If they don't within a
few weeks of iOS Daily traffic while the completion gap persists, H1 is
wrong somewhere and the `render_probe` suspect stream is the next lead.

---

## 8. Open questions for the owner

1. **`render_recovery` as its own event** (recommended) vs. folding into
   `edge_recovery` per the brief's letter — §5 has the tradeoff.
2. **Watch the recording first** (brief: Eddie, id
   `01a047a3-a3c3-7a2b-a3d7-82273aa236f8`) — if the canvas visibly dies
   *mid-round-2* rather than at the round-3 transition, the probe schedule
   should add a mid-round probe (e.g. +30s), not just post-anchor ones.
   The design accommodates it as one more `scheduleTick` call.
3. **G4** (`daily_start_failed`) — in or out of scope for this build?
4. Mid-run Daily persistence (so a reload resumes at round 3) would have
   halved the harm here; it's a product feature beyond this incident's
   scope but worth a backlog line.
