# Engineering Manager review — the v0.3 release train

**Scope reviewed:** `54bf0a5` (S7, the last shipped feature before the
review/observability/de-clutter arc) through `3e26419` (HEAD at dispatch) —
~9,600 insertions across 53 files — with the surrounding system inspected
for grounding. Focus commits: field observability (`c7f7369`), beta
deployment plan (`0f28562`, design only), UI/UX de-clutter (`3e26419`).

**Baseline note (evidence gap):** the review brief referenced tag `v0.3.0`.
No such tag exists — the last tags are `v0.1.0-couch` and `v0.2.0-h2h`.
`54bf0a5` was chosen as the defensible baseline (it contains everything the
brief names). Release tagging has not kept pace with the release train;
see finding P3-11.

**Verification state at review time:** `npm test` 448/448 green,
`npm run check` clean, both run during this review.

---

## 1. Executive summary and recommendation

**Recommendation: GO, with a short stabilization gate first.** Authorize
continued feature development *after* a stabilization pass of roughly one
to two days (§8) — every blocking item found is small and surgical. No
rollback is warranted: the shipped defects are contained, and the release's
architecture is sound.

This is an unusually healthy rapid build in its *structure*: the pure-logic
/ DOM-glue split is real and enforced, the consent gate is genuinely
airtight at the core, the observability design is thought through to a
depth most teams never reach (closed error taxonomy, exception budgets,
opaque location ids, an honest "what remains invisible" section). The
documentation is the best part of the codebase.

What keeps this from an unconditional GO is a familiar failure shape for
AI-led velocity: **the system's promises have outrun its verification.**
One shipped P0 regression in the Daily (a stale function reference no test
could see), two privacy gaps that contradict written PRIVACY.md promises
(unscrubbed console output riding into replays; four unmasked team-name
sinks), a weekly automation that can never fire (circular state
dependency), and a manual verification runbook that was written — well —
but never executed. All of these live precisely in the layer the 448 tests
cannot reach. The test suite is excellent at what it covers and silent
about where the risk actually is.

**There are no findings that require rollback.** There is exactly one P0,
and its fix is one line.

---

## 2. What the team did exceptionally well

- **The consent architecture.** `createAnalytics()` with injected effects
  (`js/analytics.js:485`) makes the legally load-bearing logic pure and
  testable; the schema-as-hard-allowlist with `BANNED_KEY_RE` defense in
  depth, the in-flight-revoke queue drop (`js/analytics.js:524`), and the
  one-shot diagnostic path that never touches the stored "no" are all
  correct in code, not just in prose.
- **The `late` → `after_timeout` rename** (`js/analytics.js:361–364`):
  when the coordinate guard (`/lat|…/`) collided with a desired property
  name, the property was renamed rather than the guard weakened. That is
  the right instinct, recorded in place.
- **Migration completeness.** Zero `new mapillary.Viewer`, raw `.moveTo`,
  or `MAPILLARY_TOKEN` references exist outside `js/viewer-ui.js`
  (grep-verified); `iv.destroy()` is paired at every discard site and is
  idempotent; every call-site purpose is a valid schema member.
- **Honest deviation records.** The implementation note in
  `docs/field-observability-plan.md:1040` lists eight deltas between plan
  and code, each with its reason — including discovering `anonymize_ips`
  was off and turning it on. This is the documentation habit that makes
  AI-speed development reviewable at all.
- **The failure-injection matrix** (`docs/failure-injection.md`): chaos
  hooks hostname-gated in pure tested code, a 24-scenario automated matrix,
  and a manual runbook that knows exactly what CI cannot prove.
- **Blocked-not-masked maps.** The insight that a tile URL *is* a
  coordinate — and the consequent `blockSelector` + network-waterfall-drop
  treatment — is a privacy analysis most teams would have missed entirely.
- **Scope defense in the beta plan.** §9's "what NOT to build" list (no PR
  previews, no second vendor, no service worker, no schema negotiation)
  is exactly how a design doc prevents future scope creep.
- **XSS discipline held under pressure.** Every new team-name render in
  the de-clutter pass uses `createElement`/`textContent`; the only HTML
  sinks remain Leaflet tooltips through `escapeHtml`.
