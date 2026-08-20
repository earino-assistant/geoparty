# Beta delivery architecture audit

**Status:** Complete — audit only; no code, workflow, settings, rules, or branch
was modified.
**Date:** 2026-08-20 (evidence gathered 16:53–16:57 UTC).
**Auditor:** Fable, per `docs/beta-delivery-architecture-audit-spec.md`.
**Method:** Every load-bearing claim below was re-verified first-hand against
the GitHub REST API, the actual Actions run and its downloaded artifact, the
live public endpoints, and official GitHub documentation / action sources.
Nothing was taken from the prior plan, the B0–B2 review chain, or the incident
narrative without independent confirmation — and one detail of the incident
narrative turned out to be wrong (§2.6).

---

## 1. Executive verdict

**Keep the single-site `/beta/` model. Abandon the beta-ref deploy trigger.
`/beta/` must only ever be published by a main-ref run of `pages.yml`, and no
deploy may be called done until the public `release.json` stamps are fetched
and match the run id — a check that should be automated into the workflow
itself.**

Concretely (details in §5–§8):

1. Remove `beta` from `pages.yml`'s push triggers (`on.push.branches: [main]`).
   `workflow_dispatch` — always dispatched **on `main`** — becomes the beta
   publication command.
2. Restrict the `github-pages` environment branch policy to `main` only.
   This converts the incident's failure mode (beta-ref deploy accepted but
   publicly inert) into a loud, immediate deploy-job failure — a mechanism we
   have already observed working (§2.3, attempt 1).
3. Add a post-deploy **public-endpoint verification job** to `pages.yml`:
   poll `…/geoparty/release.json` (and `…/geoparty/beta/release.json` when
   beta was included) until the `run` field equals the workflow's own run id;
   fail the run after a timeout. After this change, a green run *means* the
   public site changed — by construction, not by hope.
4. Before declaring the lane open, run **one live validation dispatch (V1)**
   on `main` with the beta branch present, and confirm both public stamps.
   This is the one composition the incident never tested (§4.1).

This is a small delta: roughly one trigger line, one new workflow job, one
test-file update, and a settings cleanup. Nearly all B0–B2 work (dual-tree
build, per-channel stamps, beta PWA/noindex markers, `js/channel.js`, Firebase
`rooms-beta` rules) is reusable unchanged — but that is a *consequence* of the
recommendation, not its justification. The justification is that main-ref
activation is the only Pages activation path that is both documented and
repeatedly observed working in this repository (§4.1), and the recommendation
was checked against the alternatives on its own merits (§3–§4).

**Fallback:** if the V1 validation dispatch fails (i.e. a main-ref artifact
containing `/beta/` does not activate publicly — assessed very unlikely,
§4.1), do not iterate on cleverer Pages mechanics. Fall back to Option E
(no beta lane: release tags + immediate post-deploy production verification +
`git revert`), and revert the beta infrastructure per §8.4.

---

## 2. Incident reconstruction — independently re-verified

### 2.1 Timeline (all times 2026-08-20 UTC; all facts from the GitHub API unless noted)

