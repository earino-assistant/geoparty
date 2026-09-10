# Issue #2 — Phase 4: GraphMode stuck in Sequence (arrows dead + slow rounds)

> **STATUS: PLANNING SPEC — unimplemented.** Fable diagnosis + plan,
> 2026-09-10, for the Galaxy S22 Ultra field report (PostHog EU 252836,
> session `01a08ab5-a1b6-7aac-a3ed-d7000820fb0b`, deploy `87c390e`).
> Every SDK claim below was re-verified against the pinned
> `mapillary-js@4.1.2` dist bundle (byte offsets cited) on 2026-09-10 —
> not taken from the earlier phases or from memory.

## 1. Diagnosis

### 1.1 Why `edge_recovery` returns `no_change` (the exact chain)

The recovery lever is `viewer.setFilter()` →
`Navigator.setFilter$` → `GraphService.setFilter$`
(`resetSpatialEdges()` + re-run `cacheImage$` for the current image).
The Phase 2/3 design assumed that re-run always re-attempts the
spatial-edge fetch. It does not:

- **`GraphService.cacheImage$` gates the entire spatial-caching branch on
  the graph mode** — bundle offset ~1025825:
  `… this._graphMode === GraphMode.Spatial) { /* tiles + spatial area +
  cacheSpatialEdges */ }`. When `_graphMode === GraphMode.Sequence`, the
  pipeline caches assets + sequence edges and **never touches spatial
  edges at all**.
- So with the mode stuck in Sequence: `setFilter()` resets the status to
  uncached, the re-cache skips the spatial branch, the status stays
  `{cached:false}` forever. `refreshLastImageThen`'s `getImage()` refresh
  (the Phase 3 fix, `js/viewer-ui.js:529`) is working exactly as designed —
  the *fresh* current-image object genuinely has no cached spatial edges.
  `classifyEdgeRecoveryOutcome(null, false)` → `"no_change"`, and the next
  tick reads `spatial:null` again → `trigger:"uncached"` again.

This is why the field signature is `attempt:1 uncached/no_change,
attempt:2 uncached/no_change`: **in Spatial mode attempt 1 always converts
the stuck-uncached status to a cached ZERO** (Phase 2 §2.3, the two-step
mechanism), so attempt 2 arrives with `trigger:"zero"`. An attempt 2 that
is *still* `"uncached"` means the conversion never ran, i.e. the spatial
branch of `cacheImage$` never executed, i.e. **the graph mode was not
Spatial**. That single field fact discriminates this failure from the
Phase 2 API-blip failure (which, post-Phase-3, shows `uncached → zero`).
Corroborating: `duration_ms ≈ 2525` = the 2500 ms recheck + ~25 ms for
`setFilter()` to settle — a promise that resolves near-instantly because
the re-cache did no spatial network work.

### 1.2 How the mode gets stuck (verified entry points)

`GraphService.setGraphMode(Sequence)` has exactly two callers in 4.1.2
(offsets ~749467, ~776885):

1. **SequenceComponent scrubber drag.** Touching the sequence-position
   scrubber fires `changingPositionChanged$ → true` →
   `setGraphMode(GraphMode.Sequence)`. The matching `→ false` (which sets
   Spatial) fires **only** on `documentMouseUp$` or
   `touchService.touchEnd$` filtered on `touches.length === 0`
   (offset ~740349). On Android Chrome a **`touchcancel`** — browser
   gesture takeover, notification shade, tab switch, a second finger still
   down at release — delivers neither, so `_changingPosition` latches
   `true` and the mode stays **Sequence for the life of the viewer**,
   i.e. every subsequent round of the daily run.
2. **`PlayService` at speed > 0.54** (`fg.sequenceSpeed = .54`). Only
   while playing; `stop()` restores Spatial. Not the likely field entry
   (default speed is 0.5 and daily never autoplays), listed for
   completeness.

Our existing per-round safety net cannot heal entry 1:
`beginRound()` → `stopPlay()` → `SequenceComponent.stop()` →
`configure({playing:false})` → `PlayService.stop()`, and
`stop(){ this._playing && (…, setGraphMode(Spatial), …) }` —
**early-returns when not playing**. A scrubber-stuck mode has
`playing === false`, so nothing ever resets it. Re-`moveTo` does not help
either: nothing in the `moveTo$` path calls `setGraphMode` (the brief's
"re-moveTo nudge" variant of option A is a dead end — verified).

### 1.3 The evidence, fully explained

- `imagery_load ok=true, 1.7–3.3 s` — anchors load fine; image bytes ride
  a different endpoint and `cacheImage$` still completes in Sequence mode.
- Rounds with `anchor_spatial_edges 1–6` cached — rounds whose anchor
  cached spatial edges (mode still/again Spatial at that caching pass, or
  edges observed off a healthy image event). Arrows can still *appear*
  in such a round and then die on the first arrow tap: the navigated-to
  image is cached in Sequence mode → no spatial edges → arrows vanish.
  "Arrows not working right, total mess" matches this flicker better than
  a clean absence.
