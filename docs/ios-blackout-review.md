# iOS Daily black-pano — diagnosis + fix design (Fable review)

**Author:** Fable (design/EM seat) · **Date:** 2026-08-28
**Baseline:** repo `99df25d` (the served release) + the verified PostHog brief
(`.brief-fable-ios-daily-blackout.md`, Yichen's queries of 2026-08-28).
**Status:** design only — no source edits. Build is a follow-up task.

The incident: Chrome iOS 151, Daily round 3. `imagery_load ok:true, 987ms`,
then a fully black pano with the HUD alive, zero exceptions, zero
`webgl_context_lost`, network healthy. The failure is invisible to every
signal we ship today.

> **⚡ UPDATED 2026-08-28 (debug pass).** The §7 checklist was executed
> against the **served** bundle and the hypotheses adjudicated. Read the
> new "Verdict" section directly below — it supersedes §1's ranking and
> adds build-blocking corrections (D1–D7) to §2–§4.

---

## ⚡ Verdict — 2026-08-28 debug pass (supersedes §1's ranking)

**Serving parity, established first:** `https://geoparty.social/release.json`
= `99df25d`; served `daily.html` / `js/viewer-ui.js` / `js/daily-ui.js` are
byte-identical to the repo at `99df25d` (and to this working tree). The SDK
bundle `cdn.jsdelivr.net/npm/mapillary-js@4.1.2/dist/mapillary.js` was
re-fetched today: 1,092,073 bytes, SHA-384 exactly matches the SRI pin in
`daily.html:166`. Every bundle fact below is from that byte-exact artifact
(offsets are byte offsets into it).

### A. Bundle facts (each read from the served, SRI-verified bundle)

- **F1 — one canvas per Viewer, created *detached*.** The `Container`
  constructor (offset ~1015400) creates
  `this._canvas=this._dom.createElement("canvas","mapillary-canvas")` with
  **no parent argument** (contrast `createElement("div","mapillary-interactive",this._container)`).
  The canvas exists but is **not in the DOM** at viewer construction.
- **F2 — the canvas is appended exactly once, on the first GL render
  registration, and never replaced.** `GLRenderer._webGLRenderer$`
  (offset ~990384) = `this._render$.pipe(first(), map(() => { canvasContainer.appendChild(canvas); return new THREE.WebGLRenderer({canvas}); }), publishReplay(1), refCount())`.
  One append, one renderer, for the life of the Viewer. §7-V "does the SDK
  recreate its canvas?" — **No, never.**
- **F3 — components are cover-gated.** `ComponentService.activate(name)`
  (offset ~622770) marks a component active but only calls its
  `.activate()` when `!this._coverActivated` — and `_coverActivated`
  starts `true`. `_uTrue(i.image,"image")` at construction therefore does
  **not** activate the image component.
- **F4 — with no initial `imageId`, activation waits for the first
  successful `moveTo`.** Our `createViewer` passes no `imageId`
  (viewer-ui.js:239–243), so `ComponentController` (offset ~982276) takes
  the no-key path: `movedToId$.pipe(first(id => id != null)).subscribe(…
  componentService.deactivateCover() …)`. Chain: first `moveTo` settles →
  cover deactivates → `ImageComponent._activate()` (offset ~705599)
  registers with `glRenderer.render$` → F2 fires → **the canvas enters the
  DOM only after the first `moveTo` settles.**
- **F5 — `getCanvas()` returns `null` until then.**
  `get canvas(){return this._canvas.parentNode ? this._canvas : null}`
  (offset ~1016117); `Viewer.getCanvas()` (offset ~1087952) returns that
  getter's value.
- **F6 — the SDK swallows context loss *by design*.** The embedded
  three.js `WebGLRenderer` binds `webglcontextlost`/`webglcontextrestored`
  (offsets 402518/402563 — the only such listeners in the whole bundle);
  its lost handler (offset ~403420) is
  `fe(e){e.preventDefault(); console.log("THREE.WebGLRenderer: Context Lost."); g=!0}`
  — console-only — and `render()` opens with `if(!0===g)return;`
  (offset 416312): a **silent no-op forever after**. The RAF loop and all
  page JS keep running; `moveTo` (graph/state layer, pure JS) keeps
  resolving `ok:true`. If the event is *not* delivered (the WebKit jetsam
  path), GL calls against a lost context are spec-defined silent no-ops —
  same outcome. Either way: **no throw, no signal, black canvas, HUD
  alive.** This is the §7 "does it swallow render-loop failures" answer —
  it doesn't even need a `catchError`: the loss path *cannot* throw.
- **F7 — no `catchError→EMPTY` in the GL render pipeline** (`GLRenderer`,
  offset 988157 onward: no error operator anywhere in the render chain),
  and the bundled RxJS is v7 (config object with
  `onUnhandledError`/`onStoppedNotification`, offset ~12500): an exception
  thrown inside a render subscription is re-thrown asynchronously →
  `window.onerror` → `$exception`. Her session has zero exceptions with
  server-side capture ON ⇒ **nothing in the render pipeline threw.**
- **F8 — teardown deliberately fires a real context loss.**
  `GLRenderer.remove()` (offset ~991540) calls
  `getExtension("WEBGL_lose_context").loseContext()`, and
  `Container.remove()` (offset ~1017089) then removes `canvasContainer`
  (with the canvas) from the DOM. Consequences: (a) any bound
  `webglcontextlost` listener **will fire during a normal destroy** unless
  detached first — today's `destroy()` order is correct (detach at
  viewer-ui.js:946 before `viewer.remove()` at :955) and must stay
  normative for the rebuild; (b) after a rebuild there is **no stale
  canvas** for `querySelector("canvas")` to mis-find.