| Time | Event | Evidence |
|---|---|---|
| 15:53:52 | Push of `4641a74` to `main` triggers `pages.yml` run **32388857835** (attempt 1, success). | `GET /actions/workflows/pages.yml/runs` |
| 15:54:13–15:54:27 | Deployment **6005860397** (`ref=main`, `sha=4641a74`) created; status `success`, `environment_url=https://earino-assistant.github.io/geoparty/`. Site activates: live `release.json` stamps `run: 32388857835`. | `GET /deployments`, `/deployments/6005860397/statuses`; live probe |
| ~16:33 | `beta` branch created at exactly `4641a74` (still true at audit time: `git ls-remote` shows `main` and `beta` both at `4641a74c6cc…`). | `git ls-remote origin` |
| 16:33:16 | Push to `beta` triggers run **32392639719** attempt 1. Build job fully green (both trees checked out, tested, artifact assembled, stamped, uploaded). Deploy job **fails**: deployment **6006500330** (`ref=beta`) status `failure` — the environment branch policy did not yet allow `beta`. | `GET /actions/runs/32392639719/attempts/1/jobs`, `/deployments/6006500330/statuses` |
| ~16:35 | `beta` added to the `github-pages` environment's custom branch policies (present at audit time alongside `gh-pages`, `main`, and a stray `text` entry — §8.3). | `GET /environments/github-pages/deployment-branch-policies` |
| 16:38:19–16:38:36 | Attempt 2: build green again; `actions/deploy-pages@v4` **succeeds**. Deployment **6006573036** (`ref=beta`, `sha=4641a74`) reaches state `success` with `environment_url=https://earino-assistant.github.io/geoparty/`, and the prior main deployment 6005860397 is marked **`inactive`** at 16:38:36. | attempt-2 jobs; `/deployments/6006573036/statuses`; `/deployments/6005860397/statuses` |
| 16:53–16:57 | Live probes (cache-busting query strings): `/geoparty/release.json` → HTTP 200, still `{"run":"32388857835", …, "deployed_at":"2026-08-20T15:54:06Z"}`; `/geoparty/beta/` → **404**; `/geoparty/beta/release.json` → **404**. Pages serves `cache-control: max-age=600`; the probes ran 15–19 minutes after the "successful" beta deployment, so this is not caching. | live probes, this audit |

### 2.2 The artifact was correct

I downloaded the actual Pages artifact of run 32392639719 (artifact id
9415587877, 230 files, unexpired) and inspected it directly:

- `./release.json` → `{"commit":"4641a74…","run":"32392639719","channel":"production","ref":"main"}`
- `./beta/release.json` → `{"commit":"4641a74…","run":"32392639719","channel":"beta","ref":"beta"}`
- `./beta/manifest.webmanifest` → `name: "GeoParty Beta"`, `short_name: "GeoParty β"`
- `./beta/index.html` → contains the `noindex` robots meta.

The build machinery works. The failure is purely in **activation**.

### 2.3 Three layers, three different answers

The spec demands the distinction; the incident is its perfect illustration:

| Layer | Beta-ref run 32392639719 (attempt 2) | Ground truth |
|---|---|---|
| **Static artifact correctness** | ✅ verified by direct download (§2.2) | correct |
| **GitHub deployment record** | ✅ `success`, `environment_url` set, predecessor deployment marked `inactive` | **misleading** |
| **Public endpoint activation** | ❌ site unchanged; `/beta/` 404, root stamp still the *prior* run's | the only truth |

The deployment record is worse than useless here — it is actively deceptive.
The beta-ref deployment not only reported success; it **deactivated the
record of the main deployment that was actually serving the site**. Every
GitHub UI/API surface (Actions run ✅, environment history, deployment
statuses) claimed the beta deployment was live. Only fetching the public URL
revealed otherwise.

### 2.4 The missed assumption, stated precisely

The B0–B2 plan assumed: *"a Pages deployment accepted by the `github-pages`
environment (branch policy permitting the ref) activates the public site."*

The correct model, per official sources and observation, is:

- The environment branch policy gates whether a deployment is **accepted**
  (attempt 1's failure proves it gates; attempt 2's inert success proves
  acceptance ≠ activation).
- Public **activation** of a project's one Pages site by a custom workflow is
  a **default-branch behavior**. GitHub's official guidance for custom
  workflows ("Configuring a publishing source for your GitHub Pages site")
  builds the deploy path exclusively around the default branch: *"Trigger
  whenever there is a push to the default branch of the repository or
  whenever the workflow is run manually from the Actions tab"* and *"If the
  workflow was triggered by a push to the default branch, use the
  `actions/deploy-pages` action to deploy the artifact."* It also recommends
  a protection rule *"so that only the default branch can deploy to this
  environment."* Nowhere does any official source promise that a
  non-default-branch deployment activates the public site.
