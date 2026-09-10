# Issue #2 — Phase 5: targeted `touchcancel` → Sequence lifecycle reset + Spatial nudge

> **STATUS: IMPLEMENTED** (2026-09-10, Opus) — pure logic in `js/imagery.js`
> §19, glue in `js/viewer-ui.js`, `sequence_reset` event +
> `pano_session.sequence_resets` in `js/analytics.js`, tests in
> `tests/{imagery,viewer-ui,analytics}.test.js`, docs in `docs/analytics.md`.
> Original plan below, unchanged. Fable diagnosis + plan,
> 2026-09-10, for the Galaxy S22 Ultra field report (arrows dead + slow
> rounds; root cause confirmed in
> `docs/issue-2-phase4-graphmode-stick.md`). Owner-approved direction:
> **keep the scrubber**, prevent the stick at its entry point. Codex
> (independent) validated the mechanism and supplied the guard/test
> matrix; every SDK claim below was re-verified against the pinned
> `mapillary-js@4.1.2` dist bundle on 2026-09-10 (byte offsets cited).
>
> Relationship to Phase 4: Phase 4 specs the *cure* (an `edge_recovery`
> mechanism escalation that heals a stuck round at ~25 s). This phase is
> the *prevention* — it kills the primary entry (scrubber `touchcancel`)
> at the moment it happens, so the latch never sets, the arrows never
> die, and the full-sequence prefetch never runs. The two compose and
> can ship independently; Phase 4's escalation remains the entry-agnostic
> net for any stick path this listener cannot see.

## 1. The verified mechanism

### 1.1 Why the stick happens (recap + new verification)

- The scrubber input is `input.mapillary-sequence-position`, wrapped in
  `.mapillary-sequence-position-container` (or
  `…-container-inactive` while playing) — bundle ~741884, matches
  `SequenceDOMRenderer._createPositionInput`.
- `ontouchstart`/`onpointerdown` on that input calls
  `_setChangingPosition(true)` (bundle ~741413) →
  `changingPositionChanged$ → true` → `setGraphMode(Sequence)`.
- The ONLY restore path is the renderer's `_changingSubscription`:
  `merge(documentMouseUp$, touchEnd$.filter(touches.length === 0))` →
  `_setChangingPosition(false)` → `setGraphMode(Spatial)`. The SDK's
  `TouchService` *does* expose a `touchCancel$` stream (bundle
  ~1011742) but the restore subscription never merges it — a
  `touchcancel` (Android gesture takeover, notification shade, etc.)
  therefore latches `_changingPosition` true for the life of the
  viewer. Verified: the SequenceDOMRenderer has **no** `touchcancel`
  handling at all.
- With the latch stuck true AND mode Sequence, every image change runs
  the full-sequence image prefetch (Phase 4 §1.3) — the "awful load
  speeds" half of the report.

### 1.2 Why deactivate→reactivate + play/stop is the right shape

Codex's refinement, now bundle-verified:

- **A bare play/stop nudge is incomplete.** It forces Spatial (via
  `PlayService`) but never touches the renderer's `_changingPosition`
  field — the scrubber stays in its broken "mid-drag" state (timeline
  pinned expanded, position input eating pointer events via its
  `onpointermove`/`ontouchmove` `stopPropagation`), and the very next
  emission race can re-enter Sequence.
- **`viewer.deactivateComponent("sequence")`** →
  `Component.deactivate()` (public; guarded on `_activated`, so
  idempotent — bundle ~645748) → `_deactivate()` → unsubscribes every
  component subscription **and calls
  `sequenceDOMRenderer.deactivate()`, which hard-resets
  `_changingPosition = false`**, `_changingSpeed = false`, mode →
  Default, and drops `_changingSubscription`. Crucially it resets the
  field *directly* — NOT via `_setChangingPosition(false)` — so no
  `changingPositionChanged$ → false` fires and **the graph mode is NOT
  restored by the deactivate**. That is exactly why the nudge must
  follow.
- **`viewer.activateComponent("sequence")`** rebuilds all
  subscriptions, including a fresh `_changingSubscription` — the
  scrubber works normally again.