- Re-verified: **V1** (context acquisition order `webgl2` → `webgl` →
  `experimental-webgl`) and **V3** (`preserveDrawingBuffer` defaults false;
  the renderer is constructed as `new WebGLRenderer({canvas})` with no
  override — F2) both stand. Bonus: the GL clear color is `0x0f0f0f`
  (offset ~988900, `new Color(986895)`) — near-black — see D5.

### B. The decisive session fact: our listener was NEVER bound

`attachCanvas()` runs exactly twice: at viewer create and once at
+1500ms (viewer-ui.js:578–580). Nothing re-runs it. By F1–F4 the canvas
enters the DOM no earlier than *(create → first-attempt gap)* + *(first
anchor load duration)*. Her numbers: `viewer_init` 09:11:47 (42ms) ⇒
create ≈ 47.0s; round-1 `imagery_load` ok at 09:11:49 with
`duration 1700ms` ⇒ attempt started ≈ 47.3s, settled ≈ 49.0s ⇒ canvas
appended ≈ 49.0s. The one-shot retry fired ≈ 48.5s — **400–500ms before
the canvas existed**. Both attach attempts found nothing; `canvas` stayed
`null` for the whole session; **no `webglcontextlost` event was observable
by our glue, whether or not WebKit delivered one.**

This is deterministic, not probabilistic: the listener binds **only** in
sessions whose first anchor load settles within ~1.4–1.5s of viewer
creation. Round-1 loads on cold mobile networks routinely exceed that
(hers: 1700ms; her *warm* round-2 load was still 1037ms). Two corollaries:

- The historical near-zero rate of `webgl_context_lost` events is largely
  a **measurement artifact**, not health — most mobile sessions never had
  the listener. Do not cite that dashboard as evidence about context-loss
  frequency until the D1 fix ships.
- §1-H2's "Against" bullet ("the canvas existed inside the attach
  window") was **wrong** — round-1 *painting* at ~t0+2s proves the canvas
  arrived *after* the 1.5s window, not inside it. Corrected in place below.

### C. Adjudication

**Mechanism — confirmed, no longer probabilistic:** the round-3 pano was
a **WebGL-context-dead canvas behind a fully alive page**, invisible by
construction: our listener was unbound (B), the SDK swallows loss silently
(F6), nothing in the render path can throw (F7), and `imagery_load` has
never measured pixels. Every datum in the timeline — silence included —
is *predicted* by this chain.

**Cause of the context loss** (what §1 was really ranking):

1. **~80–85% — H1's causal story: WebKit GPU-process death / GPU resource
   eviction under memory pressure.** Unchanged evidence: the cream
   fragment (partial texture eviction), the broken-`<img>` glyph
   (decoded-image buffer eviction — an independent memory-pressure
   fingerprint in the same frame), round-3 timing at peak GPU footprint,
   the small-RAM 375pt device, the Chrome-iOS-worst cohort gradient.
   The r2→r3 anchor load is the likeliest kill moment: a fresh pano
   texture set decode+upload is this page's biggest single GPU-memory
   spike.