- The `actions/deploy-pages` README confirms the only sanctioned
  non-default-branch publication concept is previews, and rules it out:
  the `preview` input is *"only in alpha currently and is not available to
  the public!"* Its OIDC section describes ref claims being validated to
  decide *"if that workflow is allowed to deploy to pages"* — again
  acceptance, not activation semantics.
- Observed behavior of an accepted non-default-branch deployment: a complete,
  convincing success record and **no public change** (§2.1, §2.3).

Whether the silent no-op is a deliberate platform rule or an undocumented
edge, the conclusion for us is identical: **non-default-branch Pages
activation is undocumented at best and observed broken in this repository.
Nothing may be built on it.**

### 2.5 Aggravating design detail: the shared concurrency group

`pages.yml` triggers on pushes to `main` *and* `beta` under one `pages`
concurrency group. Because beta-ref deploys are publicly inert but still
supersede deployment records (§2.3), any beta push silently rewrites the
deployment history out from under the last real production deployment. The
repo's deployment log currently *lies about what is live*. This is an
additional reason the beta push trigger must go, independent of the 404.

### 2.6 Correction to the spec's incident record

The spec states the beta-ref deployment reported `production_environment:
false` while *"the main-ref deployment was production."* The API disagrees:
**every** `github-pages` deployment in this repository — main-ref and
beta-ref alike — carries `production_environment: false` and
`transient_environment: false` (verified across the last 10 deployments).
There is **no field in the deployment records that distinguishes the
activating main-ref deployments from the inert beta-ref one.** This makes the
core lesson stronger than the spec assumed: no GitHub-side metadata can be
used as an activation proxy. The public endpoint is the only oracle.

---

## 3. Options matrix

| # | Option | Public URL phones can reach | Activation mechanism | Documented? | Observed working here? | Prod risk | New surfaces | Verdict |
|---|---|---|---|---|---|---|---|---|
| **A** | **Main-ref publication of the combined main+beta artifact** (push to `main`, or `workflow_dispatch` on `main`; beta tip resolved at run time) | ✅ `…/geoparty/beta/` | `deploy-pages` from the default branch — the same path every production deploy already uses | ✅ default-branch custom-workflow deploy is the documented path (§2.4) | Main-ref activation: ✅ ≥6 consecutive times in the deployment log. Combined artifact from a main-ref run: ⚠️ not yet — requires the one-shot V1 validation (§4.1) | Low; fail-closed build; verification job makes green = live | None | **Recommended** |
| **B** | Beta-ref auto-deploy on push to `beta` (the B0–B2 trigger as shipped) | ❌ observed 404 | Non-default-branch `deploy-pages` | ❌ undocumented | ❌ **observed failing** (run 32392639719: green record, no public change, deployment history corrupted) | Indirect but real: deceptive deploy records; shared concurrency group | None | **Rejected on evidence** |
| C1 | Second repository (`geoparty-beta`) publishing its own Pages site from its default branch | ✅ different origin/path | Default-branch deploy in the second repo — documented and reliable | ✅ | n/a | Low for prod | Second repo, cross-repo push automation (a PAT/deploy-key **secret**), `js/channel.js` no longer matches (`/geoparty-beta/` does not contain `/beta/` → would self-classify as **production** and write to production Firebase rooms — a live hazard, not a nit) | Viable but declined: violates the stated no-second-repo constraint and needs channel-detection surgery |
| C2 | PR-artifact review: download the `github-pages` artifact, serve locally | ❌ local only | none (no deploy) | ✅ | ✅ (this audit did it) | Zero | None | Not sufficient alone — a party game needs a URL that phones + a TV can hit. Useful **supplement** for code review |
| C3 | Pages preview deployments (`deploy-pages` `preview` input) | — | — | ❌ *"only in alpha … not available to the public"* (README, §2.4) | n/a | — | — | **Unavailable**; spec non-goal (no assuming future Pages features) |
| C4 | Legacy branch publishing: switch Pages source to a `gh-pages` branch; a main-ref dispatch-only workflow commits the assembled `_site` to it | ✅ same URLs as A | Pages' own branch-build pipeline — activates on every push to the source branch | ✅ (decade-old path) | n/a here | Low, but the entire live site becomes a force-pushed branch | `contents: write` permission, a commit per deploy (breaks the repo's nothing-committed-per-deploy invariant), Jekyll/`.nojekyll` handling, a second publishing pipeline to reason about | Sound **fallback #2** if V1 ever failed; strictly more moving parts than A |
| D | External preview host (Netlify / Cloudflare Pages / Vercel) | ✅ different origin | Vendor CI/CD | ✅ | n/a | Low for prod | Vendor account, token as a repo **secret**, separate permissions/config, different origin (PWA scope/install identity, PostHog super-property review, channel detection changes), second dashboard to operate | Rejected — not operationally free (spec non-goal), and unjustified while A exists |
| **E** | No beta lane: release tags, deploy to production, verify immediately, `git revert` on failure | ✅ (production itself) | Existing main-ref deploy | ✅ | ✅ | Candidate defects reach real users for minutes; test sessions land in production analytics (channel stamp mitigates) | None | Honest **fallback #1** if V1 fails or the owner declines the beta lane. Fails the audit question's core requirement: verification *before* production exposure |

