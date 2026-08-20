# Beta infrastructure removal plan — main-only Pages + verify-live gate

**Status:** Plan, awaiting Eduardo's approval; pinned Opus 4.8 implements the
repo change set (§2, §4), external steps per §3/§5. Nothing in this commit
changes code, workflows, settings, branches, or external systems.
**Date:** 2026-08-20. **Author:** Fable.
**Owner decision being executed:** abandon the beta lane. The product flow is:
reviewed candidate → explicit owner approval → push `main` → production Pages
deploy → **public release-stamp verification** → immediate `git revert` if
needed. This is Option E of `docs/beta-delivery-architecture-audit.md` §3,
chosen deliberately — a simplification, not a salvage operation.

**Live state verified for this plan (2026-08-20, read-only):**

- `git ls-remote`: `main` and `beta` both at `4641a74c6cc…`.
- Public root `release.json` (cache-busted): `run: "32388857835"`,
  `commit: 4641a74…` — production serving the last main-ref deploy.
  `/geoparty/beta/release.json` → 404 (beta was never publicly activated).
- `github-pages` environment branch policies (REST): exactly four entries —
  `beta` (id 57844047), `gh-pages` (57742536), `main` (57742537), and the
  accidental `text` (57844038).
- Local-only commits not yet pushed: `276feb1` (audit docs) and this plan.

---

## 1. Target steady state

After this plan is fully executed:

- **One branch matters: `main`.** No `beta` branch exists locally or on the
  remote; nothing recreates it.
- **One public route:** `https://earino-assistant.github.io/geoparty/`.
  `/geoparty/beta/` returns 404 (as it does today) and no repo, workflow,
  or doc text implies it should exist.
- **One Firebase namespace:** `rooms/`. `js/firebase.js` addresses it
  directly; `js/channel.js` no longer exists; the published console rules
  contain no `rooms-beta` block.
- **One PostHog lane:** no `deployment_channel` super property is registered
  or allowlisted; dev noise stays excluded by `release: "dev"` exactly as
  before B2.
- **One deploy workflow:** `pages.yml`, push-to-`main` + `workflow_dispatch`,
  shape of the pre-beta version (`c7f7369`) **plus a `verify` job** (§4).
- **Definition of "deployed" (the retained audit lesson):** a production
  deployment is complete **only** when the public root `release.json`,
  fetched cache-busted, stamps `run` equal to the deploying workflow's
  `github.run_id` (and `commit` equal to its `github.sha`). The workflow
  itself enforces this — a run cannot go green without it — and tests pin
  the job so it cannot silently disappear.
- **`github-pages` environment policy:** exactly one entry, `main`.
- **The audit documents survive verbatim** as permanent lessons
  (`docs/beta-delivery-architecture-audit.md`, `…-audit-spec.md`).

## 2. Repo removal scope — exact, file by file

One change set, implemented by Opus 4.8, reviewed by Fable, pushed only with
Eduardo's approval. Everything below lands in **one commit** (rationale in
§4.4 and §5).

### 2.1 `.github/workflows/pages.yml` — rewrite in place

Template: the pre-beta version, `git show c7f7369:.github/workflows/pages.yml`
— restore it essentially verbatim, then add the `verify` job (§4).

Removed: the `beta` push trigger, the `include_beta` dispatch input and its
guard expression, the `ls-remote` tip-resolution step, both pinned-SHA
isolated checkouts, the dual check/test steps, the `_site` assembly (rsync),
the per-channel stamps, the fail-loud beta marker step, and the
`path: _site` upload.

Retained/restored:

- Triggers: `on.push.branches: [main]` + plain `workflow_dispatch`
  (no inputs). The dispatch lever predates beta and stays — zero cost, and
  it is the stamp-refresh / re-publish escape hatch.
- Least-privilege permissions block, `concurrency: {group: pages,
  cancel-in-progress: false}` — both unchanged.