2. **~15% — NEW residual, surfaced by this pass: compositor/layer detach
   with a live context.** A known iOS WebKit failure class: the canvas's
   layer is dropped from the compositor after a memory warning while the
   GL context stays healthy — `isContextLost()` false, render loop fine,
   screen black. The probe as designed would read such a canvas "alive".
   Mitigation is cheap (D3: a `resize()` nudge) and the §7 field watch
   discriminates: if `render_dead` never fires in the silent cohort while
   blackouts persist, this is the mechanism.
3. **≤5% — H3 (SDK render-loop death): killed.** No churn premise (§0.1),
   no swallow mechanism in the render chain (F7 — a throw would have been
   an `$exception`; there were zero), and the screenshot shows eviction
   signatures, not a frozen last frame.

**H1 vs H2 as originally framed is dissolved, not decided.** "Was the
event delivered?" is unobservable in this session (nobody was listening —
B) and irrelevant to the fix (the probe polls state; D1 rebinds the
listener). The §1-H1 Blink-engine caveat is likewise **moot** for this
incident: even a reliably-delivered event was unobservable.

### D. What the recording can and cannot confirm (owner watch-list)

The footage covers 09:11:42→09:13:50 — round 2 in full and the first ~12s
of round 3. **Caveat at the time of writing: rrweb was not capturing canvas
pixels** (`captureCanvas` off — the masking posture THEN; superseded the
same day by the owner decision of 2026-08-28, so a post-decision recording
shows the pano), and the cream
fragment / broken-img glyph are compositor artifacts, also invisible in
replay. The replay will *not* show a black pano. Judge from behavior:

- **09:12:43→09:13:37 (round 2):** does her interaction cadence stay
  *sighted* — deliberate arrow taps, pauses to look, purposeful pans — all
  the way to the round's end? JS-side nav works fine on a black canvas
  (arrows are DOM; `nav_move` counts SDK state changes, not pixels), so
  r2's healthy-looking `pano_session` (42 taps / 24 moves) does **not**
  prove r2 had pixels. If the cadence turns repetitive/blind mid-round,
  the death was mid-r2.
- **09:13:37→38:** the `pano-cover` element's class flip
  (visible → hidden, ~1s apart) — confirms the cover lifted onto a dead
  canvas (the §1 "stuck cover" rule-out, now visually checkable).
- **09:13:38→09:13:50 (round 3 open):** the discriminator. Sighted r2 +
  immediately-lost r3 behavior (taps with no reaction, quick retreat to
  the map button) ⇒ death at the r2→r3 texture upload — the leading H1
  moment. Already-degraded late-r2 behavior ⇒ death mid-r2.
- Minor: why the recording flush stopped at 09:13:50 while JS lived to
  ≥09:14:54 is unexplained — flagged, not chased (does not affect the
  verdict; the death window is fully covered).

### E. Build corrections D1–D7 (deltas to §2–§4 — Opus dispatch must apply)