- Rounds firing `edge_recovery` twice, `uncached/no_change` — anchors
  cached while stuck in Sequence (mechanism in §1.1). Only rounds where
  the player lingered ≥ ~25 s emit both attempts, which is why a 5-round
  run shows just two events.
- Perceived multi-second sluggishness — with `_changingPosition` stuck
  `true` AND mode Sequence, the SequenceComponent runs
  `cacheSequenceImages$(sequenceId, imageId)` (retry ×3) on **every image
  change** (offset ~749703): a full-sequence image prefetch competing for
  mobile bandwidth every round.
- `nav_available=false` — the known-broken signal; ignored per policy.
- No `$exception` — nothing throws anywhere in this chain. Consistent.

## 2. Options evaluated

- **A. Wrapper-level mode reset (RECOMMENDED, refined).** No public API
  reads or writes the graph mode directly, but a verified public-API
  round-trip forces it: `SequenceComponent.play()` →
  `configure({playing:true})` → `PlayService.play()`, whose speed
  subscription immediately runs `setGraphMode(0.5 > 0.54 ? Sequence :
  Spatial)` → **Spatial**; then `SequenceComponent.stop()` →
  `PlayService.stop()` → `setGraphMode(Spatial)` again + cleanup. Both
  `cutImages()` calls keep the current image (same `clear()` family as
  `setFilter`) — no camera motion, no blanking. The genuine
  Sequence→Spatial *change* additionally fires `CacheService`'s
  `graphMode$.pipe(skip(1))` subscription (offset ~1018313), which
  re-caches spatial edges for the whole remaining trajectory — the
  in-SDK heal the Phase 2 doc's retracted "Play recovers arrows" theory
  was groping at; it was wrong then only because the mode was already
  Spatial. Follow the nudge with our normal `setFilter()` so recovery does
  not depend on `CacheService` internals: with the mode now Spatial, the
  re-cache actually fetches. Robust even if `configure` emission were
  deferred (either ordering ends with a Spatial-mode spatial fetch before
  the 2.5 s recheck).
- **B. SDK upgrade.** **There is no mapillary-js 4.1.3.** Verified against
  the npm registry 2026-09-10: `dist-tags = { latest: "4.1.2", next:
  "5.0.0-beta.5" }`. The only newer line is a 5.0 beta — an unverified,
  breaking, pre-release bundle. Rejected.
- **C. Prevention (deactivate the sequence component / hide the scrubber).**
  Would remove the primary stick entry but also removes prev/next
  sequence arrows, the play affordance, and our only public mode-reset
  lever — a product/gameplay decision, not a bug fix. Flagged for the
  owner as an optional follow-up; not part of this change. (A CSS-only
  scrubber hide would still leave entry 2 and any future entry unfixed;
  the recovery-side fix is entry-agnostic.)

## 3. The fix (small, self-contained)

Extend the existing Phase 2/3 recovery — same cadence, same cap of 2, no
new timers — with a **mechanism escalation** keyed on the §1.1
discriminator.

### 3.1 Pure logic — `js/imagery.js`

- `createEdgeRecovery()` → `{ attempts: 0, done: false, lastTrigger: null }`;
  `edgeRecoveryStopped` preserves the field.
- `decideEdgeRecovery(state, ctx)` gains one ctx input and one output:
  - `ctx.canModeReset: bool` — the glue found a sequence component with
    callable `play`/`stop`.
  - every `act:"attempt"` result gains
    `mechanism: "set_filter" | "mode_reset"`:
    `mode_reset` **iff** `trigger === "uncached" && state.lastTrigger ===
    "uncached" && ctx.canModeReset` (a second consecutive uncached attempt
    — the Sequence-stuck signature), else `set_filter`. Evaluation order
    of the existing rows is untouched; `EDGE_RECOVERY_MAX_ATTEMPTS` stays
    **2** (API-blip path: `uncached → zero`, both `set_filter`, unchanged;
    stuck path: `uncached → uncached`, attempt 2 escalates — both resolve
    within the existing cap).
- `classifyEdgeRecoveryOutcome` unchanged.

### 3.2 Glue — `js/viewer-ui.js`

- `edgeRecoveryCtx()` adds `canModeReset`: `viewer.getComponent("sequence")`
  exposes `play` and `stop` functions (try/catch, false on any miss).
- `runEdgeRecoveryAttempt(trigger, mechanism)`: record
  `state.lastTrigger = trigger` (same mutation pattern as `attempts`);
  when `mechanism === "mode_reset"`, run the guarded nudge **before** the
  existing `setFilter()` call — `try { seq.play() } catch {}` then
  `try { seq.stop() } catch {}` (stop always runs even if play throws) —
  then fall through to the unchanged settle → `refreshLastImageThen` →
  recheck → classify path. Add `mechanism` to the `edge_recovery` props.
- Nothing else changes: arming, cancellation, grace/recheck/backoff,
  Frozen/TV skip (`moveEnabled=false` rounds never reach an attempt, so
  the nudge can never re-enable movement — it never calls
  `activateComponent` at all), stub guards, endRound/destroy cleanup.