- Build: single default `actions/checkout@v4` (checks out `github.sha`),
  `setup-node` 22, `npm run check` + `npm test`, release stamp via inline
  `node -e` writing `release.json` at the workspace root with
  `{commit: GITHUB_SHA, short, deployed_at, run: GITHUB_RUN_ID,
  env: "pages"}` — the **`channel` and `ref` keys are dropped** (they were
  beta metadata; `js/consent.js` reads only `short`/`commit`/`deployed_at`,
  the verify job reads `run`, nothing reads `channel`/`ref`).
- Deploy job exactly as shipped: `configure-pages@v5`,
  `upload-pages-artifact@v3` with `path: .`, `deploy-pages@v4`.
- New: the `verify` job (§4), plus a rewritten header comment describing the
  main-only flow and citing the audit for why verify exists.

Accepted trade (stated, per the audit §4.1/§6.3): reverting to the default
checkout means checkout/stamp use `github.sha` again rather than a
run-start `ls-remote`. With a single branch there is no cross-ref
consistency to protect; the one rollback story is `git revert` + push.

### 2.2 `js/channel.js` and `js/firebase.js`

- **Delete `js/channel.js`** (and `tests/channel.test.js`, §2.5).
- `js/firebase.js`: remove the `roomsRoot` import and the module-scope
  `ROOMS_ROOT` computation (`js/firebase.js:16,27`); `roomRef()` composes
  `` `rooms/${code}${path ? "/" + path : ""}` `` directly. `roomRef()`
  remains the single choke point every room read/write/subscribe/transaction
  routes through — that property predates beta and stays. Update the
  comment block above it (drop the channel narrative).

Safety argument: production pages have always resolved
`channelFromPath(...) === "production"` → `"rooms"`; this change hard-codes
the value that every shipped client already computes. No data path changes
for any real user. The rules' `rooms/` block is untouched throughout.

### 2.3 `deployment_channel` — **decision: remove** (no independent purpose)

The brief asks for an explicit decision. Remove it entirely:

- In production it is single-valued (`"production"` on every event) — a
  constant carries zero product signal.
- Dev-noise exclusion never depended on it: `release: "dev"` does that, as
  it did before B2.
- No PostHog console filter or insight references it (to be confirmed as
  fact in §3.4 — none were ever configured).

Scope:

- `js/analytics.js`: `RELEASE_PROPS` (lines 427–430) returns to exactly
  `{release, commit, deployed_at}`; delete the `deployment_channel` entry
  and the channel narrative in the comment above it. `POSTHOG_INIT_OPTIONS`,
  the consent gate, `EVENT_SCHEMA`, sanitizers: untouched.
- `js/consent.js`: remove the `channelFromPath` import (line 18),
  `stampChannel()` (lines 115–130), and its two call sites (banner accept,
  line 241; returning-visitor path, line 332). `stampRelease()` and its
  ordering (`accept()` → `loaded.then(stampRelease)`;
  `analytics.init().then(stampRelease)`) are untouched. The §10.4
  diagnostic path is untouched.
- Historical note: production events captured between the `4641a74` deploy
  (2026-08-20 15:54 UTC) and the removal deploy carry
  `deployment_channel: "production"`. Harmless; documented in
  `docs/analytics.md` (§2.6) so the property's presence in history stays
  explicable.

Instrumentation rule compliance: this change removes behavior and adds no
decision point; no new event is justified — which ref published the site is
CI metadata (`release.json`), not a product signal (audit §7). Tests ship in
the same change (§2.5).

### 2.4 `README.md` — Firebase rules section

Replace the canonical ruleset (lines 144–167) with the production-only
version — the same JSON minus the entire `"rooms-beta"` block — and delete
the beta explanation paragraph (lines 169–181). Keep the top-level
`.read/.write: false` defaults, the `rooms/` block byte-for-byte, and the
"deliberately permissive" threat-model paragraph (lines 183–189). This
README text is what Eduardo pastes in §3.3, so the repo change must land
first (docs are the canonical copy; the console is made to match it).

### 2.5 Tests