- **D1 (supersedes G1's emphasis — this is now THE primary listener fix).**
  Re-attach on **every successful `attempt()`** (any purpose), using
  `viewer.getCanvas()` as the primary source with
  `el.querySelector("canvas")` as fallback; treat `null` as
  "not present yet" (F5 — it is `null` until the first settle), never as
  an error. The earliest possible bind moment **is** first-anchor-success;
  the create-time and +1500ms attaches may stay but are known-insufficient
  (B). Bind `webglcontextlost` **and** `webglcontextrestored`.
  New required test: a stub container whose canvas appears only *after*
  the first successful attempt (the exact incident shape) ⇒ listener
  bound on that success.
- **D2 (rebuild ordering is load-bearing, F8).** In `rebuild()`: detach
  canvas listeners and cancel probes **before** `viewer.remove()` —
  teardown fires a genuine `loseContext()`. Today's `destroy()` order
  (:946 before :955) is correct; keep it and add a regression test: a
  destroy/rebuild with a bound listener emits **zero** `webgl_context_lost`
  and zero probe verdicts.
- **D3 (cover the C-2 residual).** On a `"suspect"` verdict, additionally
  call `iv.resize()` (three.js `setSize` marks `needsRender` ⇒ forced
  repaint; also nudges WebKit into re-attaching a dropped compositor
  layer). Non-destructive, free on healthy canvases. The §2.3 policy
  stands: **no rebuild on suspect** — a nudge is not an action on the
  viewer's life. Pure core: `classifyRenderProbe` unchanged;
  `decideRenderProbe` gains `act:"nudge"` for suspect.
- **D4 (probe schedule is safe as designed).** Probes arm only on load
  success, so the canvas always exists when they run (F4). No change.
- **D5 (sample classifier).** The SDK clears to `#0f0f0f` (A, last
  bullet), so a healthy-idle canvas is *near*-black, not pure black: the
  sample classifier must treat any **uniform** frame as `"blank"`
  regardless of the color value. Reaffirms §2.1: sample is corroboration
  only; `"blank"` never reaches `"dead"`.
- **D6 (`webglcontextrestored` handling).** three.js `preventDefault()`s
  the lost event (F6) — the precondition for `restored` to fire — and its
  restore path re-inits GL state but repaint still needs a `needsRender`
  trigger. Our restore listener should schedule a probe **and** call
  `iv.resize()` (guarantees the repaint the probe then verifies).
- **D7 (G3 confirmed necessary, mechanism now known).** On Daily a round's
  `pano_session` fold closes only at the *next* `beginRound` or at
  `destroy` (daily-ui.js calls `endRound` nowhere else) — a mid-round
  abandon **always** loses the open fold. Her round-3 fold (which would
  have read ~0 sighted moves — corroboration) died with the reload
  exactly this way. The `pagehide` flush ships with the build.

### F. Secondary telemetry oddity — adjudicated from code, closed

`guess_submitted` / `reveal_shown` are **party-surface events only** —
call sites exist solely in host-ui.js (:1169, :1516) and player-ui.js
(:1565, :1812). daily-ui.js emits `daily_challenge_started/completed`,
`pano_session`, `imagery_load` — no per-guess events, by design. So
rounds 1–2 "missing" guess events is **not a loss**, and yes,
`pano_session` fires on timeout-without-submit (it fires whenever the
round leaves play, guess or no guess). The brief's "Android Daily session
today emitted `guess_submitted`×3" is therefore mis-attributed — those
events can only come from a party surface; one PostHog check of that
session's events (`guess_submitted` carries `room`/`mode`) will confirm.
No Daily-iOS event loss exists here.

### G. Field verification (unchanged from §7, now with a discriminator)

After the build ships: `render_dead` should appear precisely in the
currently-silent cohort (iOS, zero-`$exception` histories). If blackout
reports persist while `render_dead` stays at zero **and** suspects
cluster on iOS with `ctx_lost:false` + `sample:"blank"`, the mechanism is
the C-2 compositor detach — the D3 resize nudge is already the treatment,
and its efficacy shows up as suspects that stop recurring within the same
round.

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

> **Superseded 2026-08-28 by the ⚡ Verdict above** — kept for the record.
> Outcome: mechanism (silent context-dead canvas) is now *confirmed*, not
> ranked; H1's causal story survives at ~80–85%; H2's listener gap turned
> out to be a certainty (the listener was never bound — Verdict §B), which
> dissolves the H1-vs-H2 event-delivery question; H3 is killed by bundle
> facts F6/F7.

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

- ~~MapillaryJS 4.1.2 creates its render canvas once per `Viewer` and does
  not replace it across `moveTo` calls (verify against the pinned bundle —
  §7 checklist). One viewer lived the whole session, so the canvas at
  t0+1.5s was almost certainly *the* canvas — her round-1 image was already
  painted at t0+2s, so the canvas existed inside the attach window.~~
  **CORRECTED 2026-08-28 (Verdict §A/§B):** one-canvas-never-replaced is
  verified (F2), but the canvas is created *detached* and enters the DOM
  only after the **first `moveTo` settles** (F1–F4) — round 1 settled at
  ~t0+1.9s, *outside* the 1.5s attach window. "Painted at t0+2s" proved
  the opposite of what this bullet claimed. The listener was never bound.
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
never enter the DOM. Note (2026-08-28 owner decision, post-review): the pano
canvas is now recorded (`captureCanvas: { recordCanvas: true, … }`), so the
probe's on-screen viewer pixels may appear in replays — game content,
consistent with the new posture.
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
  **2026-08-28 addendum (Verdict F5):** the underlying getter is
  `this._canvas.parentNode ? this._canvas : null` — it returns **`null`
  until the first `moveTo` settles**. Callers must treat `null` as
  "not present yet", never as an error (D1).
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