- **Pool-health client etiquette**: 250-request cap, jittered pacing,
  429 abort with no state written, "inconclusive ≠ dead" semantics, and a
  runtime `filterQuarantined` that refuses to empty the pool.

---

## 3. Risk register

Severity counts: **1 × P0, 5 × P1, 6 × P2, 11 × P3.**

### P0 — ship stopper

**P0-1. Daily guess map: stale reference throws on first pin drop.**
`js/daily-ui.js:201` calls `guessMarker.on("move", updateLockNowHint)` but
the de-clutter pass renamed that function to `updateLockButton`
(`js/daily-ui.js:242`); no `updateLockNowHint` exists. *Failure:* the
first tap on the Daily guess map creates the marker, then throws
`ReferenceError` before `$("btnDLockIn").disabled = false` runs — the pin
appears but "Lock It In" stays disabled until a second tap, and the drag
listener is never attached, so dragging never refreshes the estimate for
the rest of the run. *Impact:* a core interaction of the retention
headline feature is broken on first use, in production. *Likelihood:*
every first-time pin drop on every Daily run. *Response:* one-line rename,
hotfix now (rollback not needed); add the HTML/JS contract test (§8 item
1) so this class of bug can never ship silently again. **Code.**

### P1 — fix before more feature work

**P1-1. Replay console capture can leak raw Mapillary image ids,
contradicting PRIVACY.md.**
`enable_recording_console_log: true` (`js/analytics.js:87`) ships console
output into replays. The wrapper deliberately rethrows the **original**
SDK rejection (`js/viewer-ui.js:387`), and five call sites log it raw:
`js/host-ui.js:1463`, `js/player-ui.js:813`, `js/screen-ui.js:321`,
`js/screen-h2h.js:277,393`. Mapillary rejection messages carry the image
id — the repo's own chaos example is `"Image 1234567890123456 does not
exist"` (`docs/failure-injection.md:22`), and the scrubbers exist because
"image ids reverse to places" (`js/imagery.js:120`). PRIVACY.md:60–62
promises "our own log lines reference the opaque pool code, never a real
image id." The privacy test that "scans the whole capture buffer"
(`tests/viewer-ui.test.js:226–229`) scans only `posthog.captured` —
events/exceptions — not the replay console channel, so it gives false
confidence on exactly this vector. *Impact:* the round's true location is
recoverable from the replay a human reviews — the same leak class the team
blocks map tiles for. *Likelihood:* moderate — needs a consented session
plus an imagery failure, but failures are precisely when replays get
watched. *Response:* at those five sites log the classified
`error_class` plus `scrubErrorMessage(e)` instead of the raw error (keep
console capture — it is genuinely useful); extend the replay checklist §4
to cover all failure-path warns. **Code.**

**P1-2. Four team-name sinks missing `data-ph-mask`, off-checklist.**
`#pLobbyNote` (`player.html:96`; rendered with the host team's name at
`js/player-ui.js:634`), `#pRevealNote` (`player.html:160`;
`js/player-ui.js:1450–1458`), the host guess hint (`host.html:153`;
`js/host-ui.js:744–751` interpolates the active team's name), and the
toast elements (team names flow through them, e.g. `js/player-ui.js:566`,
`js/host-ui.js:991`). `docs/replay-mask-checklist.md` claims to enumerate
"every element that renders user-entered text" and misses all four;
CLAUDE.md declares masking a ship-blocker. *Impact:* user-entered team
names in consented recordings, against the stated policy. *Likelihood:*
high — these screens appear in every game. *Response:* add `data-ph-mask`
to the three static elements; mask `#toast` wholesale (or strip names from
toast copy); update the checklist in the same change; add the static
checklist-presence test (§8 item 1). **Code.**

**P1-3. A viewer-init failure permanently burns the Daily's one run at
score 0.**
With a stub viewer (`iv.ok === false`: SDK blocked, WebGL off, offline),
`loadRoundImage` returns `{entry: null}` (`js/viewer-ui.js:459–465`) and
`js/daily-ui.js:148` treats that as pool exhaustion → `finishRun()` saves
a 0-round result under today's key — the day is replay-locked at score 0.
Pre-migration, the constructor throw was caught and retryable
(`js/daily-ui.js:110–124`). This violates the migration's own "no behavior
change" invariant on this path. *Impact:* a transient adblock/CDN blip
permanently zeroes a user's daily. *Likelihood:* low-moderate (adblockers
that block unpkg are not rare). *Response:* branch on `iv.ok === false`
before treating null-entry as exhaustion; show the retryable error.
**Code.**