- **Delete** `tests/channel.test.js` (its subject is deleted).
- **Rewrite** `tests/deploy-workflow.test.js` to pin the new contract:
  - kept: single-Pages-deploy-workflow invariant (exactly one workflow file
    matches `deploy-pages|upload-pages-artifact`); `ci.yml` never deploys;
    no `pull_request` trigger on `pages.yml`; concurrency
    `group: pages` / `cancel-in-progress: false`; first-party actions
    pinned (`configure-pages@v5`, `upload-pages-artifact@v3`,
    `deploy-pages@v4`);
  - changed: push trigger asserted as `branches: [main]` (beta absent);
    stamp asserted to write exactly the `{commit, short, deployed_at, run,
    env}` keys; upload `path: .`;
  - new: the verify-job pins of §4.3, and a global assertion that the
    string `beta` (case-insensitive) appears **nowhere** in `pages.yml`;
  - kept in adapted form (zombie guards): no file in `js/` contains the
    literal `rooms-beta`; no `js/` module builds a `"rooms/`-style DB path
    literal except `js/firebase.js` (`roomRef()` stays the sole composition
    site). Delete the `roomsRoot`-caller and `ROOMS_ROOTS` tests with their
    subject.
- **Adjust** `tests/analytics.test.js` — without reducing consent/privacy
  coverage:
  - delete the `deployment_channel`-specific block (lines ~903–983) and
    **replace** it with a pin that `RELEASE_PROPS` deep-equals
    `{release: "string", commit: "string", deployed_at: "string"}` — the
    allowlist can neither silently regrow the channel key nor lose a key
    `consent.js` registers;
  - the super-property **ordering** tests (fresh-accept flushes
    `consent_given` after registered props are applied, line ~661;
    returning-visitor queued events flush after `register()`, line ~926)
    used `deployment_channel` as their vehicle — **retarget them to
    `release`**, do not delete them: the buffered-register-before-flush
    property is general consent machinery, not beta machinery;
  - same for the register-is-consent-gated test (line ~918): keep, using a
    `release` payload;
  - every other consent/sanitizer/replay/diagnostic test: untouched.
- `npm test` and `npm run check` green before the change is complete
  (repo rule; both run in CI).

### 2.6 Docs

- `docs/beta-delivery-architecture-audit.md`, `…-audit-spec.md`:
  **unchanged, kept permanently** — they are the record of the incident and
  the source of the verify-live rule. Historical, not operational.