Per the spec's instruction, no option was credited for salvaging existing
work; A wins because its activation mechanism is the only one that is
documented, already repeatedly observed in this repo, adds zero new
surfaces, and preserves a pre-production verification URL.

---

## 4. Reliability and complexity comparison

### 4.1 What is proven vs. what V1 must prove

Option A composes two facts:

1. **Main-ref runs activate the public site.** Proven: every one of the last
   six main-ref runs produced a deployment whose content was verifiably
   served (the current live stamp traces to main-ref run 32388857835;
   earlier stamps followed the same pattern). This is also exactly the
   documented custom-workflow path (§2.4).
2. **The build produces a correct combined artifact when `beta` exists.**
   Proven by direct inspection of run 32392639719's artifact (§2.2). Build
   steps are identical regardless of the triggering ref — the workflow
   resolves both tips via one `ls-remote` and never consults `github.ref`
   during assembly.

Untested composition: a **main-ref** run *while the beta branch exists*
(the 15:53 main run predates the branch; the 16:33+ runs were beta-ref).
Pages serves whatever is inside the uploaded tar and no official source even
hints at subdirectory-dependent activation, so the residual risk is small —
but after this incident, "small residual risk" is precisely the thing we no
longer accept on faith. Hence the mandatory one-shot **V1 validation
dispatch** before the lane is declared open, and the standing in-workflow
endpoint verification thereafter.

### 4.2 Failure-mode walkthrough (Option A, with the §5 flow)

