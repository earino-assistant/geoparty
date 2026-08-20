# Post-implementation stabilization review — candidate `f4d0fee`

**Reviewer:** Fable (senior EM / senior reviewer) · **Date:** 2026-08-20
**Base (production):** `3e26419` · **Candidate tip:** `f4d0fee` · **Range:** `3e26419..f4d0fee`
**Implementer:** pinned Claude Opus 4.8, working from
`docs/engineering-manager-review-v0.3.md` (commit `ef7d7e1`, a review
document — not reviewed here as production behavior).

> **CLOSED — the candidate shipped and both REQUIRED FOLLOW-UPs are
> fixed** (RF-1 lexical console-scrub rewrite and RF-2 pool-health
> cache, both in `84924b8`). Historical record. Still outstanding from
> §5: the real-device replay/masking runbook
> (`docs/failure-injection.md` §"Manual on-device runbook",
> `docs/replay-mask-checklist.md` §5) has no dated results.

## Recommendation

**APPROVE WITH REQUIRED CHANGES.**

Every runtime fix in the candidate is real, correct, and strictly improves
the path it touches; nothing in the diff makes production worse than
`3e26419`, and I found no path by which pushing it harms a player. It is
safe to push **only if the two REQUIRED FOLLOW-UPs below are explicitly
accepted and scheduled** — both are defects in the candidate's *guard rails*
(a largely vacuous privacy regression test, and a state-persistence design
that sits exactly on GitHub's cache-eviction boundary), not in its runtime
behavior. Deployment still requires the owner's separate go-ahead.

**Counts: 0 BLOCKER · 2 REQUIRED FOLLOW-UP · 8 ADVISORY.**

**Test results:** `npm test` → 464/464 pass at `f4d0fee` (448/448 at base
`3e26419`; +16 tests, no removals). `npm run check` → clean. Three mutation
experiments run and reverted (worktree verified clean after each); results
below.

## Factual correction to the prior EM review

`docs/engineering-manager-review-v0.3.md` (P2-6/§7 context) stated that no
`v0.3.0` tag exists. **That finding was wrong** — it was an artifact of
stale local tags. `v0.3.0` exists both remotely and locally (after
`git fetch --tags`) and points to `28d2b5b`. The old document is a
historical pre-fix report and is deliberately left unedited; this note is
the correction of record.

## 1. Verification of the assigned stabilization items

Each item was checked in the source, not just via the suite. Verdicts:

| # | Assigned item | Verdict |
|---|---|---|
| 1 | P0 Daily stale callback / first pin | **Fixed** — `js/daily-ui.js:251` now binds `updateLockButton`; mutation-proven guarded (§3) |
| 2 | HTML↔JS contract coverage | **Done** — 4 static contracts in `tests/html-contract.test.js`; A mutation-verified; C is drift-only (advisory A5) |
| 3 | Replay console scrubbing (raw IDs/tokens) | **Runtime fixed; guard defective** — all ~20 caught-error sites in the six replay-adjacent controllers route through `scrubErrorMessage`; the static scan meant to keep it that way is largely vacuous (RF-1) |
| 4 | Team-name replay masking + checklist | **Fixed, complete** — all four P1-2 sinks (`#hGuessHint`, `#pLobbyNote`, `#pRevealNote`, `#toast`×3 pages) masked; checklist §2/§4/§5 updated in the same change |
| 5 | Viewer-init failure vs pool exhaustion (Daily/couch/h2h) | **Fixed in all three surfaces** — verified no premature `finishRun`/`finishGame`/`gameOver` push (§1.1) |
| 6 | Daily timeout comparability (same seeded five) | **Fixed** — transient classes never advance the sampler; the once/day run is only consumed in `finishRun()` (§1.2) |
| 7 | Pool-health two-strike persistence + PR safety | **Structurally fixed** — the counter now survives between runs and the PR is state-file-free; the persistence medium has an eviction hazard (RF-2) |
| 8 | Schema↔track-call-site coverage | **Done, credible** — `tests/track-schema.test.js` scans every literal call site, confines dynamic ones, and self-checks against vacuity (`seen.length >= 20`) |
| 9 | Viewer test isolation / non-vacuous assertions | **Done** — `__resetSessionForTests()` + `beforeEach` reset, `t.after` restores, and the health-fold test now proves causation from a clean session |

### 1.1 The `degraded` contract (items 5 and 6) — verified correct

`js/viewer-ui.js:462-550` now returns exactly one of three shapes:
`{entry}` on success, `{entry:null, degraded:true}` on any retryable
failure (stub viewer via `iv.ok === false` at line 500, or any
non-dead-entry class at line 519), and `{entry:null, degraded:false}` only
when every remaining entry was provably dead. `isDeadEntryClass`
(`js/imagery.js:373`) is a single-class allowlist (`image_dead`), so:

- **No infinite loop, no starvation of genuine exhaustion.** Retries are
  user-initiated (one per Retry tap — no automatic loop, so no retry
  storm), and dead entries still advance the sampler inside the loop, so a
  genuinely dead pool still reaches the `degraded:false` exhaustion return.
  Verified in `tests/viewer-ui.test.js` ("dead entries still skip; only the
  transient one degrades" asserts `skips === 1 && cursor === 1`).
- **Daily** (`js/daily-ui.js:183-197`): the degraded return happens before
  `sampler.advance()`, before `roundStartedAt`/`endsAt` are set (so no
  countdown runs behind the overlay), and the run is only written by
  `saveDailyResult` inside `finishRun()` — **a timeout retries the same
  seeded location and does not consume the once/day run.** A stub viewer is
  destroyed so retry rebuilds it (`if (!iv) makeViewer()` at the top of
  `startRound`).
- **Couch host** (`js/host-ui.js:516-548`): I verified the "nothing pushed
  before the entry is confirmed" claim in the code — `setPhase()`
  (`js/host-ui.js:253-260`) mutates `room.phase` locally only; the first
  Firebase write in `startRound` is the `push({phase:"roundActive", …})`
  *after* the entry succeeds. So `room.phase = prevPhase` is a complete
  rollback, the TV never sees a phantom round, and no fabricated 0-score
  game reaches the leaderboard.
- **h2h host phone** (`js/player-ui.js:713-760`): same shape — the room
  write (`push({phase:"roundActive", round, poolCursor})`) happens only on
  success; the degraded return leaves remote state untouched, member phones
  keep waiting, `poolCursor` is never advanced remotely, and the
  `finally` re-enables the start buttons. Retry re-enters through the
  `isHost() && h2hCanTransition(...)` guard, so a phase that moved on
  meanwhile is handled safely. **Rooms are neither ended nor corrupted.**

### 1.2 Pool health (item 7) — mechanics verified

The old always-dead "Commit state only" branch is gone. The workflow now
restores the newest `pool-health-state-*` cache before the check
(`.github/workflows/pool-health.yml:53-57`) and saves under a
`run_id`-unique key with `if: always()` (lines 130-134), so an
inconclusive run (429-abort writes no state; `tools/pool_health.mjs:216`)
re-saves the restored counters unchanged — preserving an in-progress
streak, which `tests/pool-health.test.js` now models across runs
(including the streak-reset and inconclusive-run cases, matching
`foldState`'s actual `rate_limited`/`error` skip at
`tools/pool_health.mjs:125`). The quarantine PR commits **only**
`data/pool_quarantine.json`; the `concurrency: pool-health` group (no
cancel) serializes scheduled and manual runs, so parallel cache races
cannot occur; the `run_id` branch suffix removes same-day branch
collisions; and the PR body now honestly documents that `github.token`-made
PRs get no CI, with local-check instructions. See RF-2 for the one
structural weakness (eviction), and A3/A4 for two smaller cache semantics.

## 2. Findings

### BLOCKER

**None.** Explicitly: I looked for retry dead-ends, sampler-cursor
corruption, timer leaks behind the overlay, resume/rejoin damage,
ownership violations, stray Firebase writes, consent/replay weakening, and
CSS stacking regressions from the new overlay — the runtime diff survives
all of them.

### REQUIRED FOLLOW-UP

**RF-1. The console-scrub static scan is silently blind to 4 of the 6
files it claims to guard — mutation-proven.**
*Evidence:* `tests/console-scrub.test.js:59` ("no production
console.warn/error passes a bare caught error un-scrubbed"). I mutated
`js/host-ui.js:1514` back to `console.warn("resume: image failed to load
—", e)` — the exact P1-1 leak shape — and **the test still passed**
(reverted after; worktree clean). Root cause: `stripStrings`
(lines 42-45) treats every straight apostrophe as a string delimiter, so
apostrophes inside comments ("the caller's…", "…doesn't") open phantom
strings that swallow whole code regions. Measured per file: the scan sees
0 of 8 `console.warn/error` calls in `host-ui.js`, 0/1 in `screen-ui.js`,
0/2 in `screen-h2h.js`, 0/1 in `daily-ui.js`, 9/13 in `player-ui.js`,
2/2 in `viewer-ui.js` — 11 of 27 sites scanned overall, with no
minimum-count self-check (unlike `track-schema.test.js`, which has one).
*Impact:* the runtime scrubbing shipped in this candidate is genuinely
complete today (I verified every site in the diff by eye, and the
remaining bare-`e` grep hits are outside these files — see A1), but the
regression guard for the privacy invariant is ~59% fake, and
`docs/replay-mask-checklist.md` §4 now documents a guarantee ("the static
scan asserts no controller passes a bare caught error") that is false.
*Likelihood of future silent regression:* high — this is exactly the
edit-shape (add a `console.warn(..., e)` in a controller) the P1-1 class
produces. Also note the scan cannot see `e.message`, `String(e)`, or
`` `${e}` `` forms even where stripping works.
*Recommendation:* strip comments before stripping strings (or scan
line-wise), add a per-file assertion that the number of scanned
`console.(warn|error)` calls equals a raw-source count, and extend the
bare-error pattern to `e.message`/interpolation forms. Half a day,
test-only change.

**RF-2. Pool-health state persistence sits exactly on GitHub's 7-day
cache-eviction boundary — the P1-4 symptom can silently recur on any
delayed Monday run.**
*Evidence:* `.github/workflows/pool-health.yml:15-17` (cron
`13 4 * * 1`, weekly) + lines 53-57/130-134 (cache restore/save). GitHub
evicts caches not accessed for 7 days; the only access is the weekly run
itself, so each restore lands at almost exactly the eviction age. GitHub's
scheduled triggers routinely fire minutes-to-an-hour late; whenever run
N+1's delay exceeds run N's by more than the check's own duration, the
cache is eligible for eviction before it is read. On a miss, the fallback
is the checked-out `tools/pool-health-state.json` from `main` (tracked,
effectively empty), so `fails` silently restarts — the two-strike
threshold becomes intermittently unreachable again, with no signal.
*Impact:* fails safe (an eviction can only *under*-propose; it can never
quarantine a live entry), so this is not a blocker — but it partially
un-fixes P1-4 on an unpredictable schedule and the workflow gives no
indication when it happens.
*Likelihood:* moderate per run; near-certain to occur some weeks over a
quarter.
*Recommendation (pick one):* (a) emit a workflow notice/warning when the
restore step reports a cache miss and the state file is at the committed
baseline, so silent resets at least become visible; plus (b) either add a
cheap mid-week `schedule` that only restores+saves the cache (refreshing
its access time; no API traffic), or move the state to a dedicated
non-`main` ref (e.g. a `pool-health-state` branch the workflow pushes),
which the repo's `contents: write` permission already allows. ~1 hour.

### ADVISORY

**A1. `js/chrome-ui.js:36` logs a bare caught error and is outside the
scrub scan's file list.** `console.warn("chrome listener failed", e)` —
listener callbacks there belong to consent/report UI, so an SDK-flavored
payload is unlikely but not impossible, and console capture syncs it into
replays. Route through `scrubErrorMessage` and add `chrome-ui.js` (and
`consent.js`) to the scan's `FILES` when fixing RF-1.

**A2. Third-party console output still reaches replays unscrubbed.**
`sanitizeBeforeSend` (`js/analytics.js:155-181`) scrubs event properties
and exception lists, but replay console entries ride inside `$snapshot`
payloads it never touches — so the Firebase SDK's *own* warnings (which
can embed database paths containing room codes) and Mapillary's own
console lines are captured verbatim under
`enable_recording_console_log: true` (`js/analytics.js:87`). This is
pre-existing, not introduced by the candidate, and room codes are
24-hour-lived and consent-gated — but it is the honest answer to "could
any remaining console path expose room codes": yes, via third-party SDK
logging. Options when scheduled: scrub console entries in a replay
`before_send`, or accept and document.

**A3. Two same-day runs count as "two consecutive runs".** A manual
dispatch shortly after the scheduled run (serialized, not parallel) folds
the same dead ids twice, so a transient outage spanning both can cross the
two-strike threshold in one morning, and the PR body's "two consecutive
weekly runs" would overstate the evidence. Human review of the
never-auto-merged PR is the intended guard; consider folding at most one
result per id per calendar day if this ever bites.

**A4. A `workflow_dispatch` from a non-default branch saves cache into
that branch's scope**, invisible to later `main` runs — a silent state
fork. Operational note: dispatch from `main` only.

**A5. The mask-contract test (C) is one-directional by design.** It
catches drift between the checklist and the markup (mutation-verified —
removing `data-ph-mask` from `#hGuessHint` fails it), but it cannot
*discover* a team-name sink that was never listed — i.e. it would **not**
have caught the original P1-2 on its own. The discovery mechanism remains
the real-recording runbook (`docs/replay-mask-checklist.md` §5), and the
prior review's P1-5 — that runbook has still never been executed —
**remains open and is unchanged by this candidate.** The candidate even
added new §5 checkboxes to verify. That run should precede or immediately
follow the deploy.

**A6. Minor dead code and scope limits in `tests/html-contract.test.js`.**
`stripStrings` is defined but unused there; contract A covers only
bare-identifier callbacks (inline/arrow handlers are out of scope — fine,
that is the P0's class); contract B only covers page controllers, not
shared modules like `hints-ui.js`. Worth a comment, not a change.

**A7. The degraded overlay has no escape hatch.** `.imagery-degraded`
(`css/style.css`, `z-index: 3100`) covers the leave/abandon controls; if
imagery is durably unreachable (e.g. a network that blocks Mapillary), the
only exits are Retry-forever or a page reload (the resume/rejoin flow
recovers the room correctly after reload — verified unharmed, since
nothing was pushed). A "Back" affordance, or reusing the existing map-only
fallback (currently only offered on mid-round re-anchor failures) at round
start, would be a kinder dead-end. Note `http_auth` (e.g. a revoked
token) is classed as transient, so that scenario lands here too — still
better than the old behavior, which ground the pool and fabricated an
ending.

**A8. Cosmetic:** in `js/player-ui.js:733`, `noticeDegradedImagery(skips)`
runs before the degraded check, so a degraded return with ≥2 prior dead
skips shows both the skip toast and the overlay. Harmless.

## 3. Test credibility (ran, mutated, measured)

- Suite: 464/464 green at candidate; 448/448 at base; `npm run check`
  clean. New/extended files: `console-scrub` (2), `html-contract` (4),
  `track-schema` (2), `pool-health` (+3), `imagery` (+1), `viewer-ui`
  (+4 degraded scenarios, isolation reset, causation assertions),
  `report-ui` (`t.after` restore).
- **Mutation 1 — the shipped P0, reintroduced** (`updateLockButton` →
  `updateLockNowHint` in `daily-ui.js`): contract test A **fails**. The
  new tests would have caught the actual shipped P0. ✔
- **Mutation 2 — mask removed** from `#hGuessHint` in `host.html`:
  contract test C **fails**. Checklist↔markup drift is guarded. ✔
- **Mutation 3 — un-scrubbed `console.warn(..., e)`** restored in
  `host-ui.js`: console-scrub scan **passes** — the vacuity behind RF-1. ✘
- The `degraded` tests assert on the real `sampler.cursor` the host also
  persists as `poolCursor`, and the isolation fix's causation assertion
  (healthy → injected failure → failed) closes the prior
  order-dependency; `__resetSessionForTests` is an export-only test hook,
  never called in production code.
- Honest limit: all viewer tests run against the harness's fake Mapillary;
  the real-device runbook (A5/P1-5) is still the only proof for real SDK
  rejection shapes and actual replay masking.

## 4. Scope discipline — clean

The diff touches only the assigned areas plus their tests and docs. No
unrelated refactor; no feature work; **no changes** to `js/analytics.js`,
`js/consent.js`, PostHog init keys/options, Firebase config, or
`data/location_pool.json` / `data/pool_quarantine.json`; no secrets (the
workflow's token fallback reads the public embeddable Mapillary token from
`config.js`, unchanged); `tools/pool_health.mjs` changed in comments only.
The 525-line `docs/engineering-manager-review-v0.3.md` in the range is the
prior review document (`ef7d7e1`), not production behavior. CSS additions
are confined to the new overlay. Untracked `.feat-*` briefs remain
untracked.

## 5. Conditions for push

1. Owner explicitly accepts and schedules **RF-1** (fix the vacuous scan)
   and **RF-2** (make state persistence eviction-proof or at least
   eviction-visible) — neither requires holding the push.
2. The real-device replay runbook (A5) is executed promptly after deploy,
   as the prior review already required (P1-5).