**P1-4. The weekly pool-health automation is a permanent no-op.**
`tools/pool_health.mjs:50` quarantines after 2 consecutive dead runs, but
the failure counter only persists via the PR step
(`.github/workflows/pool-health.yml:58–66`), which is gated on the
threshold having already been met; the "Commit state only" branch
(`pool-health.yml:89–101`) — despite its name and comment — only echoes a
notice. `tools/pool-health-state.json` in `main` is still pristine, so
`fails` maxes at 1 forever and no quarantine PR can ever open. *Impact:*
fails safe (nothing wrongly quarantined) but the promised pool-decay
defense does not exist, and the job burns weekly API quota for nothing.
*Likelihood:* certain (structural). *Response:* actually commit/push the
state file in the `added == 0` branch (or persist via actions cache), and
note that `github.token` pushes don't trigger CI on the resulting PR
(P2-4). **Code + operational config.**

**P1-5. The manual verification runbook has never been executed.**
`docs/failure-injection.md:73` ("run once before trusting the dashboard")
and `docs/replay-mask-checklist.md` §5 ("verify on a real recording — do
this, don't assume") have no recorded results, and the de-clutter pass
subsequently changed screens the checklist covers — which per the
checklist's own rule requires a re-run. P1-2 is the proof this matters:
a real-recording pass would have caught the unmasked notes. The replay
kill-switch precedence question (does the client-side `startRecording()`
force-record override a disabled `replay-imagery-debug` flag?) is also
only answerable on a real device. *Impact:* every replay privacy promise
is currently *assumed*, not observed. *Response:* execute both runbooks on
a real phone after P1-1/P1-2 land; record results and date in the docs.
**Manual testing.**

### P2 — schedule soon

**P2-1. Stub viewer masquerades as "Location pool exhausted!" and ends
games for everyone.**
Couch: `js/host-ui.js:498–503` → `finishGame()`, auto-saving 0-score
standings to the leaderboard and firing `game_completed`. H2H:
`js/player-ui.js:700–712` — the host phone pushes `{phase: "gameOver"}`
to Firebase, ending the game for the whole room, with a fabricated winner
in the metrics. Pre-migration this path threw and the round simply never
started. *Response:* same branch as P1-3 — distinguish `iv.errorClass`
from exhaustion, show the degraded-imagery message, don't finish/push.
**Code.**

**P2-2. The beta plan's "verified current state" is wrong, creating a
double-deploy hazard if implemented as written.**
`docs/beta-deployment-plan.md:69–71` claims no deploy workflow exists —
but `pages.yml` landed in the plan's own parent commit (`c7f7369`). The
plan instructs authoring a *new* `deploy-pages.yml` and never says to
replace `pages.yml`; both would trigger on push to `main`, share
`concurrency group: pages`, serialize rather than cancel, and the last
finisher wins — `/beta/` would flap between live and 404. Three further
implementation traps found in the plan: `channelFromPath()` classifies a
dev checkout whose *filesystem* path contains `/beta/` as the beta channel
(contradicting the plan's own "file:// → production" claim, §5.1);
`deployment_channel` is slated for the async release-stamp glue, so early
events (initial `$pageview`) would pass prod KPI filters — it should
register synchronously at init; and `register()` sanitizes against
`RELEASE_PROPS` (`js/analytics.js:600–604`), which the plan never says to
extend, so a naive implementation registers nothing. The published
Firebase rules (README:145–158) do not cover `rooms-beta/` — the plan
owns this (fails closed) but it is the plan's single biggest
manual-step-or-nothing-works dependency. *Response:* amend the plan
before implementation (it is doc-only today, hence P2 not P1). **Doc,
then code.**

**P2-3. Viewer-ui test suite has order-dependent shared state and one
vacuous assertion.**
`js/viewer-ui.js` module singletons (`budget`/`deadDedup`/`facts`,
lines 47–58) are never reset between tests; the file's cumulative
`image_dead` emissions exactly exhaust the 5-per-class budget by the
pool-exhausted test, so adding or reordering one test breaks unrelated
assertions. The "imagerySession health" test
(`tests/viewer-ui.test.js:534–542`) asserts `health() === "failed"`, which
is already true from earlier tests' leftover facts — the path under test
could be broken and it would still pass. Two tests mutate
`location.hostname` / `posthog.init` and restore only at the end of the
test body (leaks on mid-test failure). *Response:* add a test-only reset;
rewrite the vacuous test; move restores to `finally`/`t.after`. **Code
(tests).**

**P2-4. Quarantine PRs get zero CI.**
Pushes/PRs created with `github.token` (`pool-health.yml:60,68`) do not
trigger workflows — the human reviews an unchecked change, likely
assuming green checks exist. *Response:* PAT/App token, or a prominent
note in the PR body. **Operational config.**

**P2-5. The timeout race silently broke the Daily's "same five spots for
everyone" invariant.**
A `moveTo` slower than 20 s now rejects and the sampler advances past a
*live* entry (`js/viewer-ui.js:294–364`), so on the Daily
(`js/daily-ui.js:145–146`, whose comment still asserts identical skips)
slow-network devices play different locations than everyone else while
the share card implies comparability. *Response:* product decision —
either accept and fix the comment, or exclude `network_timeout` from
seeded-sampler advancement on the Daily. **Code + product decision.**

**P2-6. No visual/browser evidence for the de-clutter pass (evidence
gap, not a proven defect).**
~470 changed CSS lines, DOM restructures on five screens, and a claimed
"≤2 non-game elements during play" success criterion — with no
screenshots, no browser run, no responsive or accessibility check
recorded anywhere in the range. The stale-reference P0 shows what this
gap lets through. *Response:* one manual pass on a phone-sized viewport
over the five §6 screens (guess map, player home, couch lobby, reveal,
consent moment), recorded in the PR/doc. **Manual testing.**

### P3 — worthwhile cleanup / monitor

- **P3-1.** Classifier message-fidelity is untested against the real
  SDK: fixtures and classifier can be wrong together
  (`tests/imagery.test.js:47–70` vs mapillary-js 4.1.2's actual rejection
  text); every failure would classify `sdk_unknown` and dashboards would
  mislead while 76 tests stay green. Covered by runbook item 6 — part of
  P1-5's execution. **Manual testing.**
- **P3-2.** TV `pano_session` accounting: `shownRoundNumber` not reset on
  viewer destroy/room follow (`js/screen-ui.js:278–305`), and h2h panels
  open exactly one session per game stamped with the creation-time round
  (`js/screen-h2h.js:273`). Observability-only skew on `tv`/`tv_panel`
  surfaces. **Code.**
- **P3-3.** `degradedNoticeShown` is per page load, not per game
  (`js/host-ui.js:123–129` and siblings) — comment and behavior disagree;
  harmless direction. **Code.**
- **P3-4.** ~120 lines of toast/SUPER-SURE-chip/sheet glue triplicated
  across host-ui/player-ui/daily-ui — the natural next extraction, given
  the pass already proved the pattern with `revealResultLine`/
  `lockButtonLabel`. **Code.**
- **P3-5.** Replay kill switch fails open if the flag were ever deleted:
  `js/consent.js:144` stops recording only on `=== false`; `undefined`
  (flag missing) keeps recording. The flag exists today (id 255025,
  verified in the implementation note), so this is a latent posture issue,
  not a live one. **Code.**
- **P3-6.** `noteReportSent()` increments before the send resolves
  (`js/report-ui.js:187`), so a failed send still marks the session
  "failed" in the health fold. Arguably a feature (the user *was*
  unhappy); decide and document. **Code.**
- **P3-7.** ~30–40 tests are constant-restatements
  (`tests/chrome.test.js:55–63`, `tests/pwa.test.js:26`, etc.) — count
  inflation, not coverage. The QR suite proves structure, never
  scannability (no round-trip against a reference decoder). **Code
  (tests).**
- **P3-8.** Workflow hygiene: `ci.yml` has no `permissions` block;
  actions are tag-pinned not SHA-pinned; `pool-health.yml` interpolates
  step outputs directly into `run:` scripts (safe today, injection-shaped);
  same-day re-runs collide on the dated branch name; a malformed
  `pool_quarantine.json` silently drops all previously quarantined ids;
  recovered ids are never un-quarantined. **Code/ops.**
- **P3-9.** "Quarantine PRs are never auto-merged" is convention only —
  no branch protection or required review enforces it. **Operational
  config.**
- **P3-10.** Doc drift: README:215–218 still describes tap-to-save
  leaderboard (it auto-saves since `3e26419`); `docs/architecture.md`
  still claims UI files are "kept logic-light" against a 1,776-line
  `player-ui.js`; `pages.yml` uses `deploy-pages@v4` while the beta plan
  says v5 is current. **Doc.**
- **P3-11.** Release tagging stopped at `v0.2.0-h2h`; the review brief's
  `v0.3.0` doesn't exist. `release.json` stamping covers deploy
  correlation, but tags are what humans (and review briefs) reach for.
  Tag meaningful trains. **Ops.**

---

## 4. Test/verification coverage map

**Proven (genuinely):** scoring/distance/phase math with property-style
tests; h2h deadlock regression; SUPER SURE settlement arithmetic; the
analytics *policy* layer (schema allowlist, consent gate incl. in-flight
revoke, one-shot diagnostic isolation, `POSTHOG_INIT_OPTIONS` mutability —
one of the few real-SDK-contract regressions actually encoded); the
imagery *policy* layer (scrubbers run against the entire real pool,
5,312-entry diag-id collision check, budgets, health classifier); shipped
pool data integrity; workflow syntax + suite on every push.

**Assumed (mock-dependent):** everything `tests/viewer-ui.test.js` and
`tests/report-ui.test.js` claim — their fake DOM's `getElementById` never
returns null (a missing-id bug is unrepresentable, which is exactly the
class of the P0), the fake Mapillary hardcodes event names and rejection
strings, and the fake posthog was written to match the code (including the
undocumented `__loaded` internal). The real SDK contracts — mapillary-js
4.1.2 message shapes, posthog-js named instances, script injection — are
untested and unverified in the field.

**Untested (no signal at all):** the consent banner DOM flow — the legally
load-bearing UI (`js/consent.js:159–308`, no test file); all Firebase
behavior (the `claimTeamSlot` transaction, onValue races, multi-client
ordering — the pure "identical snapshots produce identical patches" tests
don't touch the actual hazard); all five page controllers (~5,400 lines);
Leaflet; CSS/layout/responsive; cross-page flows; replay masking of
dynamically created nodes; the kill switch; anything visual.

The 448 green tests are necessary and real, but they are a statement about
the pure layer only. Every finding in §3's P0/P1 band lives outside them.

---

## 5. Architecture hotspots and complexity budget

The layered architecture (pure logic → thin glue → vendor SDKs) is the
repo's best asset and survived this release train intact. The
observability work *added* a layer correctly: decisions in `imagery.js`
(pure, 483 lines, tested), effects in `viewer-ui.js` (498 lines), capture
through the existing gate. The de-clutter pass extracted logic downward
(`revealResultLine`, `lockButtonLabel`, `chrome.js`) rather than growing
the controllers — the right direction.

But the controllers are past their stated budget. `player-ui.js` is 1,776
lines and `host-ui.js` 1,537 against an architecture doc that says UI
files are "kept logic-light" and covered by "syntax check only — by design
they should stay thin enough that this is acceptable"
(`docs/architecture.md:281–283`). That claim is no longer true, and §3's
findings cluster in exactly these files. The complexity budget call:
**stop growing them.** The next feature that needs controller code should
fund the toast/chip/sheet extraction (P3-4) first. `analytics.js` at 685
lines is fine — it is schema and comments, not branching. The wrapper
abstraction (`viewer-ui.js`) genuinely simplified: it deleted three
copy-pasted skip loops and centralized the failure surface; it did not
merely relocate complexity — though its module-singleton session state is
what makes its tests order-dependent (P2-3), a design tax worth noting.

One conceptual duplication to watch: session-health facts are folded twice
(client-side `facts` in viewer-ui, dashboard-side definition in
`classifySessionHealth`'s doc comment). Documented deliberately, but it is
two places for one truth.

---

## 6. Privacy/security audit conclusion

**Design: exemplary. Implementation: two real gaps, both fixable in
hours.** The core promises hold in code: PostHog is not loaded before
explicit accept (verified through `createAnalytics` and both loaders);
the schema allowlist and `BANNED_KEY_RE` make coordinate exfiltration
via events structurally hard; the one-shot diagnostic path is correctly
isolated (memory persistence, named instance, stored flag untouched);
`maskNetworkRequest` strips query strings and drops tile hosts; maps are
blocked, not masked; autocapture is restricted to button/link labels.
XSS discipline held; chaos hooks are production-inert; workflows carry
least-privilege permissions (except `ci.yml`'s missing block, P3-8);
no secrets exist in the tree by design.

The two gaps are P1-1 (raw SDK errors → replay console, contradicting
PRIVACY.md's explicit "never a real image id" promise) and P1-2 (four
unmasked team-name sinks, contradicting the checklist's claim of
exhaustiveness). Both are the *replay* channel — the newest and least
verified capture path — and both would likely have been caught by the
prescribed-but-unexecuted real-recording verification (P1-5). A third,
softer issue: PRIVACY.md states project-side facts ("Discard client IP is
enabled") that no code can enforce; the implementation note records it was
found off and turned on, which is honest — but it means the privacy page's
guarantees are partly operational claims that need periodic re-verification.

Firebase's open-rooms security model is documented, deliberate, and
proportionate to a party game; nothing in this range weakened it.

---

## 7. Operational readiness conclusion

**Deploy path: ready.** `pages.yml` is clean — least-privilege, correct
concurrency, tests gate the artifact, release stamping matches what
`consent.js` consumes exactly, and `release.json` can never be committed.
Rollback is `git revert` + push (~2 min workflow + up to 10 min Fastly
TTL); a faster re-run-old-workflow path exists today and would be lost
under the beta plan's branch-tip checkouts — a trade the plan should state.

**Pool health: not ready** — the automation is structurally inert (P1-4)
and its PRs would arrive without CI (P2-4).

**Observability operations: partially ready.** Dashboards, alerts, the
kill-switch flag and IP discard are recorded as manually configured, with
IDs, in the implementation note — good. But the fail-safe matrix is
uneven: masking/consent fail safe in code; the kill switch fails open if
the flag vanishes (P3-5); stage transitions, replay-budget review, and the
learning-mode exit are pure human process with no reminder mechanism — if
the owner stops doing them, Stage-1 100% recording runs until the free cap
bites. And the entire replay-privacy posture rests on a verification
runbook that has not been run (P1-5).

**Beta deployment: do not implement the plan as written** until P2-2's
amendments land. The design itself (single artifact, ff-only promotion,
revert-only main, path-derived channel) is sound and genuinely the only
first-party way to get a second URL out of GitHub Pages.

---

## 8. Prioritized stabilization plan (smallest high-leverage set)

1. **Fix the P0** (`updateLockNowHint` → `updateLockButton`, one line)
   and add the **static HTML/JS contract test**: every id referenced via
   `$()`/`getElementById` exists in its page's HTML (or is created in
   module code); every checklist-listed sensitive id carries
   `data-ph-mask`; the `mapillary-js` version in HTML equals
   `MAPILLARY_SDK`. Pure string work, no DOM — this one test retroactively
   covers the P0, P1-2, and the SDK-tag drift. (~half day)
2. **Close the replay leaks**: scrub the five failure-path `console.warn`
   sites (log `error_class` + `scrubErrorMessage(e)`), add `data-ph-mask`
   to `#pLobbyNote`/`#pRevealNote`/host guess hint, mask `#toast`, update
   the checklist. (~2 hours)
3. **Fix the stub-viewer conflation** in one small branch: `iv.ok ===
   false` → retryable degraded-imagery path on Daily (P1-3), couch, and
   h2h (P2-1); never `finishRun`/`finishGame`/`gameOver`-push on it.
   (~2 hours)
4. **Make pool-health real**: commit/push the state file in the
   `added == 0` branch; decide on the CI-on-PR token. (~1 hour)
5. **Execute the manual runbook** (failure-injection + masking checklist
   §5, including kill-switch precedence) on a real phone; record dated
   results in the docs. (~1 hour, after items 1–3)
6. **Add the schema↔call-site test** (scan `js/*.js` for `track("` names
   against `EVENT_SCHEMA`) — kills the documented silent-drop failure mode
   for good. (~1 hour)
7. **Amend the beta plan** per P2-2 before any implementation. (~1 hour,
   doc only)
8. **Viewer-ui test isolation** (P2-3): test-only reset, rewrite the
   vacuous health assertion, `finally`-restore the globals. (~2 hours)

Total: roughly one to two focused days. Everything else in §3 is
scheduled work, not a gate.

---

## 9. Do-not-touch list

Working, subtle, and load-bearing — further refactors here are risk
without reward:

- **The reveal-flip/settlement race discipline and the lock-in deadlock
  guard** (`docs/architecture.md` §write-ownership; `player-ui.js`
  onState guard). The identical-writes-collide-harmlessly reasoning is
  correct and fragile to "cleanup."
- **`createAnalytics()` and the consent gate core** — including the
  deliberately mutable `POSTHOG_INIT_OPTIONS` and the queue-drop-on-revoke
  path. Tests pin the invariants; don't restructure while fixing P1s.
- **The scrubbers and `poolDiagId`** (`js/imagery.js`) — validated against
  the whole real pool; extend call sites, don't "improve" the functions.
- **The write-ownership table and throttling discipline** (250 ms dirty
  flag, ≤4 writes/s) — the whole multi-device coherence story rests on it.
- **The QR encoder** — structure-tested and working in the field; do not
  refactor before a round-trip fixture exists (P3-7).
- **Chaos-hook gating** (`chaosAllowed`) — hostname-only by design; any
  "convenience" query param would create a production attack surface.
- **The pure-module layout itself** — the split is the reason this
  review could be evidence-based at all.

---

## 10. Final scorecard (1–10)

| Dimension | Score | Rationale |
|---|---|---|
| Architecture | **8** | The pure/glue split is real, enforced, and survived three fast commits; docked for controllers grown past the architecture doc's own stated budget. |
| Correctness | **6.5** | Core game/analytics logic is solid and race-aware, but a P0 shipped, and the wrapper migration violated its own "no behavior change" invariant on every stub-viewer path. |
| Tests | **7** | The pure layer's 448 tests are genuinely good (property-style, hostile-input-heavy, real-data-validated); docked for mock-fidelity blind spots, order-dependent viewer tests, and zero coverage of the layer where all shipped defects live. |
| Privacy | **7** | Best-in-class design and honest records; docked for two implementation gaps that contradict written promises and a verification runbook that exists only on paper. |
| Operations | **6** | Deploy pipeline is clean and rollback is real; docked for an inert pool-health automation, CI-less quarantine PRs, a heavy unverified manual-config surface, and a beta plan that conflicts with the shipped workflow. |
| Maintainability | **7.5** | Documentation is exceptional and deviation records make the work reviewable; docked for hotspot files, triplicated glue, and doc drift already appearing (README, architecture claims). |
| Release confidence | **6** | Tests+CI gate every deploy and release stamping works; docked for no browser/visual evidence on a UI-heavy release, no executed field verification, and tagging that stopped two trains ago. |

**Bottom line:** authorize continued development contingent on §8 items
1–5 landing first. The system is coherent and the team's habits —
pure-core extraction, honest deviation notes, schema discipline — are
exactly the ones that keep AI-speed development safe. The failure mode to
manage is verification debt: promises (privacy, automation, masking) that
are written, coded, tested against fakes — and not yet observed true in
the field.