| Failure mode | Behavior under Option A | Residual action |
|---|---|---|
| Wrong ref dispatched (someone dispatches on `beta`) | Deploy job fails on the environment branch policy — the *observed* attempt-1 mechanism (§2.1), now guaranteed by the main-only policy (§8.3) | Re-dispatch on `main` |
| Stale/unreviewed beta tip republished by a routine main push | Real, accepted trade-off: any main push re-publishes `/beta/` from the current beta tip. Mitigation is procedural + structural: the beta branch only ever holds approved candidates (existing repo policy), and the branch is **deleted when the lane is idle** — the workflow's bootstrap path already handles branch absence | Owner decision §9.4 |
| Deploy race (main push and dispatch overlap) | Single `pages` concurrency group, `cancel-in-progress: false` — serialized; both runs resolve tips atomically at start, and the *later* deploy wins with a consistent artifact. With beta-push triggers removed, no inert deploy can ever supersede a real one again (§2.5) | None |
| Failed candidate build (beta tree red) | Whole run fails; **nothing** deploys; previous site keeps serving. Fail-closed — but note the coupling: a broken beta tip also blocks *production* deploys until resolved | Escape hatch exists and is tested: dispatch with `include_beta=false`, or delete the beta branch. Owner must accept the coupling (§9.4) |
| Green run, public site unchanged (this incident's class) | Eliminated by the verification job: the run cannot go green unless the public stamps match its run id (§5 step 4, §8.1) | None |
| Rollback of a bad beta | Reset `beta` to a known-good SHA (or delete it) and dispatch on `main`; or dispatch `include_beta=false` to unpublish `/beta/` entirely | Minutes; no prod impact |
| Rollback of bad production | `git revert` on `main`, push → auto-deploy (~60–90 s observed end-to-end) | Unchanged from today |
| Accidentally publishing an unreviewed candidate | Publishing requires either a push to protected `main` or an explicit dispatch — both human, deliberate, main-ref acts. Nothing auto-publishes on a beta push anymore | None |
| Firebase cross-talk | `js/channel.js` derives the channel from the URL path (`/beta/` → `rooms-beta`), pure and unit-tested; REST-validated rules enforce the namespace shapes server-side | None |
| PWA/cache confusion | No service worker exists in this codebase (verified — no `serviceWorker` reference anywhere), so staleness is plain HTTP caching (`max-age=600`, ≤10 min). Beta installs get a distinct manifest identity ("GeoParty Beta", `/beta/`-scoped start URL) | None beyond the 10-min cache window; `release.json` is the freshness oracle |
| PostHog KPI contamination | Events carry the URL-derived `deployment_channel` super property; beta pages are `noindex`. Console-side filters excluding `channel=beta` from production KPIs are **not yet configured** — must happen before the first beta session | Owner action §9.6 |
| User confusion (which build am I on?) | Distinct PWA name/short-name, separate `release.json` per channel, 6-letter beta room codes vs 4-letter production codes | None |

### 4.3 Complexity ranking (total moving parts, new trust surfaces)

`E < A < C4 < C1 ≈ D`, with B disqualified outright. A adds one workflow job
and removes a trigger; C4 adds a second publishing pipeline plus
`contents: write`; C1 and D add an account/repo boundary, a secret, and
channel-detection changes. E is simplest but sacrifices the pre-production
verification the audit question demands; it remains the declared fallback,
not the recommendation.

---

## 5. Exact operational flow (Option A)

Branch/ref vocabulary used below is defined in §6. "Live-verify X" means:
fetch the public URL with a cache-busting query and confirm `release.json`'s
`run` equals the intended run id — never trust a green run or deployment
record alone (until the verification job of §8.1 exists, do this by hand;
after it exists, the run's greenness *is* that check, but the habit stays for
incident forensics).

1. **Candidate creation.** Approved candidate commits are pushed to the
   `beta` branch (created from `main`, or fast-forwarded/reset to the
   candidate SHA). Pushing to `beta` triggers ordinary CI (`ci.yml`) only —
   it no longer triggers any deployment.
2. **CI/review.** Normal review policy applies (Fable plans/reviews, pinned
   Opus 4.8 implements, Eduardo approves). `ci.yml` must be green on the
   beta tip.
3. **Public beta publication.** With Eduardo's approval, dispatch **"Deploy
   to Pages" on `main`** (`workflow_dispatch`, ref = `main`,
   `include_beta=true` — the default). The run resolves both branch tips
   atomically, tests both trees, assembles main-at-root + beta-under-`/beta/`,
   stamps both `release.json` files, and deploys from the default branch.
4. **Verification.** The run's verification job polls
   `https://earino-assistant.github.io/geoparty/release.json` and
   `…/geoparty/beta/release.json` until both stamp `run == <this run id>`
   (timeout → run fails red). Eduardo then verifies the candidate at
   `https://earino-assistant.github.io/geoparty/beta/` — real phones, real
   TV, Firebase `rooms-beta`, 6-letter codes — while production serves
   untouched at the root.
5. **Promotion.** Merge (normally fast-forward) `beta` → `main` and push.
   The push auto-deploys: the promoted code is now production at the root,
   and `/beta/` is refreshed from the beta tip (identical content until the
   next candidate). Optionally delete `beta` afterward — the next main-ref
   deploy then publishes a production-only artifact (bootstrap path).
