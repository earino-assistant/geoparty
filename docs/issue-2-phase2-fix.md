# Issue #2 — Phase 2: bounded spatial-edge cache recovery

> **STATUS: SHIPPED.** Phase 1 (edge diagnostics + health-classifier fix,
> commit 63965f5) is shipped and live. This document was the Phase 2
> *recovery* design; it has since been implemented (`js/imagery.js`
> `decideEdgeRecovery`/`classifyEdgeRecoveryOutcome`, `js/viewer-ui.js`
> glue, `edge_recovery` analytics event) and corrected against source-verified
> field research — see the corrections called out inline below. MapillaryJS
> stays pinned at **4.1.2** in this pass (§9).

## 1. Confirmed root cause (field evidence, 2026-08-21)

Owner's console during a live round, arrows missing:

- `graph.mapillary.com` returned **HTTP 500**, repeatedly.
- The SDK logged `Failed to cache spatial images (<id>). MapillaryError: 2
  (MLYApiException) temporarily unavailable` from `GraphDataProvider.ts:282`.
- The **panorama itself loaded fine** (image bytes ride a different
  endpoint), so our `moveTo` resolved OK and the round proceeded normally —
  minus arrows.
- The SDK **swallows** the graph failure and never retries: in
  `GraphService.cacheImage$` the spatial-area fetch is wrapped in
  `catchError` → `console.error("Failed to cache spatial images …")` →
  `observableEmpty()`. The chain completes "successfully" with the node's
  `spatialEdges.cached === false`, so the DirectionComponent has nothing to
  render. Nothing in the SDK ever re-attempts it for that image.
- **Retracted: "Pressing Play recovers the arrows."** An earlier pass of
  this design attributed a field-observed recovery to `PlayService.play()`
  calling `graphService.setGraphMode(GraphMode.Spatial)`, on the theory that
  `CacheService`'s `graphMode$` subscription (`skip(1)`, i.e. on change)
  would re-run `cacheImage$` and re-attempt the failed spatial-area fetch.
  That explanation cannot be right: `setGraphMode` early-returns when the
  mode is unchanged, and Spatial is the viewer's **default** graph mode — a
  Play tap never actually toggles it, so the subscription's `skip(1)` gate
  never fires. There is no verified in-SDK mechanism behind the anecdotal
  "Play recovers arrows" report. It is dropped from this design; §2's
  `setFilter()` lever below is independently source-verified against the
  MapillaryJS 4.1.2 source, and that — not the Play button — is what Phase 2
  relies on.

So the failure is: **a transient graph-API error during the one-shot
spatial-edge caching pass is silently permanent for that image**, and there
is no reliable in-game recovery today.

Phase 1 made this *visible* (`anchor_spatial_edges` stays **absent** =
unknown/uncached in `pano_session`). Phase 2 makes it *heal*.

## 2. The recovery lever: `viewer.setFilter()` (public API)

We verified the following against the MapillaryJS **v4.1.2** source
(github.com/mapillary/mapillary-js, tag v4.1.2):