- `docs/beta-deployment-plan.md`: historical but currently reads as an
  active spec. Add a short **RETIRED** banner at the very top ("Retired
  2026-08-XX by owner decision; the beta lane was removed — see
  `docs/beta-delivery-architecture-audit.md` §8.5 and
  `docs/beta-removal-plan.md`. Kept as history; nothing below is
  operational."), body otherwise untouched. Do not delete it — the audit
  cites it by section.
- `docs/analytics.md`: delete the `deployment_channel` section (lines
  114–152) and replace with a three-line *Retired properties* note: name,
  the 2026-08-20 window in which production events carried
  `deployment_channel: "production"`, and a pointer to this plan. The
  release-super-properties paragraph above it stays.
- `docs/architecture.md`: remove the `js/channel.js` row (lines 17–18);
  rewrite the "Deployment channels" paragraph (lines 92–105) as a
  "Deployment" paragraph: main-only `pages.yml`, root `release.json` stamp,
  and the verify job's green-means-live guarantee; fix the `rooms-beta`
  mention in the Firebase paragraph (lines 117–118).
- `docs/beta-removal-plan.md` (this file): after execution, Opus updates the
  Status line to "Executed <date>"; it then joins the historical record.
- `README.md`: §2.4. `docs/field-observability-plan.md`: no beta
  references (verified by grep) — untouched; its §11 stamping design is
  exactly what verify consumes.

### 2.7 What stays, explicitly

Untouched: `ci.yml`; consent banner/revoke flow and the §10.4 diagnostic;
all replay masking; `EVENT_SCHEMA` and every event call site; `js/consent.js`
release stamping; `.gitignore` (`release.json` stays ignored);
`config.js`; the `rooms/` rules block; all game/UI modules; tags
(`v0.1.0-couch`, `v0.2.0-h2h`, `v0.3.0`); `tools/`, `data/`.

## 3. External cleanup — owner/agent actions, order, rollback

All external steps are listed here once and sequenced in §5. "Agent" means
an approved agent acting with Eduardo's explicit go; every step states its
rollback. **No data is deleted anywhere** — the only data ever under
`rooms-beta/` was the validation test room, already deleted during the B-lane
REST checks.

### 3.1 GitHub `github-pages` environment branch policy — final state: `main` only

Remove three entries, keep one. Via UI (Settings → Environments →
github-pages) or REST
(`DELETE /repos/earino-assistant/geoparty/environments/github-pages/deployment-branch-policies/{id}`):

| Entry | id | Action | Why |
|---|---|---|---|
| `beta` | 57844047 | **delete** | the incident's enabler; with it gone, any beta-ref deploy fails loudly at the gate (observed working: run 32392639719 attempt 1) |
| `text` | 57844038 | **delete** | accidental UI entry during the incident |
| `gh-pages` | 57742536 | **delete** | vestigial; meaningless under `build_type: workflow` (audit §8.3) |
| `main` | 57742537 | **keep** | the only ref that may deploy |

Rollback: re-add a name via
`POST …/deployment-branch-policies {"name": "<branch>"}` — fully reversible,
no deploy triggered, production unaffected.

Recommended executor: agent via REST with Eduardo watching (the stray `text`
entry is evidence the UI path is mishap-prone); Eduardo's call (§7 D2).

### 3.2 Delete the remote `beta` branch

`git push origin :beta` (or UI). Facts making this safe:

- `beta` == `main` == `4641a74` — zero unique commits are lost.
- Branch deletion does not trigger push workflows (GitHub-documented; also
  restated in the beta plan §2). No deploy runs.
- The public site is untouched (nothing was ever served from beta).

Rollback: `git push origin 4641a74c6cc81e3f66e3cb71beb3fb95756a8cef:refs/heads/beta`.

### 3.3 Firebase console — remove the `rooms-beta` rules block

Executor: Eduardo (console access), ~5 minutes, **after** the repo change is
deployed and verified (§5), so the console is pasted from the then-current
canonical `README.md`:

1. **Back up:** Firebase console → project `geoparty-9ffe7` → Realtime
   Database → Rules; save the full current text to a local file
   (`rules-backup-2026-08-XX.json`). This file is the rollback.
2. **Sanity-check** the backup equals the *pre-removal* README ruleset
   (i.e. contains both `rooms` and `rooms-beta`). A difference means live
   drift — stop and report before proceeding.
3. **Replace** the editor contents with the production-only ruleset from
   the updated `README.md` (top-level denies + `rooms/` block only).
4. **Publish** (the console rejects syntactically invalid rules; on any
   error, restore the backup and report).
5. **REST-validate** (§6.6).

Rules edits touch zero data. `rooms/` is byte-identical before and after.
Rollback: paste the backup, publish.

### 3.4 PostHog — verify the no-filters fact, then nothing

Expected fact (per the audit §9.6 the beta filters were **never**
configured): no "Filter out internal and test users" condition, no insight
filter, and no dashboard filter references `deployment_channel` or
`/beta/`. Eduardo confirms this in the project settings + the
`docs/analytics.md` KPI insight list **before** any cleanup; if the fact
holds (expected), there is no PostHog cleanup at all. If some filter is
found, delete just that filter — never touch events, the init key/options,
or captured data. Historical events keep their
`deployment_channel: "production"` property; stored properties on past
events are data, not configuration, and are left alone.

## 4. The public release verification job — specification

### 4.1 Placement and trigger

A `verify` job in `pages.yml` (the single deploy workflow), `needs: deploy`
— so it runs only after a successful production deploy, and only from this
workflow, which after §2.1 can only run from `main` (push or dispatch).
Default job behavior already skips it if `deploy` fails; no extra condition
needed. Runner: `ubuntu-latest`, `timeout-minutes: 8` (backstop above the
in-script timeout), plain `curl` + shell, **no elevated permissions** (set
job-level `permissions: {}` — the job only reads a public URL).

### 4.2 Contract (Opus implements; exact shell is theirs)

- Expected values: `run` = `$GITHUB_RUN_ID`, `commit` = `$GITHUB_SHA`.
- Poll `https://earino-assistant.github.io/geoparty/release.json` up to
  **30 attempts, 10 s apart (~5 min budget)**.
- **Every attempt uses a fresh cache-busting query**, e.g.
  `?verify=${GITHUB_RUN_ID}-${attempt}`. Rationale: Pages serves
  `cache-control: max-age=600` through Fastly and custom headers cannot be
  configured (GitHub-documented limitation; audit §2.1); Fastly caches per
  full URL including the query string, so a *unique* query per attempt
  guarantees each poll can observe fresh origin state, while *reusing* one
  query could pin a stale/404 answer in the edge cache for up to 10
  minutes. This is the core false-red defense.
- Success: the body contains **both** `"run":"<GITHUB_RUN_ID>"` and
  `"commit":"<GITHUB_SHA>"` (fixed-string matches are sufficient — the
  stamp is single-line JSON with string values). Job exits 0.
- Any non-200, curl failure, or mismatch → sleep and retry (transient CDN
  5xx/404s are retries, never instant failures).
- Exhausted attempts → **fail the run** (exit 1), printing: expected
  run/sha, the last fetched body, and the explicit message that a red
  verify means *the new deployment did not publicly activate* — the
  previous deployment is still serving, the site is **not** down, and the
  remedy is investigate → re-run failed jobs (a re-run re-polls under the
  same `GITHUB_RUN_ID`, so late propagation turns it green without
  redeploying).

False-red analysis: observed activation latency in this repo is ~15–30 s
(run 32388857835: deploy 15:54:13–27, stamp live by the next probe); the
5-minute budget is ~10–20× that. Overlapping deploys cannot race the check:
the workflow-level `pages` concurrency group holds until the whole run —
including `verify` — completes, and `cancel-in-progress: false` protects it,
so no newer run can overwrite the stamp mid-poll. The residual false-red
(Pages propagation >5 min, i.e. a platform incident) is handled by the
re-run remedy above and is precisely a case a human should look at anyway.

### 4.3 Tests: verify cannot silently disappear

`tests/deploy-workflow.test.js` (rewritten, §2.5) pins lexically:

- a `verify:` job exists with `needs: deploy`;
- it references the literal public root `release.json` URL;
- it compares against `GITHUB_RUN_ID` (and `GITHUB_SHA`);
- a retry loop with a sleep and a bounded attempt count exists;
- the cache-busting query pattern is present;
- `deploy` has no other successor that could be confused for verification.

These are the same style of dependency-free lexical pins the repo already
uses for workflow contracts; deleting or defanging the job goes red locally
and in CI.

### 4.4 Same change, not a follow-up — **required**

The verify job ships **in the same commit** as the beta removal. Three
reasons: (a) the removal deletes the beta lane, whose entire purpose was
pre-production verification — its replacement guarantee must exist before
the next production deploy, and the removal push *is* the next production
deploy; (b) that push exercises the incident's exact failure class
(green-but-inert) and must prove its own activation; (c) the workflow file
for a push is read from the pushed ref, so the removal push runs the new
workflow — verify validates the very deploy that ships it. Splitting them
would create a window with neither beta nor verification.

## 5. Sequencing

| Phase | Actor | Action | Production impact |
|---|---|---|---|
| 0 | Eduardo | Approve this plan (and defaults in §7) | none |
| 1a | agent (or Eduardo), §3.1 | Environment policy → `main` only | none; closes the beta deploy gate loudly |
| 1b | agent (or Eduardo), §3.2 | Delete remote `beta` branch | none; deletion triggers nothing |
| 2 | Opus 4.8 | Implement §2 + §4 locally; `npm test` + `npm run check` green; Fable review; Eduardo approves push | none (local) |
| 3 | agent, on approval | **One push to `main`** carrying `276feb1` (audit docs), this plan's commit, and the removal commit. The push runs the *new* `pages.yml`; green requires `verify` | one normal production deploy; content is unchanged app code (the removal deletes only never-reachable branches of behavior) plus docs |
| 3v | agent + Eduardo | Confirm run green incl. verify; belt-and-braces manual cache-busted `curl` of the root stamp; `/beta/` still 404 | — |
| 4 | Eduardo | Firebase rules removal + REST validation (§3.3, §6.6) | none (`rooms/` byte-identical) |
| 5 | Eduardo | PostHog fact-check (§3.4) | none |
| 6 | Eduardo | Production smoke test (§6.4) | none |

Ordering rationale:

- **1a/1b before 3** is the anti-re-trigger guard the brief demands: after
  1a, even an accidental beta-ref deploy fails at the environment gate
  (observed mechanism, attempt 1 of the incident — and a *failed* deployment
  record does not deactivate its predecessor); after 1b there is no beta
  ref to push to at all. Between 1b and 3, the still-current workflow's
  bootstrap path (`beta_sha=""`) handles the branch's absence — already
  proven by the pre-beta-era runs.
- **4 after 3** so the console is pasted from the updated canonical README
  (repo-first, console-matches-docs). Deferring 4 is safe indefinitely
  (§8): the block is unreachable dead config guarded by deny-by-default.
- Production serving is never interrupted: phases 1a/1b/4/5 touch no
  serving path; phase 3 is an ordinary main deploy behind check+test and
  now behind verify.

**Rollback of the removal change:** `git revert <removal-commit>` on `main`,
push. That restores the B0–B2 code and the beta-capable workflow, which runs
correctly with no `beta` branch (bootstrap path) and deploys from `main`
(allowed by the tightened policy) — so the revert needs *no* external-state
restoration to be safe. Re-adding the branch/policy/rules (§3 rollbacks)
is needed only if the beta lane itself is being readopted.

## 6. Acceptance verification

1. **Local:** `npm test` all green; `npm run check` all green (also both in
   CI on the push).
2. **Pages run:** the phase-3 run is green **including `verify`**; the
   Actions log shows the matched stamp.
3. **Live stamp (manual, once):**
   `curl -s "https://earino-assistant.github.io/geoparty/release.json?accept-$(date +%s)"`
   → `run` equals the phase-3 run id, `commit` equals the pushed `main`
   SHA, and no `channel`/`ref` keys.
4. **/beta/:**
   `curl -s -o /dev/null -w '%{http_code}' "https://earino-assistant.github.io/geoparty/beta/?accept-$(date +%s)"`
   → `404` (unchanged from today — it was never live).
5. **Product smoke (Eduardo, ~5 min, after phase 3; repeat one room-create
   after phase 4):** host a Couch game on production, join with a phone via
   QR, play a round; spot-check an H2H room join. In the Firebase data
   view, the room appears under `rooms/`.
6. **Firebase REST (after phase 4)** — `DB=https://geoparty-9ffe7-default-rtdb.europe-west1.firebasedatabase.app`:
   - `PUT $DB/rooms/ZZZZZZ.json` with `{"createdAt":<now-ms>}` → **200**;
     `DELETE` it → **200** (production allowlist intact);
   - `PUT $DB/rooms/ZZZZ.json` → **401** (validation intact);
   - `PUT $DB/rooms-beta/ZZZZZZ.json` → **401** (namespace now denied by
     the top-level defaults — the removal's positive proof).
7. **GitHub API state:**
   `GET /repos/earino-assistant/geoparty/environments/github-pages/deployment-branch-policies`
   → exactly one entry, `main`; `git ls-remote origin` → no
   `refs/heads/beta`.

## 7. Owner decisions remaining (defaults recommended)

| # | Decision | Recommended default |
|---|---|---|
| D1 | Approve this plan and the §2/§4 change set for Opus 4.8; approve the phase-3 push | approve — it executes the already-made abandon decision |
| D2 | Who executes §3.1/§3.2 (GitHub policy + branch deletion) | agent via REST, Eduardo watching; UI self-service equally fine |
| D3 | Firebase rules removal (§3.3): executor + timing | Eduardo, in one sitting with §3.4, after phase 3v; deferral is safe (§8) but finishing it closes the file |
| D4 | Keep `workflow_dispatch` on `pages.yml` | keep — pre-beta feature, zero cost, re-publish/stamp-refresh hatch |
| D5 | Delete the `gh-pages` policy entry along with `beta`/`text` | yes — vestigial under `build_type: workflow`; re-adding is one API call if a legacy-branch fallback is ever adopted |

**When Eduardo tests:** after phase 3v (the §6.5 smoke), and one more
room-create after phase 4. Total hands-on time: ~15 minutes including the
Firebase console session.

## 8. No-sunk-cost audit of the existing beta infrastructure

Verdict per component; nothing is retained on sunk-cost grounds:

| Component | Verdict | Rationale |
|---|---|---|
| `pages.yml` beta machinery (trigger, resolve, dual trees, assembly, markers, `include_beta`) | **remove now** | The core complexity. Dormant retention is a trap: it keeps `beta` in the push triggers, so a recreated branch would resurrect the exact incident behavior (publicly inert deploys that corrupt the deployment history, audit §2.5) |
| Remote `beta` branch + `beta`/`text`/`gh-pages` policy entries | **remove now** | The branch is content-identical to `main`; the policy entries are the incident's enabler, an accident, and a vestige. Removal is instantly reversible (§3.1–3.2) |
| `js/channel.js` + Firebase routing + `deployment_channel` (code, tests, docs) | **remove now** | The audit (§8.5) called client-side retention "optional — pure, harmless"; harmless is not the bar under an owner decision to simplify. It is dead configurability: production always resolves to the same values, and every kept line carries test scaffolding, doc text, and reviewer attention. Removal risk is ~zero (§2.2–2.3) |
| Firebase console `rooms-beta` rules block | **remove (§3.3); temporary dormancy acceptable** | The one component where deferral is genuinely cheap and safe: it is unreachable dead config (no client, no `/beta/` route, protected by top-level deny-defaults — before B-lane it was *already* denied), and its removal is the only step with any console-paste risk at all. If Eduardo defers: precise removal condition is **before the next Firebase rules edit of any kind, and no later than the next console rules session** — a stale extra block in a security ruleset must never survive into an unrelated edit. The repo's canonical README copy is cleaned in phase 3 regardless, so dormancy means "console temporarily has one extra inert block than the docs", explicitly noted |
| Per-channel `release.json` keys (`channel`, `ref`) | **remove now** | Nothing consumes them; keeping keys "for later" is how zombie schemas start |
| Release stamping + `consent.js` release super properties | **keep** | Pre-beta observability (field-observability plan §11); now also the substrate of the verify job |
| Workflow-contract test scaffolding (`tests/deploy-workflow.test.js` approach) | **keep, rewritten** | The lexical-pin technique is proven; it now guards the main-only shape and the verify job |
| Audit docs (`beta-delivery-architecture-audit*.md`) | **keep verbatim, permanent** | The lessons (green ≠ live; source-first platform validation; walk the skeleton first) outlive the lane they came from |
| `docs/beta-deployment-plan.md` | **keep with RETIRED banner** | Historical record cited by the audit; the banner stops it reading as operational guidance |
| The verify-live principle itself | **keep and harden (§4)** | The single thing the beta effort proved beyond doubt: the public stamp is the only activation oracle. It becomes workflow-enforced for production |