6. **Rollback.**
   - *Bad beta candidate:* reset `beta` to a known-good SHA (or delete the
     branch) and dispatch on `main`; or dispatch with `include_beta=false`
     to unpublish `/beta/` immediately while keeping the branch for fixes.
   - *Bad production:* `git revert` on `main`, push, auto-deploy, live-verify.
7. **Idle state.** No active candidate → no `beta` branch. The lane costs
   nothing while unused.

---

## 6. Branch/ref/deployment semantics — no vague words

- **`main`** — the default branch; the *only* ref from which a `github-pages`
  deployment may be created (enforced by environment policy after §8.3).
  Protected; promotion is by merge/revert, never force-push.
- **`beta`** — an ordinary short-lived branch holding exactly one approved
  candidate lineage. It is **content input, never a deploy trigger**: its tip
  is read via `ls-remote` *by main-ref runs* at run start. It may be absent.
- **"Deploy"** (the only sanctioned sense) — a `pages.yml` run whose
  `github.ref` is `refs/heads/main` (a push to `main`, or a
  `workflow_dispatch` executed on `main`) that uploads one artifact
  containing the whole site and calls `actions/deploy-pages@v4`.
  There is deliberately **no such thing as "deploying beta"** — there is
  *including the beta tip in a main-ref deploy*.
- **Content resolution** — what gets deployed is the `ls-remote`-resolved
  tips of `main` and `beta` *at run start*, not the SHA of the triggering
  push. A dispatch therefore always publishes the current tips; the stamps
  record exactly which SHAs those were (`commit`/`short`/`ref`/`channel`/`run`).
- **Deployment record** — the `github-pages` environment entry created by
  `deploy-pages`. Per §2.6 it carries **no** field distinguishing an
  activating deployment from an inert one; it is treated as telemetry, never
  as proof.
- **Activation** — the public URLs serving the new artifact, proven only by
  the public `release.json` stamps matching the run id. This is the only
  definition of "deployed" this project now recognizes.

---

## 7. Firebase / PostHog / PWA privacy and isolation implications

- **Firebase.** `js/channel.js` (pure, unit-tested) maps URL path →
  namespace: `/beta/` pages use `rooms-beta`, everything else — including any
  `file://` checkout, via the protocol guard — uses production `rooms`. The
  published `rooms-beta` rules were REST-validated (6-letter beta writes 200,
  malformed writes 401, production 4-letter unaffected). Under Option A this
  all stands unchanged. Note: while `/beta/` returns 404, the `rooms-beta`
  rules are unreachable dead config — harmless, but they should be reverted
  if the owner chooses Option E.
- **PostHog.** Consent gating is untouched by any option considered; capture
  still flows exclusively through `js/consent.js` after opt-in. Beta events
  carry the URL-derived `deployment_channel` super property, so channel
  separation is a **console-side filter** exercise that must be completed
  *before the first beta session* or beta test traffic contaminates
  production KPIs (§9.6). No new event, no schema change, and no new
  identifying property is needed for the delivery-path change itself: which
  ref published the site is CI metadata (`release.json`), not a product
  signal — instrumenting it would violate the aggregates-only rule for zero
  KPI value.
- **PWA.** There is no service worker in this codebase (verified by search),
  so no cache-poisoning or update-lag class of failure exists; staleness is
  bounded by Pages' `cache-control: max-age=600`. The beta artifact copy
  rewrites the manifest (`GeoParty Beta` / `GeoParty β`, fail-loud on drift —
  verified present in the incident artifact), and relative manifest URLs
  scope the beta install under `/beta/`, so a phone can hold both installs
  without identity collision. Beta pages carry `noindex` (verified in the
  artifact), which, with the obscure path, is the agreed public-but-unlisted
  posture; no authentication is required or added.