1. **`Viewer.setFilter(filter?): Promise<void>`** (`src/viewer/Viewer.ts`) —
   public, documented ("Set the filter selecting images to use when
   calculating the spatial edges"), resolves/rejects a promise. It is the
   *only* public method that re-triggers edge caching without navigating.

2. **`Navigator.setFilter$`** (`src/viewer/Navigator.ts`) does, in order:
   - `stateService.clearImages()` → `StateBase.clear()` — **keeps the
     currently displayed image** and only trims the other trajectory
     entries (`cut()` pops images *after* the current index; `remove()`
     drops the ones *before* it). No image transition, no camera change,
     no blanking.
   - `graphService.setFilter$(filter)` → `graph.resetSpatialEdges()` —
     marks every node's spatial-edge status uncached again. `resetSpatialEdges`
     only iterates `_cachedSpatialEdges` (the set of nodes it has actually
     cached before), so a never-cached anchor is a harmless no-op here — the
     re-caching that matters happens in the `cacheImage$` step below.
   - `_cacheIds$(trajectoryIds)` → **`graphService.cacheImage$` for the
     current image** — the full caching pipeline runs again, including the
     spatial-area fetch and, on success,
     `graph.cacheSpatialEdges(id)`.

3. **The failure is not negatively cached.** `Graph.cacheSpatialArea$`'s
   `catchError` deletes the failed batch keys from `spatialArea.all` /
   `spatialArea.cacheNodes` and deletes `_cachingSpatialArea$[key]` when the
   last batch settles — a later `cacheImage$` **re-issues the HTTP
   request** rather than replaying the failure. Confirmed against the live
   SDK as **two-step**, not one-shot: the *first* re-attempt after a stuck
   uncached status converts it to a cached **zero** without actually
   re-issuing the HTTP request (the client-side reset resolves before the
   network round-trip would); only the *second* re-attempt re-issues the
   real fetch and, once the API answers, restores the arrows (§3, §C
   correction 1).

4. **Late edges render without any image event.** `DirectionComponent`
   subscribes to `image.spatialEdges$`, which re-emits when
   `cacheSpatialEdges` later succeeds — arrows appear in place, on the
   image the player is already looking at.

Therefore the minimal safe equivalent of "press Play, press Stop" is:

```js
viewer.setFilter()        // no argument — we never use filters anywhere,
                          // so this applies the "no filter" passthrough
```

— visually a no-op (current image kept, no camera motion, no cover
involvement, no component (de)activation), semantically "recompute spatial
edges", and it re-fetches exactly the data whose fetch previously 500'd.

Rejected alternatives:

- **Re-`moveTo` the same anchor** — runs the state-machine transition
  again: resets pov/zoom via our own cover rules (`resetView` +
  `showCover`), emits `imagery_load`, risks visible snap. Too intrusive.
- **Toggling graph mode like Play does** — `setGraphMode` is not public;
  reaching `viewer._navigator._graphService` is internals-poking on a CDN
  bundle, and `setGraphMode(Spatial)` early-returns when the mode is
  already Spatial (the default), so it wouldn't even fire without first
  forcing Sequence — a bigger, less honest state change than `setFilter()`.
- **Fetching edges ourselves** — duplicates SDK graph logic and would need
  raw image ids in our code paths; forbidden by the privacy rules.

## 3. Trigger — the pure predicate

New pure logic in `js/imagery.js` (tested in `tests/imagery.test.js`); the
viewer wrapper only supplies inputs and timers.

```js
// Constants (exported; small ints — the bounds ARE the design)
export const EDGE_RECOVERY_MAX_ATTEMPTS = 2;
export const EDGE_RECOVERY_GRACE_MS     = 15000; // anchor ok → first check
export const EDGE_RECOVERY_RECHECK_MS   = 2500;  // setFilter settled → re-read
export const EDGE_RECOVERY_BACKOFF_MS   = 8000;  // attempt 1 → attempt 2
// GRACE was raised from 5000ms to 15000ms (2026-08-21 field correction): a
// slow-but-healthy spatial fetch completes anywhere from ~1s to ~15s in the
// field, and firing the first check at 5s was resetting an in-progress fetch
// and delaying arrows further rather than helping. 15s puts the first check
// past the normal healthy window, so a healthy round now emits ZERO recovery
// events (§4). EDGE_RECOVERY_MAX_ATTEMPTS is not a generic safety margin —
// it is FUNCTIONALLY REQUIRED at 2: attempt 1 only ever clears the stuck
// uncached status to cached-zero (§2 point 3); attempt 2 is the one that
// re-issues the real fetch. A cap of 1 would stop before the actual fix ever
// runs (tests/imagery.test.js has a mutation-guard test asserting this).

// Per-round state (created at anchor-load success, dropped at endRound)
export function createEdgeRecovery() {
  return { attempts: 0, done: false };
}

// The decision. Pure, total, never throws.
//   state: createEdgeRecovery() value
//   ctx: {
//     viewerOk:    bool,       // iv.ok === true (not a stub)
//     canSetFilter:bool,       // typeof viewer.setFilter === "function"
//     moveEnabled: bool,       // iv.moveEnabled — Frozen ⇒ false
//     inFlight:    bool,       // an attempt()/moveTo not yet settled
//     userNavigated: bool,     // nav_move seen OR current image ≠ anchor
//     spatial:     int|null,   // extractEdgeCounts of the LIVE image ref
//   }
// → { act: "attempt"|"skip"|"stop", reason: string }
export function decideEdgeRecovery(state, ctx)
```

Semantics (exact, in evaluation order — first match wins):

| condition | result | why |
|---|---|---|
| `state.done` | `stop:"done"` | terminal — idempotence |
| `!ctx.viewerOk \|\| !ctx.canSetFilter` | `stop:"viewer_stub"` | stub / SDK build without setFilter: recovery impossible, never throw |
| `ctx.userNavigated` | `stop:"user_navigated"` | the player moved off the anchor — never fight navigation |
| `ctx.spatial >= 1` | `stop:"edges_present"` | arrows exist (incl. after our own recovery) — nothing to do |
| `state.attempts >= EDGE_RECOVERY_MAX_ATTEMPTS` | `stop:"attempts_exhausted"` | hard bound |
| `!ctx.moveEnabled` | `skip:"frozen"` | Frozen (G2) / TV surfaces — never recover, never re-enable movement; `skip` (not `stop`) so a *next-round* unfreeze isn't poisoned, but no re-arm happens within the round |
| `ctx.inFlight` | `skip:"in_flight"` | never during a load |
| `ctx.spatial === null` | `attempt`, trigger `"uncached"` | the confirmed failure mode: status never cached |
| `ctx.spatial === 0` | `attempt`, trigger `"zero"` | cached-zero; usually a genuine dead-end, but cheap to confirm (bounded) |

A `stop` marks `state.done = true` (via a pure `edgeRecoveryStopped(state)`
helper); `attempt` increments `state.attempts`. `skip` leaves state
untouched — the glue simply does not reschedule within the round except for
the already-planned ticks, so a skip can never turn into a hot loop.

Outcome classification (pure):

```js
// afterSpatial: int|null read EDGE_RECOVERY_RECHECK_MS after setFilter settles
export function classifyEdgeRecoveryOutcome(afterSpatial, setFilterFailed)
// → "recovered"  (afterSpatial >= 1)
// → "error"      (setFilterFailed — the setFilter() PROMISE ITSELF rejected;
//                 a stub/dispose race, confirmed rare)
// → "no_change"  (still null or 0)
```

**Correction (§C.3):** a blocked graph API is `"no_change"`, **not**
`"error"`. Confirmed against the live SDK: `setFilter()`'s promise
**resolves** even while the graph API is 500ing — the fetch is detached and
its failure swallowed the same way the original bug swallows it (§1), so the
call site never sees a rejection to propagate. `setFilterFailed` stays in
the classifier for the rare stub/dispose race, but a still-broken API is the
`"no_change"` path, not `"error"`.

## 4. Glue in `js/viewer-ui.js` (design)

All inside `instrument()` — nothing page-module-facing changes; no new
methods on the `iv` surface except a test seam.

- **Latch the live image ref.** The existing `image` event handler
  additionally stores `lastImage = ev.image` (memory-only, never
  serialized; only `extractEdgeCounts(lastImage)` ever reads it — counts,
  never ids/coordinates). Cleared in `endRound()` / `destroy()`.
- **Arm on anchor success.** In `attempt()`'s success path, when
  `coversRound(purpose)` (`anchor`/`resume` — the same set that covers),
  create `createEdgeRecovery()` state and schedule the first tick at
  `EDGE_RECOVERY_GRACE_MS`. Arming *replaces* any previous state/timer
  (idempotent per anchor; a re-anchor restarts cleanly).
- **Tick** (one small function, the only place timers fire):
  1. Build `ctx` from live state (`iv.ok`, `typeof viewer.setFilter`,
     `iv.moveEnabled`, in-flight flag, `pano.nav_moves > 0 ||
     currentImageId !== anchorImageId`, `extractEdgeCounts(lastImage).spatial`).
  2. `decideEdgeRecovery(state, ctx)`:
     - `stop` → clear timers, done (no event for `edges_present` — silence
       is the healthy path).
     - `skip` → do nothing this tick (no reschedule beyond planned ones).
     - `attempt` → `Promise.resolve().then(() => viewer.setFilter())`
       wrapped in try/catch + `.catch()` (never throws out); after it
       settles, one re-read at `EDGE_RECOVERY_RECHECK_MS`:
       classify outcome, emit the `edge_recovery` event (§5), feed the
       fresh counts into the existing edges fold
       (`foldPanoEvent({type:"edges", …})` — so a successful recovery
       fills `anchor_spatial_edges` for Phase 1's metric), and, if the
       outcome is not `"recovered"` and attempts remain, schedule the next
       tick at `EDGE_RECOVERY_BACKOFF_MS`.
- **Cancellation.** All recovery timers are cleared in `endRound()`,
  `destroy()`, and at the start of every new `attempt()` (any purpose — a
  new load supersedes recovery). Worst-case added wall clock inside a
  round: grace + setFilter + recheck + backoff + setFilter + recheck ≈
  15000+2500+8000+2500 = **28 s** of *idle waiting* and **at most two**
  `setFilter()` calls — no per-render work at all (nothing hooks the
  render/`pov` path). GRACE was raised from 5000ms to 15000ms (2026-08-21
  field correction, §3) so a healthy round's spatial fetch — which the field
  shows completing anywhere from ~1s to ~15s — is never mistaken for stuck;
  a healthy round now emits **zero** `edge_recovery` events. A genuine
  transient failure still self-heals with no user action, now typically
  **~24–28 s** after the anchor (attempt 1 fires at the 15s grace and
  predominantly resolves `"no_change"` — the cached-zero conversion, §2
  point 3, §C correction 1 — and it is attempt 2, ~8s later, that recovers);
  **`attempt:1 no_change, attempt:2 recovered` is the healthy-recovery field
  signature, not a sign attempt 1 failed.**
- **Test seam.** Timers route through one `scheduleTick(fn, ms)` helper;
  a test-only `iv.__edgeRecoveryTickForTests()` runs one due tick
  synchronously (same convention as `__resetSessionForTests`), so unit
  tests never sleep. The §15 chaos object may override the three delays on
  a dev host (`__gpChaos.edgeRecoveryMs = {grace, recheck, backoff}`) for
  the failure-injection harness; inert in production like every chaos hook.

## 5. Instrumentation (aggregates only)

One new event in `EVENT_SCHEMA` (`js/analytics.js`) — emitted **per
attempt outcome**, hard-capped at `EDGE_RECOVERY_MAX_ATTEMPTS` (2) per
round per surface by the state machine itself:

```js
// Issue #2 Phase 2: one per spatial-edge recovery attempt (≤2/round).
// Pure aggregates: counts, timings, enums — no id, no coordinate.
edge_recovery: {
  surface: "string",        // host|player|daily (moveEnabled surfaces only)
  round_number: "int",
  attempt: "int",           // 1-based, ≤ EDGE_RECOVERY_MAX_ATTEMPTS
  trigger: "string",        // "uncached" | "zero"  (§3)
  result: "string",         // "recovered" | "no_change" | "error"  (§3)
  spatial_after: "int",     // bounded 0..EDGE_COUNT_CAP; absent when unknown
  sequence_after: "int",    // same bounding; absent when unknown
  duration_ms: "int",       // setFilter call → outcome classified
  net_type: "string",
  online: "bool",
},
```

Plus one additive `pano_session` property: `edge_recoveries: "int"` —
count of attempts that round (fold event `{type:"edge_recovery_attempt"}`;
emitted only when > 0, like the other conditional props). This lets the
existing per-round panels correlate recovery with `nav_moves` (did the
player actually walk after we healed the arrows?).

- **Sanitizer/tests:** `tests/analytics.test.js` gains the standard cases —
  schema allowlist passes these props, `BANNED_KEY_RE` still strips
  coordinate-shaped keys, no property may carry an id (asserted by the
  existing "schema contains no banned key" test plus a new
  `edge_recovery` round-trip). `tests/track-schema.test.js` picks up the
  new literal `track("edge_recovery", …)` call site automatically.
- **`docs/analytics.md`:** add the event row under Events, extend the
  `pano_session` row (`edge_recoveries`), and extend the *Navigation
  health* KPI: **recovery rate** = `edge_recovery.result="recovered"` /
  all `edge_recovery` events, and **residual arrow-loss** = rounds with
  `anchor_spatial_edges` absent *after* Phase 2 (should trend to ~0 for
  move-enabled rounds; if it doesn't, the trigger or the bound is wrong).
  This is the product question the event answers: *does the field
  arrows-vanished failure now self-heal, and how often is it needed?*

## 6. Hard boundaries — enforcement and tests

| boundary | enforced by | red-capable test |
|---|---|---|
| ≤ 2 attempts/round, no infinite/hot loop; the cap must be **exactly 2, not 1** (two-step recovery, §C.1) | `attempts` counter in pure state; ticks only from 3 finite scheduled delays; nothing on render/pov | drive tick repeatedly with edges stuck at `null`: `setFilter` spy called exactly 2×, then `stop:"attempts_exhausted"`; mutation check: removing the cap fails this test; a SEPARATE mutation-guard test proves a cap of 1 would stop right after attempt 1's `"no_change"`, before the real, recovering attempt 2 ever runs |
| never during Frozen; never re-enables movement | `moveEnabled` in predicate (`skip:"frozen"`); mechanism calls **only** `setFilter` — never `activateComponent` | Frozen round (`setMoveAllowed(false)`) → spy proves `setFilter` *and* `activateComponent` uncalled by recovery; predicate unit matrix |
| never blanks the pano / no visible move | mechanism is `setFilter()` only — §2 source evidence (`clear()` keeps current image); recovery path has no access to `showCover`/`resetView` | spies on cover helpers stay uncalled through a full recovery cycle; no `moveTo` issued |
| never during user navigation | `userNavigated` (nav_moves > 0 or current ≠ anchor) → `stop` | fire an unexpected-id `image` event between arming and tick → `setFilter` never called |
| never mid-load | `inFlight` flag around `attempt()`; new attempt cancels timers | start a second `moveTo` before the tick → old recovery cancelled, no `setFilter` |
| idempotent / safe on stub, offline, failed loads | stub `iv.ok===false` never arms (arming lives in `attempt()` success); `canSetFilter` guard; every `setFilter` call promise-wrapped with catch | stub viewer + `loadRoundImage` degraded path → no throw, no event; fake viewer whose `setFilter` rejects → outcome `"error"`, bounded retry, no unhandled rejection |
| no capture without consent | events ride the existing `track()`/`consent.js` gate — nothing new touches PostHog | existing consent-gate tests cover `track`; schema test covers the new event |
| no ids/coords leave | only `extractEdgeCounts` reads the image ref; event props are enums/ints | analytics sanitizer tests (§5) |

## 7. Test plan

**`tests/imagery.test.js` (pure, exhaustive):**
- `decideEdgeRecovery` full matrix: each row of the §3 table as its own
  assertion, plus precedence checks (done beats everything; `edges_present`
  beats `frozen`; `frozen` is `skip` not `stop`).
- unknown ≠ zero: `spatial:null` → trigger `"uncached"`, `spatial:0` →
  `"zero"`, `spatial:1` → stop.
- `classifyEdgeRecoveryOutcome` truth table incl. `setFilterFailed`, and the
  **correction #3 case**: `classifyEdgeRecoveryOutcome(0, false) ===
  "no_change"` — a resolved-but-still-zero read is never misclassified as
  `"error"`.
- constants sanity: `EDGE_RECOVERY_MAX_ATTEMPTS` is a small positive int
  (≤3), all delays finite and ≥1s (guards accidental hot-loop edits).
- **mutation guard (§C.1):** a state with one attempt already spent, given a
  cached-zero `spatial:0`, must still decide `"attempt"` (trigger `"zero"`)
  under the real cap — proving `EDGE_RECOVERY_MAX_ATTEMPTS` must be 2, since
  that state is exactly "attempt 1 just converted uncached to zero."

**`tests/viewer-ui.test.js` (fake `mapillary` global + `__edgeRecoveryTickForTests`):**
- happy path: anchor ok → image event with `cached:false` edges → tick →
  `setFilter` called → attempt 1 classifies `"no_change"` (the cached-zero
  conversion, §C.1) → tick → `setFilter` called again → attempt 2 classifies
  `"recovered"` → `edge_recovery` event props exact for both attempts,
  `pano_session.anchor_spatial_edges` filled from the FINAL attempt only
  (never the interim cached-zero — see the note in §4's fold-feed code),
  `edge_recoveries:2`.
- the six boundary tests from §6.
- `endRound`/`destroy` cancel pending recovery (tick after → no-op).
- Frozen round then next round un-Frozen: round N emits nothing, round
  N+1 recovers normally (per-round state isolation).
- TV surface (`moveEnabled:false` always): never attempts — schema's
  `surface` comment stays honest.
- **(§C.1) mutation guard:** attempt 1 alone (simulating a cap of 1) never
  recovers — `setFilter` spy called once, outcome `"no_change"`; only the
  real cap (2) lets attempt 2 fire and actually recover.
- **(§C.3) the blocked-API signature:** `setFilter` resolves on every call
  but never actually populates real edges (the API stays down) — BOTH
  attempts classify `"no_change"`, never `"error"`.

**Mutation/red checks** (each named test fails if the guard is deleted):
cap removal → loop test; dropping the `moveEnabled` check → Frozen test;
inverting unknown/zero → matrix; removing cancellation → cancel tests.

Ship gate as always: `npm test` green, `npm run check` clean.

## 8. Manual field test (dev host)

1. `localhost` serve; open host couch game; DevTools → Network → add
   request blocking for `graph.mapillary.com/*` **after** the round's
   pano has rendered but arrows are visible — sanity: blocking alone must
   not remove already-cached arrows.
2. New round with blocking enabled *during* the anchor load (this
   reproduces the field 500: pano may load from cache/CDN, spatial batch
   fails — console shows "Failed to cache spatial images"). Arrows absent.
3. Wait ≈15 s: console shows the SDK re-fetch attempt (still blocked →
   attempt 1 `result:"no_change"` — this is the healthy signature, not a
   failure: attempt 1 only ever clears the stuck status to cached-zero
   without a real fetch, §C correction 1). **Unblock** within the ~8 s
   backoff window before attempt 2 fires.
4. Attempt 2 fires (~24–28 s after the anchor) → arrows appear **in
   place**: no pano blank, no camera snap, no cover flash, player's pov
   untouched.
5. Verify events (PostHog debug/localStorage queue): exactly 2
   `edge_recovery` (`attempt:1 no_change`, `attempt:2 recovered`) — **never**
   `result:"error"` for a blocked-then-unblocked API (§C correction 3) —
   `pano_session` carries `edge_recoveries:2` and a now-present
   `anchor_spatial_edges`.
6. Frozen twist round with blocking on: no `edge_recovery` events, arrows
   stay off, movement stays disabled.
7. Healthy round: zero recovery events (silence is the pass).

## 9. Explicitly NOT changed in this pass

- **MapillaryJS stays 4.1.2** (the console also showed a transient unpkg
  CDN hiccup — separate, low-risk follow-up; a version bump would
  invalidate the §2 source verification and is out of scope).
- No SDK internals (`_navigator`, `_graphService`, `setGraphMode`) — the
  public `setFilter()` only.
- `classifySessionHealth` thresholds: `anchor_spatial_edges` remains
  **diagnostic-only**; making it a health input stays a Phase 3 decision
  once recovery-era field data exists.
- No changes to cover rules, `moveTo`/`loadRoundImage` semantics, the
  sampler/pool, consent gating, replay masking, or any user-facing control
  (Play/sequence components untouched).
- No new `iv` surface for page modules — host/player/daily/screen UIs are
  untouched.

## 10. Acceptance criteria

1. A round whose spatial-edge caching failed transiently (graph-API blip)
   gets its arrows back **without any user action**, typically via the
   *second* attempt (~24–28 s after the anchor, once the API has
   recovered) — the first attempt routinely reports `"no_change"` as it
   only clears the stuck status to cached-zero, which is expected, not a
   failure (§C correction 1) — with no visible movement, blanking, or
   control change.
2. At most 2 `setFilter()` calls per round, ever, **and the cap must be 2,
   not 1** — a mutation-guard test proves a cap of 1 would stop before the
   recovering second attempt ever runs (§C correction 1). Zero calls on
   healthy rounds, Frozen rounds, stub viewers, and after user navigation
   (all test-enforced).
3. `edge_recovery` reports attempts/outcomes as pure aggregates; the
   Navigation-health KPI can state the field recovery rate; a successful
   recovery also backfills `anchor_spatial_edges`.
4. All existing tests stay green; every §6 boundary has a red-capable test.

## 11. Caveats (§C correction, honest limits — not follow-up work)

- **Recovery is partial, not exhaustive.** The state machine stops the
  instant `edges_present` is true (`spatial >= 1`); it never re-checks a
  round it already considers arrows-present, even if a later navigation
  somehow re-breaks caching for a *different* image mid-round (nav-purpose
  loads have their own independent `imagery_load` path — Phase 2 only ever
  covers the round's anchor).
- **A rare permanent stick is possible and is bounded, not eliminated.** If
  the underlying SDK batch never resolves at all in a way `cacheImage$`
  recognizes (the internals note a `!item.node` guard on some batch-error
  paths), no number of `setFilter()` calls will help — the `EDGE_RECOVERY_MAX_ATTEMPTS`
  cap means this reads as two `edge_recovery` events ending in `"no_change"`
  and a round that stays arrow-less, rather than a retry storm. This is the
  honest floor of a client-side recovery for a server-side failure mode.

## 12. Phase 3 correction — the recheck read a stale image ref (2026-08-24)

> **Field evidence (PostHog EU 252836, 14 d):** EVERY `edge_recovery` event
> was `trigger=uncached` / `result=no_change`, zero `trigger=zero`, zero
> `recovered` (0/108). The two-step machine advanced to attempt 2 correctly
> but re-issued the SAME futile `uncached` trigger instead of reaching the
> real-fetch `zero` branch — so nothing ever recovered on real devices.

This does **not** rewrite the shipped Phase 2 design above; the pure state
machine in `imagery.js` (`decideEdgeRecovery`, the two-step trigger, the
cap-of-2) is correct and unchanged. The defect was entirely in the glue's
**read**:

- Phase 2 latched the live `Image` object at load (`lastImage = ev.image`)
  and had `finishEdgeRecoveryAttempt` re-read edges off that same object
  after `setFilter()` settled, on the comment-documented assumption that "a
  recovered status renders with no further image event" (in-place mutation).
- The field disproves that assumption. `Viewer.setFilter$` runs
  `StateService.clear()`, which `cut()`/`remove()`s trajectory entries; the
  caching pass then repopulates a **different** current-image object. The
  object latched at load is cut from the trajectory and its `spatialEdges`
  status never re-emits — it reads `null` (uncached) forever. So the recheck,
  and therefore the next tick's `decideEdgeRecovery`, kept seeing `spatial:
  null` → the `uncached` branch, on both attempts. The `zero` branch was
  unreachable.

**Fix (glue only, `js/viewer-ui.js`):** before the post-`setFilter()`
recheck reads edge counts, re-acquire the viewer's CURRENT image via the
public `viewer.getImage()` and refresh `lastImage` from it. Confirmed against
the pinned mapillary-js 4.1.2 bundle — `getImage()` resolves
`this._navigator.stateService.currentImage$.pipe(take(1))`, i.e. the live
current image, a different object from the one cut at `clear()` time. The
refresh is robust to **both** SDK behaviors: if a build mutates the image in
place, `getImage()` returns that same (now-fresh) object; if it replaces the
image, `getImage()` returns the new one. A build without `getImage` (or a
reject) falls back to the latched ref and stays synchronous, so the Phase 2
in-place-mutation tests are untouched. The refreshed `lastImage` is still
never serialized (only `extractEdgeCounts` reads it), stays id/coordinate-free,
and is cleared in `endRound()`/`destroy()` exactly as before; the assignment is
gated on the recovery state still being live so a late resolve can't repopulate
a latch `endRound()` just cleared.

Event semantics are unchanged — same `edge_recovery` schema and `trigger`/
`result` meanings. The only difference the field will see is that
`trigger=zero` / `result=recovered` can now actually occur. A new
`tests/viewer-ui.test.js` case models the real SDK (a `getImage()` that
returns a fresh replaced object each pass while the load-time object stays
uncached) and asserts attempt 2 reaches `zero` → `recovered`; it is
red-capable against the Phase 2 code.