- **`seq.play()` then `seq.stop()`** (both public, Phase 4 §2.A
  bundle-verified): `play()` → `PlayService.play()` → the speed
  subscription runs `setGraphMode(0.5 > 0.54 ? Sequence : Spatial)` →
  **Spatial**; `stop()` → `setGraphMode(Spatial)` again + cleanup. Both
  `cutImages()` calls keep the current image — no camera motion, no
  blanking. The genuine Sequence→Spatial change also fires
  `CacheService`'s `graphMode$.pipe(skip(1))` re-cache, healing the
  current trajectory's spatial edges in-SDK — so if the stick had
  already eaten this round's arrows mid-drag, they come back too.
- `Component.activated` is a **public getter** (bundle ~645334), so the
  glue can read Sequence-active state without touching privates.

Order is exact: **deactivate → activate → play → stop.** Play/stop must
run after reactivation (the configuration→PlayService subscription the
nudge rides is torn down while deactivated).

### 1.3 One honest limit ("already Spatial" is unobservable)

No public API reads the graph mode, so "don't fire when already
Spatial" cannot be checked directly. The proxy is the trigger targeting
itself: a `touchcancel` whose target chain is the position slider means
a scrubber drag was in progress, which means the latch is set and the
mode is Sequence. If the proxy ever misfires, the whole reset is
idempotent-safe: deactivate/activate is a re-render, and play/stop ends
in `setGraphMode(Spatial)` — a no-op when already Spatial. Stated here
so nobody later "fixes" the missing guard by poking `_graphService`.

## 2. The change

### 2.1 Pure logic — `js/imagery.js` (§19, new section)

```
export const SEQUENCE_POSITION_SELECTOR =
  ".mapillary-sequence-position," +
  ".mapillary-sequence-position-container," +
  ".mapillary-sequence-position-container-inactive";
```

- `touchTargetIsPositionSlider(target)` — defensive DOM probe, exactly
  the `navigationArrowsVisible` pattern: null/malformed target or a
  missing/throwing `closest` reads as `false` (never crashes the
  handler); otherwise `Boolean(target.closest(SEQUENCE_POSITION_SELECTOR))`.
  Takes the passed-in element, no ambient DOM — unit-testable with a
  stub.
- `decideSequenceReset(ctx)` — the single-shot decision. Pure, total,
  never throws, first match wins (the `decideEdgeRecovery` style):

```
ctx: {
  onPositionSlider: bool,   // touchTargetIsPositionSlider(ev.target)
  resetting:        bool,   // a reset is already running (re-entrancy)
  viewerOk:         bool,   // iv.ok === true (not a stub)
  canReset:         bool,   // viewer has (de)activateComponent fns AND
                            // a sequence component with play/stop
  moveEnabled:      bool,   // iv.moveEnabled — Frozen/TV ⇒ false
  sequenceActive:   bool,   // seq.activated === true
  remainingTouches: int,    // ev.touches.length at the cancel
}
→ { act: "reset" } | { act: "ignore", reason: string }

1. !onPositionSlider        → ignore "not_slider"
2. resetting                → ignore "in_progress"
3. !viewerOk || !canReset   → ignore "viewer_stub"
4. !moveEnabled             → ignore "frozen"      (never re-activates
                              Sequence on a Frozen/TV round)
5. !sequenceActive          → ignore "sequence_inactive"
6. remainingTouches > 0     → ignore "touches_remain"
7.                          → reset
```

Rationale for rule 6: if any touch survives the cancel, its eventual
`touchend` with `touches.length === 0` still reaches the SDK's own
restore subscription — the SDK heals itself and a mid-gesture reset
would yank a live drag. Only a cancel that ends the gesture entirely
(the stick case) needs us.

### 2.2 Glue — `js/viewer-ui.js`

Inside `instrument()`, alongside the existing `pointerdown` listener:

- `let sequenceResetting = false;`
- `el.addEventListener("touchcancel", onTouchCancel, true)` — capture
  phase on the **container** (`el`), same as `onPointerDown`. Two
  deliberate consequences: (a) the slider input's `stopPropagation`
  calls are bubble-phase and cannot hide the event from us; (b) the
  listener is bound to our page's container div, which **survives the
  §18 rebuild** (only the SDK's children are replaced), so no rebind
  hook is needed — the handler just re-fetches the component per event.
- `onTouchCancel(ev)`: build ctx (fresh
  `viewer.getComponent("sequence")` in a try/catch for
  `canReset`/`sequenceActive` — rebuild-safe, stub-safe), call
  `decideSequenceReset`, return unless `act === "reset"`, else
  `runSequenceReset()`.
- `runSequenceReset()` — fully synchronous (all four SDK calls are
  sync):
  1. `sequenceResetting = true`, `t0 = now()`.
  2. Each step in its **own** try/catch, recording the first failed
     step: `viewer.deactivateComponent("sequence")` →
     `viewer.activateComponent("sequence")` → `seq.play()` →
     `seq.stop()`. A throw never aborts the remaining steps (Phase 4's
     "stop always runs even if play throws" rule, extended to all
     four).
  3. If deactivate or activate failed, call the existing `applyMove()`
     — its retry timer is the established self-healing path, so a
     transient activation failure can never strand the sequence
     component (and with it prev/next arrows) for the round.
  4. `sequenceResetting = false` in a `finally` (the flag is what makes
     a second cancellation during the reset — e.g. one synthesized by
     the component's own DOM teardown — a guarded no-op).
  5. Emit the event (§2.3) and fold
     `pano = foldPanoEvent(pano, { type: "sequence_reset", at: now() })`.
- `destroy()`: `el.removeEventListener("touchcancel", onTouchCancel, true)`
  next to the existing `pointerdown` removal.
- Nothing else changes. No shared state with edge recovery, nav hint,
  render probe, or the cover; no `inFlight` guard on purpose — the
  component lifecycle is independent of navigation, `applyMove` already
  toggles components with loads in flight, and skipping here would
  leave the latch stuck with nothing scheduled to re-check (this is a
  one-shot event handler, not a poller; Phase 4's escalation is the
  fallback net, not this).

### 2.3 Instrumentation — `js/analytics.js` + `docs/analytics.md`

New `EVENT_SCHEMA.sequence_reset` (mirrors the `edge_recovery` row):

```
sequence_reset: {
  surface: "string",       // host|player|daily (moveEnabled surfaces only)
  round_number: "int",
  result: "string",        // "ok" | "error"
  failed_step: "string",   // "deactivate"|"activate"|"play"|"stop" — only on error
  duration_ms: "int",      // handler entry → all steps done (sync, ~0)
  net_type: "string",
  online: "bool",
},
```

- Call site: end of `runSequenceReset()` (schema + call site change
  together, per the allowlist rule). Aggregates only — no DOM target,
  no image id, no coordinates, no touch count, enums only.
- `pano_session` gains `sequence_resets: "int"` — folded per reset,
  reported **only when > 0** (the `edge_recoveries` convention), so the
  healthy majority stays absent-not-zero.
- `docs/analytics.md`: document `sequence_reset` under the
  navigation-health section. Product question: *how often does the
  Android scrubber-cancel stick actually occur in the field, and does
  the in-place reset succeed?* KPIs: **cancel-stick rate** (runs
  emitting ≥1 `sequence_reset` / daily runs), **reset efficacy**
  (`result="ok"` share), and the cross-check that Phase 4's stuck
  signature (`edge_recovery` `uncached → uncached`) trends to zero on
  Android once this ships.
- Consent gating untouched: the event rides `track()` like everything
  else. No replay-mask change — no new screen, no identity rendered
  (`docs/replay-mask-checklist.md` needs no edit; stated per rule).

### 2.4 Tests

`tests/imagery.test.js`:
- `decideSequenceReset` full matrix: each of the seven rules, in order,
  with first-match-wins mutation guards (e.g. `resetting:true` +
  perfect ctx → `in_progress`; `moveEnabled:false` + `sequenceActive`
  → `frozen`, proving Frozen wins before the active check);
  `remainingTouches: 1` → `touches_remain`; all-good → `reset`.
- `touchTargetIsPositionSlider`: matches a stub whose `closest` returns
  an element for the selector; non-slider target → false; null target,
  target without `closest`, throwing `closest` → false, no throw.
- `SEQUENCE_POSITION_SELECTOR` contains all three verified class names
  (guards a future "simplification" to one).

`tests/viewer-ui.test.js` — fake viewer gains: `activateComponent` /
`deactivateComponent` spies; a fake sequence component with
`activated`, `play()`, `stop()`; internal fake state
`{ changingPosition, graphMode }` modelled on the verified SDK:
`deactivateComponent("sequence")` clears `changingPosition` and flips
`activated` **without touching `graphMode`**; `play()`/`stop()` set
`graphMode = "spatial"` (and never touch `changingPosition`):
- **The reset heals (red-capable):** dispatch `touchcancel` on a
  slider-chain target with 0 remaining touches during a move-enabled
  round → the four calls in the exact order deactivate → activate →
  play → stop; fake ends `changingPosition:false`,
  `graphMode:"spatial"`, `activated:true`; one `sequence_reset` event,
  `result:"ok"`; `pano_session` carries `sequence_resets:1`. Fails
  against today's code (no listener exists).
- **Latch discriminator (the Codex test):** with the latch set, calling
  only `play()`+`stop()` on the fake leaves `changingPosition:true`
  (nudge alone insufficient), while the full sequence clears it —
  proves the fake models the real SDK split and pins why the lifecycle
  reset exists.
- Cancellation elsewhere (non-slider target) → zero component calls,
  zero events.
- `seq.activated === false` → nothing.
- Frozen/TV (`moveEnabled:false`) → nothing, and `activateComponent`
  spy **never called** (the reset can never re-enable movement).
- `remainingTouches > 0` → nothing (the SDK's own touchend path owns
  it).
- Fault injection, one test per step: `deactivateComponent` throws /
  `activateComponent` throws / `play` throws / `stop` throws → the
  remaining steps still run, nothing propagates, event carries
  `result:"error"` + the right `failed_step`; on activate-throw,
  `applyMove` re-drive is invoked (spy).
- Re-entrancy: fake `deactivateComponent` synchronously dispatches a
  second `touchcancel` → exactly one reset sequence, one event.
- Destroy: dispatch after `destroy()` → zero calls (listener removed).
- Rebuild: force a §18 rebuild, then dispatch → the reset runs against
  the **new** viewer's spies (container listener survived, component
  re-fetched per event).

`tests/analytics.test.js`: `sequence_reset` sanitizer round-trip (all
props survive, nothing coordinate-shaped to strip); the existing
schema-contains-no-banned-key test picks the new rows up automatically.

Ship gate: `npm test` all green, `npm run check` clean.

### 2.5 Manual field verification (Android, dev host)

1. **Reproduce the stick on today's build** (control): touch-drag the
   scrubber, interrupt with the notification shade (or a second finger,
   then lift both during a gesture takeover); navigate — arrows die,
   rounds get the prefetch lag.
2. **With the fix**: same interruption → `sequence_reset` fires in
   PostHog debug (`result:"ok"`), arrows stay alive on the next
   navigation, no perceptible prefetch lag on image change.
3. **Scrubber still works after**: drag it normally post-reset — the
   thumb tracks, release restores arrows (the reactivated
   `_changingSubscription` is live).
4. Frozen round and TV: interrupt a touch anywhere → zero
   `sequence_reset` events, sequence component stays deactivated.
5. Healthy Daily run without any cancel: zero `sequence_reset` events —
   silence stays the pass.

## 3. Constraints check

- No `new mapillary.Viewer` / raw `moveTo` anywhere; everything lives
  inside `instrument()` behind the `iv` façade; the decision + DOM
  probe are pure and tested in `imagery.js`.
- Public API only: `getComponent`, `activateComponent`,
  `deactivateComponent`, component `activated`/`play()`/`stop()` — no
  `_navigator`/`_graphService`/`_sequenceDOMRenderer` in shipped code.
- Tests + instrumentation + docs ship in the same change; aggregates
  only; consent gating and replay masking untouched; `nav_available`
  not consulted anywhere.
- No build step, no deps, no `tools/` or pool-file changes; degrades to
  a silent no-op on stub viewers, headless docs (`el` null guard), and
  desktop (no touchcancel ever fires).
- Small: ~1 selector + 2 pure functions, ~60 lines of glue, 1 schema
  row + 1 pano_session key.