- **Privacy invariants.** No option in §3 changes what data leaves a device.
  Replay masking, coordinate bans, and the `poolDiagId` opacity rule are
  orthogonal to the delivery path and remain governed by the existing
  checklist.

---

## 8. Exact changes and reverts required (none performed by this audit)

### 8.1 Workflow (`pages.yml`) — Opus implements after approval

1. `on.push.branches: [main, beta]` → `[main]`. The dispatch input
   `include_beta` and its push-event null-guard stay as shipped.
2. New `verify` job after `deploy` (needs: deploy; no elevated permissions;
   plain `curl`): poll the public root `release.json` — and
   `…/beta/release.json` when the build resolved a beta SHA — until
   `run == github.run_id`, with a hard timeout (suggested 5 min, well past
   the observed ~15 s activation and the 10-min edge cache); on timeout the
   run **fails**. Pass the resolved beta SHA presence from `build` via job
   outputs so the check matches what was actually included.
3. Optional hardening: a first step in `build` that fails fast with a clear
   message if `github.ref != 'refs/heads/main'`, so a wrong-ref dispatch dies
   in seconds with an explanation instead of at the deploy gate.
4. Update the header comment block: the beta-push premise it documents is
   superseded by this audit.

### 8.2 Tests — same change set, mandatory

- `tests/deploy-workflow.test.js` currently **pins the rejected behavior**
  ("pages.yml deploys on main AND beta pushes", asserting
  `branches: [main, beta]`). Update the pin to `[main]`, add pins for the
  verify job's existence, its `needs: deploy`, its run-id comparison, and its
  timeout — so a future edit cannot silently remove the only
  green-means-live guarantee. The include_beta guard-expression tests stay.
- `npm test` and `npm run check` green, per repo rule. The workflow change
  itself is YAML + curl; the lexical workflow-contract tests are exactly this
  repo's mechanism for testing it.

### 8.3 GitHub settings — owner (or an approved agent), not a repo commit

- `github-pages` environment branch policies: **remove `beta`**, remove the
  stray **`text`** entry (evidently a UI mishap during the incident), and
  remove the vestigial **`gh-pages`** entry (meaningless under
  `build_type: workflow`; keep it only if C4 is ever adopted). Leave exactly
  `main`. After this, the incident cannot recur even by mistake: a non-main
  deploy fails loudly at the gate, as observed in attempt 1.

### 8.4 Validation and follow-ups

- **V1 (mandatory before first real candidate):** one approved
  `workflow_dispatch` on `main` with the (currently identical-content) beta
  branch present; confirm both public stamps carry that run's id. This is a
  deployment action and needs Eduardo's explicit go per policy.
- **V2 (recommended, cheap):** one deliberate dispatch on `beta` expected to
  fail at the environment gate — proving the guard, then deleting nothing
  (a red run is the artifact).
- `docs/beta-deployment-plan.md`: amend §6's trigger premise to reference
  this audit (docs-only follow-up; not edited now).

### 8.5 If the owner instead chooses Option E (abandon the beta lane)

Revert scope: delete the `beta` branch; remove the beta push trigger, the
`include_beta` input, and the beta assembly/stamp/marker steps from
`pages.yml` (or leave the dormant bootstrap path — it is inert without a
branch, but simplicity argues for removal); update
`tests/deploy-workflow.test.js` accordingly; revert the Firebase `rooms-beta`
rules; remove `beta`/`text`/`gh-pages` from the environment policy.
`js/channel.js` and its tests may stay (pure, harmless, and production pages
always classify as production) — removal optional. PostHog needs no change
(no beta events will exist).

### 8.6 What B0–B2 work survives under the recommendation

Reusable unchanged: dual-tree atomic resolution and isolated checkouts,
both-trees test gate, artifact assembly, per-channel `release.json` stamps,
fail-loud beta manifest/noindex markers, `js/channel.js` + Firebase wiring +
published `rooms-beta` rules, ci.yml, and the workflow-contract test
scaffolding. Discarded: the beta push trigger, the `beta` environment policy
entry, and — most importantly — the *belief* that a deployment record proves
a public change.