- Worst-case wall clock unchanged (≈28 s, ≤2 attempts). A stuck round
  heals at ~25–27 s; because the graph mode is **viewer-scoped**, one heal
  fixes every subsequent round of the run.

### 3.3 Instrumentation — `js/analytics.js` + `docs/analytics.md`

- `EVENT_SCHEMA.edge_recovery` gains `mechanism: "string"`
  (`"set_filter" | "mode_reset"` — enum only, no id/coordinate; call site
  changes in the same edit per the schema/call-site rule).
- `docs/analytics.md`: extend the `edge_recovery` row; extend the
  Navigation-health KPI with **mode-stuck rate** (share of runs emitting
  `mechanism=mode_reset`) and **mode-reset efficacy**
  (`result=recovered | mechanism=mode_reset`). Product question: how often
  does the Sequence stick occur in the field, and does the nudge heal it?
- `pano_session` unchanged (`edge_recoveries` already counts attempts).

### 3.4 Tests (all pure/fake-SDK, no sleeping — existing seams)

`tests/imagery.test.js`:
- mechanism matrix: first `uncached` → `set_filter`; consecutive
  `uncached` + `canModeReset` → `mode_reset`; consecutive `uncached`
  without `canModeReset` → `set_filter` fallback; `zero` trigger → always
  `set_filter`; `lastTrigger:null` fresh state; `edgeRecoveryStopped`
  preserves `lastTrigger`.
- mutation guards: dropping `lastTrigger` tracking or the `canModeReset`
  gate fails a named test; cap stays exactly 2 (existing guards untouched).

`tests/viewer-ui.test.js` (fake viewer gains an internal `graphMode` flag:
`setFilter()` populates cached spatial edges only when mode is
`"spatial"`; fake sequence component's `play()` flips mode to
`"spatial"`):
- **Sequence-stuck heals:** attempt 1 `set_filter`/`uncached`/`no_change`;
  attempt 2 `mechanism:"mode_reset"` — `play` then `stop` then `setFilter`
  called in that order — recheck reads edges ≥1 → `result:"recovered"`,
  event carries `mechanism:"mode_reset"`, `anchor_spatial_edges`
  backfilled. Red-capable against today's code (today attempt 2 re-runs
  the futile `set_filter` and stays `no_change`).
- **API-blip path untouched:** Spatial-mode fake — attempt 1 converts to
  cached-zero, attempt 2 `trigger:"zero"` `mechanism:"set_filter"`,
  `play`/`stop` spies **never called** (mode_reset must not fire when the
  zero-conversion worked).
- no sequence component → attempt 2 falls back to `set_filter`, no throw;
  `play` throws → `stop` still called, attempt completes, bounded;
  Frozen/TV → existing never-attempts tests extended to assert the nudge
  spies stay uncalled.

`tests/analytics.test.js`: `edge_recovery` round-trip including
`mechanism`; schema-contains-no-banned-key test picks it up automatically.

Ship gate: `npm test` green, `npm run check` clean.

### 3.5 Manual field verification (dev host)

1. Reproduce the stick without waiting for a `touchcancel`: dev console
   `viewer._navigator._graphService.setGraphMode(0)` (0 = Sequence,
   enum verified; console-only — never shipped code). Load the next round:
   arrows absent, `imagery_load ok`.
2. ~17.5 s: attempt 1 `set_filter`/`uncached`/`no_change`. ~25.5 s:
   attempt 2 `mechanism:"mode_reset"` → arrows appear **in place**, no
   blank/snap; PostHog debug shows `result:"recovered"`,
   `spatial_after ≥ 1`.
3. Real-entry best effort on an Android device: touch-drag the sequence
   scrubber and interrupt with a second finger / notification shade;
   confirm arrows die on next navigation and self-heal within ~30 s of the
   next lingered round.
4. Healthy round and Frozen round: zero `edge_recovery` events (silence
   stays the pass).

## 4. Constraints check

- No `new mapillary.Viewer` / raw `moveTo` outside the wrapper; the nudge
  lives inside `viewer-ui.js` behind the unchanged `iv` façade; decision
  logic is pure and tested in `imagery.js`.
- Public API only: `getComponent("sequence")`, component `play()`/`stop()`,
  `setFilter()`, `getImage()` — no `_navigator`/`_graphService` in shipped
  code (the §3.5 internals poke is a dev-console repro aid only).
- Aggregates only; the new `mechanism` prop is an enum. Consent gating,
  replay masking, pool rules untouched. No build step, no deps; degrades
  to a no-op on stub viewers (existing `viewer_stub` stop).
- `edge_recovery` KPI stays honest: same result semantics; the new field
  *adds* the mechanism split. One honest limit, unchanged from Phase 2:
  if the fetch lands after the 2.5 s recheck, the event may say
  `no_change` while arrows still appear moments later — the bounded-report
  floor already documented in Phase 2 §11.