---

## 9. Owner decisions required (nothing proceeds without them)

1. **Adopt Option A** (main-ref publication + verification job + main-only
   environment policy), or choose Option E, or another §3 row.
2. **Approve the implementation change set** of §8.1–§8.2 for pinned
   Opus 4.8 (one agent, one change set, no push without approval).
3. **Approve the settings cleanup** of §8.3 and who executes it (Settings UI
   yourself, or an approved agent via API).
4. **Accept two coupled-pipeline trade-offs** inherent to the single-artifact
   model: (a) a broken beta tip blocks production deploys until the
   `include_beta=false` hatch is used or the branch is fixed/deleted;
   (b) every main push republishes `/beta/` from the current beta tip —
   with the mitigation policy "beta branch only ever holds approved
   candidates; delete it when idle." If either is unacceptable, the
   fallback ranking is E, then C4.
5. **Approve V1** (and optionally V2) validation dispatches — these are
   deployment actions.
6. **Configure PostHog beta filters** (exclude `deployment_channel = beta`
   from production KPI insights) before the first beta session, or direct
   that beta remain unlaunched until done.
7. **Firebase `rooms-beta` rules:** keep (Option A) or revert (Option E).
8. Minor: note §2.6's correction to the incident record wherever that
   narrative is reused.

---

## 10. Process learning — how this class of failure becomes impossible

1. **Source-first platform validation.** The failed premise ("environment
   branch policy allows `beta` ⇒ beta-ref deploys activate the site") was
   never stated by any official source; it was *inferred from the absence of
   an error*. The rule going forward: a plan may rely on a platform behavior
   only if it can **quote the official sentence that promises it** (docs,
   action README/source, or API reference). If the sentence cannot be found,
   the behavior is treated as undefined and must be proven by a live
   experiment before anything is built on it. The decisive sentences here
   (§2.4) were publicly available before B0–B2 was designed. Corollary
   learned from §2.6: even the *incident narrative* misremembered a
   platform detail (`production_environment`) — primary records, not
   recollection, are the audit substrate.

2. **A green deployment record is not a public endpoint change.** This
   incident produced the strongest possible false positive: run ✅, deploy
   step ✅, deployment status `success` ✅, `environment_url` populated ✅,
   predecessor deployment marked `inactive` ✅ — and a 404 where the feature
   should be, with production silently still serving the previous artifact.
   And per §2.6 there is *no* API field that would have flagged it. The two
   layers must be verified independently, always: the record tells you
   GitHub *accepted* the deployment; only the public URL tells you the world
   changed.

3. **The mandatory release check.** Effective immediately as process, and
   structurally once §8.1(2) ships: **no deployment of any channel is
   "done" until the public `release.json` of every touched channel has been
   fetched (cache-busted) and its `run` field equals the run id that claimed
   success.** The stamps exist precisely to make this a 5-second check;
   §8.1(2) moves it into the workflow so a run physically cannot end green
   without it. Humans keep the habit for forensics; CI enforces it for
   releases.

4. **Walk the skeleton before building the body.** B0–B2 shipped Firebase
   rules, environment policy, artifact machinery, stamps, and reviews before
   the single riskiest premise — public activation from a beta-ref deploy —
   had been exercised once. A 15-minute throwaway probe (scratch branch, the
   existing workflow, one push, one `curl`) would have returned the 404
   before any of it was designed. For any future plan resting on an external
   platform behavior: identify the one assumption that kills the design if
   false, and test it live, end-to-end, *first*.

5. **Reviews must interrogate premises, not just mechanics.** Three review
   passes examined concurrency, ref pinning, guard expressions, and fail-loud
   marker logic — all of which worked — while the platform premise beneath
   them went unchallenged. A review of any deploy/infra plan must begin by
   listing the platform behaviors the plan *assumes*, and demand a citation
   or experiment for each, before critiquing the implementation built on
   them.
