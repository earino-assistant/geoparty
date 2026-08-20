# Repository hygiene and release plan

**Status:** PLAN — audit complete, no cleanup executed yet. Written 2026-08-20
against `main` @ `6eb2f0d` (G1–G8 shipped, proprietary license landed).
**Author:** Fable (audit/planning pass commissioned by Eduardo).
**Verified baseline:** `npm test` 616/616 green, `npm run check` green,
working tree clean except 43 untracked `.feat-*.md` briefs.
**Amended 2026-08-20:** the two external beta-removal items this plan
originally listed as open (Firebase console `rooms-beta` rule, PostHog
fact-check) were completed by the owner and verified after the audit —
see §2.5, §4 step 7, and D11.

Nothing in this document is executed by the change that adds it — every
action below waits on the owner decisions in §9, except committing this
plan itself.

---

## 1. Executive recommendation

The repository is in better shape than a hygiene pass usually finds: the
code, tests, workflows, and the four load-bearing docs are current; there
are no dead code files, no stale workflow steps, and no secrets anywhere.
The debt is almost entirely **documentation status-labeling** and
**metadata**:

1. **Seven docs read as pending plans for work that shipped or was
   abandoned.** The phrase "nothing in this document is implemented by the
   change that adds it" appears in four headers and is now false in all
   four. Fix with status banners (exact texts in §5) — no body rewrites,
   preserving the deliberate leave-history-unedited convention.
2. **README and PRIVACY.md are behind the product.** README documents
   neither `daily.html` nor any G1–G8 feature and describes a superseded
   pool pipeline; PRIVACY.md omits the one deliberate data-sharing feature
   (Daily Ghost Duel links). These are content updates, not banners.
3. **The 43 untracked `.feat-*.md` briefs are deletable** after owner
   approval — 41 are fully captured in committed docs/commits; the
   remaining two have their unique content preserved by this document and
   by `docs/beta-removal-plan.md` §3.3. Back up first (§7), then add
   `.feat-*.md` to `.gitignore` so future briefs can't be committed by
   accident.
4. **External cleanup is small:** delete one stale remote branch, push the
   never-pushed `v0.1.0-couch` tag, and fill in the empty GitHub repo
   description/topics/homepage. The two owner-side items the beta removal
   left open are now **done and verified**: Eduardo removed the Firebase
   console `rooms-beta` rule (REST-validated: six-letter `rooms/` PUT →
   200 with cleanup 200; four-letter `rooms/` PUT → 401; `rooms-beta/`
   six-letter PUT → 401), and the PostHog fact-check was performed via
   the project API (settings, all 33 insights, all 3 dashboards: no
   `deployment_channel` or `/beta/` filters; no cleanup was necessary).
5. **Release: tag `v0.4.0`** (annotated) on the post-hygiene commit, with
   the release notes drafted in §6. This is a minor-version release —
   large in scope but pre-1.0 and backward-compatible in spirit with the
   v0.x line. Do the doc hygiene first so the tag points at a
   truthfully-labeled tree.

Recommended order: commit this plan → owner approves §9 → doc edits (2
commits) → push, verify-live green → tag + release → external metadata →
local brief deletion. Full sequencing in §4.

---

## 2. Inventory — path-by-path classification

Classifications: **ACTIVE** = keep as active source of truth ·
**HISTORY+BANNER** = keep as history, add/fix a status banner ·
**ARCHIVE** = candidate for a future `docs/archive/` move (do not move
now) · **DELETE** = remove · **EXTERNAL** = remote/GitHub/console action.

### 2.1 Repository root

| Path | Class | Notes |
|---|---|---|
| `README.md` | ACTIVE (needs update) | License notice present and accurate. Stale: no `daily.html` / G1–G8 anywhere; pure-module list omits ~13 shipped modules; "seven-scenario" failure matrix is now 16 rows; §Location pool documents the superseded `build_location_pool.py` path instead of `scale_/score_/validate_location_pool.py` + tiers + quarantine; §Deployment step 1 reads as third-party deploy instructions, awkward under the proprietary license. Edits in §5.8. |
| `PRIVACY.md` | ACTIVE (needs update) | Normative, test-asserted. Gap: no mention of Daily Ghost Duel share links (the one authorized sharing feature) or of decoy/night RTDB fields. Edits in §5.9. |
| `LICENSE` | ACTIVE | New (`6eb2f0d`). Custom proprietary text — GitHub will show "Other"/`NOASSERTION`, no SPDX badge; that is expected, not a defect (§6.5). |
| `CLAUDE.md` | ACTIVE | Current, including the Ghost Duel privacy exception. No change. |
| `geoparty-spec.md` | HISTORY+BANNER | The v0.1 build spec. Contradicts shipped reality throughout (4-letter codes, "no CI, no analytics, keep it that way", 5-module tree, public-repo instructions). Origin document — keep, banner in §5.1. |
| `config.js`, `package.json`, `manifest.webmanifest`, `*.html`, `css/`, `assets/` | ACTIVE | All live. `package.json` `"version": "1.0.0"` has never tracked the tags — align to `0.4.0` in the hygiene commit (decision D6). `assets/make-icons.mjs` is the icon build script; keep. |
| `.gitignore` | ACTIVE (needs one line) | Add `.feat-*.md` (decision D3). |
| `.feat-*.md` × 43 (untracked) | DELETE (after D2 approval + backup) | Full disposition in §3. |

### 2.2 `docs/` — active source of truth (no banner needed)

| Path | Class | Notes |
|---|---|---|
| `docs/analytics.md` | ACTIVE | Current through G1–G8; contains its own correctly-scoped `deployment_channel` retirement note. |
| `docs/architecture.md` | ACTIVE | Current; correctly marks `lhCursor` `DEFERRED — NOT WRITTEN`. |
| `docs/field-observability-plan.md` | ACTIVE | Already self-bannered "IMPLEMENTED"; §14 P1.5 (Stage-2 replay-sampling flip) is genuinely pending and correctly labeled. |
| `docs/failure-injection.md` | ACTIVE | Normative `degraded` contract. Optional one-line note that the manual on-device runbook has no dated results yet (§5.7). |
| `docs/replay-mask-checklist.md` | ACTIVE | **Parsed by `tests/html-contract.test.js` — structure is load-bearing.** Current through G1–G8. §5's real-recording verification remains an open manual item. |
| `docs/pool-scale-plan.md` | ACTIVE | Live runbook (`--refresh-thumbs` is a recurring obligation). Add a one-line "executed — pool is at 5,312" header (§5.6) and link it from README. |
| `docs/g1-g8-gameplay-expansion-spec.md` | ACTIVE (fix header) | §3.5.6 is the normative privacy boundary cited by CLAUDE.md — must stay reachable. Header still says "nothing in this document is implemented"; fix per §5.4. |
| `docs/ui-ux-design-review.md` | ACTIVE (scoping banner) | §4/§6.5/§8 are normative (CLAUDE.md and `js/chrome.js` depend on §4); §7/§9 roadmap shipped in `3e26419`. Banner per §5.5. |

### 2.3 `docs/` — history, banner work needed

| Path | Class | Notes |
|---|---|---|
| `docs/design-review.md` | HISTORY+BANNER | Header claims "spec / roadmap only" — all of M1–M6, S1–S7, and C5 shipped. C1–C4 are the only live backlog here. §1.6 (SUPER SURE contract) still normative. Banner §5.2. |
| `docs/gameplay-design-review.md` | HISTORY+BANNER | G1–G8 of its §6 shipped; **G9–G13 remain the only record of the future-ideas backlog** — do not delete. Banner §5.3. |
| `docs/engineering-manager-review-v0.3.md` | HISTORY+BANNER | Gate executed (`f4d0fee`, `84924b8`); contains a known-wrong "no v0.3.0 tag" baseline note corrected only in the stabilization review. Banner §5.10. |
| `docs/stabilization-review-f4d0fee.md` | HISTORY+BANNER | Both required follow-ups fixed in `84924b8`. Carries the v0.3.0-tag factual correction. Unreferenced by code/tests but part of the review chain. Banner §5.11. |
| `docs/beta-deployment-plan.md` | HISTORY (banner exists) | RETIRED banner already correct. Optional: bracket its line-8 "awaiting owner approval" so the two status lines don't contradict (§5.12). Top candidate for `docs/archive/` if an archive dir is ever created (D8 — default: don't). |
| `docs/beta-delivery-architecture-audit-spec.md` | HISTORY+BANNER | Commissioning brief + incident evidence. Banner must state the lane was abandoned (§5.13). |
| `docs/beta-delivery-architecture-audit.md` | HISTORY+BANNER | §1's verdict ("keep the `/beta/` model") was NOT adopted — owner chose Option E. §10 process learning is the origin of the verify-live gate; `beta-removal-plan.md` §8 mandates verbatim retention, so banner only (§5.14). |
| `docs/beta-removal-plan.md` | HISTORY (update status line) | Its own status line says the removal is "unpushed pending owner approval" — now false (`2e05e5f` is on `main`). It also carries the two genuinely open owner items (§3.3 Firebase, §3.4 PostHog). Replace status line per §5.15 — do not lose those two items. |

**Nothing in `docs/` qualifies for DELETE.** Every historical doc is either
review-chain provenance, incident evidence with mandated retention, or the
sole carrier of an open item or backlog.

### 2.4 `js/`, `tests/`, `tools/`, `data/`, `.github/`

| Path | Class | Notes |
|---|---|---|
| `js/*.js` (37 files) | ACTIVE | No dead modules found; `js/channel.js` (beta) was already deleted. Tests scan every file in `js/`. |
| `tests/*.test.js` (30 files) | ACTIVE | 616/616 green. `deploy-workflow.test.js` pins the single-deployer + no-beta invariants; `html-contract.test.js` parses `docs/replay-mask-checklist.md`. |
| `.github/workflows/ci.yml`, `pages.yml`, `pool-health.yml` | ACTIVE | Current actions versions, main-only, zero beta remnants (test-enforced). Verify-live gate intact in `pages.yml`. No changes. |
| `tools/*.py`, `tools/*.mjs` | ACTIVE | Do not touch (CLAUDE.md rule). |
| `tools/pool-health-state.json` | ACTIVE | Committed **empty baseline** for the Actions-cache-carried state; the workflow deliberately never commits updates (test-enforced). Not stale — keep as-is. |
| `tools/pool-suspects.json` | ACTIVE | Hand-curated input (currently `[]`). Keep. |
| `tools/.cache/` (untracked, ~13 MB) | KEEP (local) | Self-gitignored via `tools/.cache/.gitignore`; regenerable but saves re-downloading GeoNames data. No action. |
| `data/location_pool.json`, `data/pool_quarantine.json` | ACTIVE | Test-read. Do not touch. |

### 2.5 Git refs, tags, releases, GitHub metadata

| Item | Class | Notes |
|---|---|---|
| Remote branch `origin/docs/beta-deployment-plan` @ `70d27ab` | EXTERNAL — delete | Its content landed on `main` as `0f28562` → `docs/beta-deployment-plan.md` (now RETIRED-bannered). Not merged by ancestry but fully superseded. Record the SHA `70d27ab` before deletion (§7). |
| Remote branch `origin/review/rf1-rf2-followups` | (already gone) | Deleted upstream; pruned locally during this audit. No action. |
| Tag `v0.1.0-couch` @ `ff77baf` (annotated, **local only**) | EXTERNAL — push | Never pushed, yet the public v0.2.0 release notes cite it as the rollback point. Push the tag (D5). A GitHub release for it is unnecessary. |
| Tag `v0.2.0-h2h` @ `1d84808` (annotated, pushed, has release) | KEEP | No action. |
| Tag `v0.3.0` @ `28d2b5b` (**lightweight**, pushed, has release) | KEEP | Leave as-is; retagging published tags causes more trouble than the inconsistency. Future tags: annotated (D6). |
| GitHub releases (v0.2.0-h2h, v0.3.0) | KEEP | Accurate historical notes. |
| Repo description / topics / homepage | EXTERNAL — set | All currently empty/null. Proposed values in §6.4. |
| License metadata | EXTERNAL — accept | Shows `Other`/`NOASSERTION` because LICENSE is custom proprietary text. **Do not** expect an SPDX badge; do not swap to a template license just for the badge. |
| Wiki / Projects (enabled, unused) | EXTERNAL — disable | Reduce surface on a proprietary repo (D10). Issues: keep enabled. |
| Firebase console `rooms-beta` rules block | EXTERNAL — **done, verified** | Item from `beta-removal-plan.md` §3.3. Removed by Eduardo 2026-08-20; live rules validated by REST outcome afterward: valid six-letter `rooms/` PUT → 200 (cleanup 200), invalid four-letter `rooms/` PUT → 401, `rooms-beta/` six-letter PUT → 401. |
| PostHog dashboard fact-check | EXTERNAL — **done, verified** | Item from `beta-removal-plan.md` §3.4. Performed 2026-08-20 through the project API: project settings, all 33 insights, and all 3 dashboards carry no `deployment_channel` or `/beta/` filters; no cleanup was necessary. |

---

## 3. The 43 untracked `.feat-*.md` briefs

All 43 were audited individually (secret scan clean; total ~152 KB). They
are local agent task briefs that were never committed — the repo's own
precedent (`1f7073c` "remove internal orchestration briefs before public
push") is deletion, and every brief self-instructs "do not commit."

- **41 of 43: DELETE outright** (after D2 approval + the §7 backup). Every
  one is a dispatch brief whose substance landed in a committed
  `docs/*.md` deliverable or a descriptive commit. All owner decisions of
  lasting force were verified durable in tracked files: the Ghost Duel
  privacy exception (`CLAUDE.md`), Ghost-first sequencing and the lhCursor
  deferral (`g1-g8-…-spec.md` §12), replay learning mode
  (`field-observability-plan.md` + `analytics.md`), the Report-flow
  no-permanent-chrome decision (`architecture.md`), the Daily "same five"
  timeout rule (`failure-injection.md`), the beta abandonment chain
  (three beta docs), and the no-service-worker decision
  (`beta-deployment-plan.md` §5.3).
- **`.feat-fable-repo-hygiene-plan.md`: DELETE once this document is
  committed** — it is the parent brief of this plan; this document is its
  deliverable and captures all of its unique content.
- **`.feat-fable-remove-beta-review.md`: DELETE** — it records that the
  Firebase console `rooms-beta` block was deliberately left inert for
  later owner removal. That removal has since been done and
  REST-verified (§2.5, D11), and the prescription itself lives in
  `docs/beta-removal-plan.md` §3.3, so the brief is fully redundant.

Nothing in any brief needs extraction beyond the above.

---

## 4. Proposed cleanup order

Each step is independently revertible; steps 5, 6 and 8 are external
and need owner action or approval (step 7 was completed and verified
2026-08-20 — kept in the table for the record).

| # | Step | Actor | Gate |
|---|---|---|---|
| 0 | Commit this plan (docs-only, no push) | done in this pass | — |
| 1 | **Hygiene commit A — doc status truth:** banner edits §5.1–§5.7 and §5.10–§5.15 (banners/status lines only, no body rewrites) | agent | Owner approves D1 |
| 2 | **Hygiene commit B — content updates:** README refresh, PRIVACY Ghost Duel section (§5.8–§5.9), `.gitignore` + `package.json` version line | agent | Owner approves D1/D3/D6 |
| 3 | `npm test` + `npm run check` green; push `main`; watch `pages.yml` **verify** job go green (the live gate) | agent/owner | CI |
| 4 | Tag `v0.4.0` (annotated) on the post-hygiene tip; push tag; create the GitHub release with §6.2 notes; push `v0.1.0-couch` | owner (or agent w/ approval) | D5/D6 |
| 5 | Delete remote branch `docs/beta-deployment-plan` (record `70d27ab` first) | owner/agent | D4 |
| 6 | Set repo description/topics/homepage; disable wiki+projects | owner | D7/D10 |
| 7 | Firebase console `rooms-beta` removal + PostHog fact-check — **done 2026-08-20 and verified** (§2.5; D11 closed) | owner (done) | — |
| 8 | **Local brief cleanup, last:** create the §7 backup tarball, verify it, then `rm .feat-*.md` | agent | **D2 — owner approval required; never before step 0's plan and the backup exist** |

Brief cleanup is deliberately last: the briefs are untracked, so they are
the only material in this plan that git cannot recover. Nothing else in
the sequence depends on them.

---

## 5. Exact doc edits

Banner edits insert/replace ONLY the header status block; bodies stay
verbatim (the review docs' leave-history-unedited convention is preserved
deliberately).

### 5.1 `geoparty-spec.md` — insert after the title

> **HISTORICAL — v0.1 build spec (2026-08-19). Superseded by
> `docs/architecture.md`, `CLAUDE.md` and `README.md`.** The shipped
> product diverges deliberately: 6-letter room codes, head-to-head player
> phones, the Daily Challenge, sound, CI/Pages workflows and
> consent-gated analytics all exist despite §"Out of scope". Read for
> origin and rationale only; nothing here is normative.

### 5.2 `docs/design-review.md` — replace the "Status:" italic block

> **HISTORICAL — the roadmap shipped.** All of §3's MUST (M1–M6) and
> SHOULD (S1–S7) items, plus COULD C5, are live on `main`; only C1–C4
> remain unbuilt. §1.6 (the SUPER SURE contract) is still normative and
> cross-cited by `docs/architecture.md`. Read §3 as a record of what was
> built and why, not as pending work.

### 5.3 `docs/gameplay-design-review.md` — replace the "Status:" clause

> **PARTIALLY SHIPPED — G1–G8 of §6 are live on `main`** (spec:
> `docs/g1-g8-gameplay-expansion-spec.md`; authoritative status: its
> §12). **G9–G13 remain unbuilt ideas** and are the live backlog in this
> file. §1–§5 describe the pre-G1–G8 product; read them as design
> rationale, not current state.

### 5.4 `docs/g1-g8-gameplay-expansion-spec.md` — replace the header status line

> **Status: SHIPPED and live on `main` — see §12 for the authoritative
> what-shipped record.** Everything in §1–§11 is implemented except the
> Long Haul expert-tier sampler / `lhCursor` (§3.2, deferred; §12).
> §3.5.6 remains the normative Ghost Duel privacy boundary cited by
> `CLAUDE.md`. §8 (phases) and §11 (review checklist) are historical
> planning artifacts. Manual device proof of the h2h TV twist card flip
> and the ACE burst is still outstanding (§6.2).

### 5.5 `docs/ui-ux-design-review.md` — replace the "Status:" clause

> **PARTIALLY HISTORICAL — the §7 roadmap (P0, P1, P2) shipped in
> `3e26419`; §9's implementation brief is complete.** Still normative:
> §4 (the layer/hierarchy design system, enforced by `js/chrome.js` and
> cited by `CLAUDE.md`), §6.5 (consent moment), and §8 (what not to
> change). §2's screen inventory describes the pre-de-clutter, pre-G1–G8
> UI — the diagnosis, not the current state.

### 5.6 `docs/pool-scale-plan.md` — insert after the title

> **Executed — the pool is at 5,312 entries, built by
> `tools/scale_location_pool.py`.** §"Results / operations" is the live
> runbook (including the periodic `--refresh-thumbs` re-run);
> §"Problem" and §"Research findings" are the rationale record.
> Difficulty tiers are assigned afterwards by
> `tools/score_location_pool.py`.

### 5.7 `docs/failure-injection.md` — optional one-liner under the matrix results

> Manual on-device runbook: **not yet executed on a real device** as of
> 2026-08-20 — no dated results recorded (required by the EM review §8
> item 5 and stabilization review §5 condition 2).

### 5.8 `README.md` — content edits (commit B)

1. §How it works: add `daily.html` to the page list.
2. New short section (after the mode descriptions): the Daily ritual —
   streaks, personal bests, Hard Mode, ACE, and Ghost Duel challenge
   links (own-guesses-only, URL-fragment, never sent to a server) — and
   the party additions: twist rounds, Crown Night, Decoy Pin.
3. §Tests & CI: refresh the pure-module list (add `records`, `ghost`,
   `twist`, `night`, `decoy`, `daily`, `share`, `supersure`, `frontdoor`,
   `tvlink`, `hints`, `chrome`, `autoadvance`, `couchscreen`, `fx`);
   replace "seven-scenario" with the current 16-row matrix reference.
4. §Location pool: rewrite around `scale_location_pool.py` (build) →
   `score_location_pool.py` (tiers) → `validate_location_pool.py`
   (verify), link `docs/pool-scale-plan.md`, mention
   `data/pool_quarantine.json` + the weekly pool-health workflow.
5. §Deployment step 1: reword from "create a public GitHub repo and
   push" to owner-deployment framing consistent with the license.
6. Fix the blockquote lazy-continuation nit in the license notice.

### 5.9 `PRIVACY.md` — content edits (commit B)

1. After "One-time diagnostic reports": add a **Daily Ghost Duel links**
   section — the challenge link carries only your own completed Daily
   guesses and timings, in the URL fragment (never transmitted to any
   server), shared person-to-person by you; it is stripped before
   analytics initialization and can never reach PostHog, session replay,
   or Firebase; it never contains your name, the answer locations, or
   image identifiers.
2. §Game sync: add decoy pins and Crown Night tallies to the list of
   synced fields; update "two places" phrasing accordingly.

### 5.10 `docs/engineering-manager-review-v0.3.md` — insert banner at top

> **HISTORICAL — review of the v0.3 train, 2026-08-20. The §8
> stabilization gate was executed (`f4d0fee`, `84924b8`) and closed;
> item 7 (amend the beta plan) is void — the beta lane was removed.**
> Two known errors of record: the "no `v0.3.0` tag" baseline note is
> wrong (the tag exists at `28d2b5b`; see
> `docs/stabilization-review-f4d0fee.md`), and P2-2 critiques a
> since-retired plan. Left unedited by design.

### 5.11 `docs/stabilization-review-f4d0fee.md` — insert after header block

> **CLOSED — the candidate shipped and both REQUIRED FOLLOW-UPs are
> fixed** (RF-1 lexical console-scrub rewrite and RF-2 pool-health
> cache, both in `84924b8`). Historical record. Still outstanding from
> §5: the real-device replay/masking runbook
> (`docs/failure-injection.md` §"Manual on-device runbook",
> `docs/replay-mask-checklist.md` §5) has no dated results.

### 5.12 `docs/beta-deployment-plan.md` — one-line touch

Existing RETIRED banner is correct; bracket the stale line-8 status as
`[historical status at time of writing:] amended spec (v2 …)` so the two
status lines don't contradict.

### 5.13 `docs/beta-delivery-architecture-audit-spec.md` — extend the Status line

> **HISTORICAL — audit brief, 2026-08-20.** The beta lane it commissions
> was audited and then **abandoned** by owner decision; GitHub Pages now
> publishes from `main` only. Kept as the incident evidence record;
> §2.6 of `docs/beta-delivery-architecture-audit.md` corrects one detail
> below. Nothing here is operational.

### 5.14 `docs/beta-delivery-architecture-audit.md` — insert after the Status line

> **SUPERSEDED 2026-08-20 — the owner chose Option E (§8.5): the beta
> lane was abandoned and removed.** GitHub Pages publishes from `main`
> only, with the verify-live gate this audit's §10 originated
> (`.github/workflows/pages.yml`). §1's "keep the `/beta/` model"
> verdict and the §5/§8.1–§8.4/§9 action items were never executed;
> `js/channel.js` and `tests/channel.test.js` no longer exist. Kept
> verbatim for the incident record and §10's process learning.

### 5.15 `docs/beta-removal-plan.md` — replace the status block

> **Status: EXECUTED and PUSHED — the removal shipped as `2e05e5f` on
> `main`; Pages is main-only with the verify-live gate.** Historical
> record. **Both owner-side items are closed** (2026-08-20): §3.3 — the
> `rooms-beta` console rule was removed by the owner and the live rules
> REST-verified (six-letter `rooms/` PUT 200, four-letter `rooms/` PUT
> 401, `rooms-beta/` PUT 401); §3.4 — the PostHog fact-check was
> API-inspected clean (no `deployment_channel` or `/beta/` filters; no
> cleanup needed). Everything in §5–§7 is done.

**Testing note (per CLAUDE.md):** every edit in §5 is copy/documentation
only — no logic changes, so no new tests or instrumentation apply. The
only structurally-sensitive file, `docs/replay-mask-checklist.md`, is not
edited. `npm test` + `npm run check` still run before each commit as the
regression gate (and `tests/html-contract.test.js` re-validates the mask
checklist parse).

---

## 6. Release recommendation

### 6.1 Version: **`v0.4.0`** (annotated tag)

- Prior tags are `v0.1.0-couch` → `v0.2.0-h2h` → `v0.3.0`; each marked a
  product-scope milestone. G1–G8 + observability + the license change is
  exactly the next such milestone: **minor bump**.
- **Not v1.0.0:** two shipped-quality gates are still open (the
  real-device replay/masking runbook has no dated results; the Long Haul
  expert tier is deferred), and the Stage-2 replay-sampling transition
  hasn't happened. v1.0.0 should mean "nothing we know of is pending" —
  save it.
- Tag the post-hygiene tip (after §4 step 3), not `6eb2f0d`, so the
  release snapshot contains truthful docs.
- Use `git tag -a` — `v0.3.0` went out lightweight; annotated is the
  standard from here (carries tagger/date/message).
- Align `package.json` to `"version": "0.4.0"` in hygiene commit B (it
  has said `1.0.0` since scaffolding and tracks nothing).

### 6.2 Draft release notes

**Title:** `GeoParty v0.4.0 — Ghost Duels, the Daily Ritual, and Party Twists`

> The Daily Challenge grows into a daily ritual, you can now challenge a
> friend to beat your exact run, and party games get twist rounds, a
> champion ceremony, and a new way to bluff.
>
> ### Daily ritual
> - **Streaks** — keep your Daily run going day after day (with a grace
>   window so one missed day doesn't erase months).
> - **Personal bests** — your best Daily score is tracked and celebrated
>   when you beat it.
> - **Hard Mode** — an opt-in no-movement variant for purists.
> - **ACE** — land close enough and the game says so, loudly.
>
> ### Ghost Duels
> - Finish your Daily, then **send a challenge link**: a friend plays the
>   same five locations against the "ghost" of your run — your pins and
>   pace, round by round, with a live verdict at the end.
> - Privacy by construction: the link carries only **your own guesses and
>   timings**, in the URL fragment — it is never sent to any server,
>   never reaches analytics or session replay, and contains no names, no
>   answers, and no image identifiers.
>
> ### Party games
> - **Twist rounds** — a seeded deck of rule-benders that hit every
>   party the same way: Blitz scoring, and more.
> - **Crown Night** — a full-evening tally across games with a champion
>   ceremony on the TV, couch and head-to-head alike.
> - **Decoy Pin** (head-to-head) — drop one fake pin to shake rivals
>   watching your live feed; exposed at the reveal.
> - TV twist cards and ACE celebrations on the big screen.
>
> ### Under the hood
> - Field observability: imagery/viewer failures are classified and
>   visible (consent-gated, privacy-first; coordinates and names never
>   leave the device).
> - A post-deploy **verify-live gate**: every deployment is confirmed
>   actually serving from the public URL before the run goes green.
> - Weekly automated location-pool health checks with quarantine PRs.
> - Stabilization pass from the v0.3 engineering review; the test suite
>   now stands at 616 checks.
> - UI de-clutter pass: fewer overlays, calmer screens, the game front
>   and center.
>
> ### Licensing
> - GeoParty is now explicitly **proprietary** (see `LICENSE`). The code
>   remains visible, but use, hosting, and derivatives require a written
>   license.
>
> ### Known gaps
> - The Expert-tier "Long Haul" Daily progression is designed but not yet
>   live; Expert locations currently rotate without the long-haul cursor.
> - Four-panel head-to-head on weak smart-TV browsers remains heavy
>   (cast from a laptop or a good streaming stick).

(The lhCursor line is phrased as a user-visible gap, which it is — the
public note is appropriate and honest. Drop the second Known-gaps bullet
if it feels like v0.2 déjà vu; it is still true.)

### 6.3 Also push `v0.1.0-couch`

The tag exists only locally at `ff77baf`, yet the public v0.2.0 release
notes name it as the rollback point. `git push origin v0.1.0-couch`
restores referential integrity. No GitHub release needed for it.

### 6.4 GitHub repo metadata (currently all empty)

- **Description:** `Jackbox-style geoguessing party game — phones + TV,
  no installs. Proprietary.`
- **Homepage:** `https://earino-assistant.github.io/geoparty/`
- **Topics:** `party-game`, `geoguessing`, `game`, `firebase`,
  `github-pages`, `mapillary` (skip license-ish topics; topics imply
  discoverability, which is fine — the license governs use).
- **Wiki / Projects:** disable (unused; fewer surfaces implying
  contributions are welcome). **Issues:** keep.

### 6.5 License metadata expectation

GitHub's licensee reports the custom LICENSE as `Other` / SPDX
`NOASSERTION`. That is correct behavior for a bespoke proprietary
license; there will be no license badge. Do not substitute a template
license to get one.

---

## 7. Rollback / recovery plan

| Material | Recovery path |
|---|---|
| `.feat-*.md` briefs (untracked — **git cannot recover them**) | Before deletion: `tar czf ~/geoparty-feat-briefs-$(date +%F).tar.gz -C /opt/data/geoparty .feat-*.md` and `tar tzf` to verify 43 entries. Keep the tarball outside the repo indefinitely (152 KB). Deletion only after the tarball is verified. |
| Doc banner/content edits | Ordinary commits on `main` — `git revert <sha>`. |
| Remote branch `docs/beta-deployment-plan` | Record now: tip = `70d27ab`. Restore anytime with `git push origin 70d27ab:refs/heads/docs/beta-deployment-plan` (the commit remains reachable in this clone; it is also two objects away from `0f28562` on `main`). |
| Tags | `v0.4.0` before announcing: `git push --delete origin v0.4.0` + retag. After announcing: never move; cut `v0.4.1`. |
| GitHub metadata/settings | All trivially re-editable; no backup needed. Note current values are empty/default. |
| Firebase / PostHog changes | Both already executed and verified 2026-08-20 (§2.5). If the Firebase rule must ever be restored, `docs/beta-removal-plan.md` §3.3 preserves the removed rules text. PostHog required no changes, so there is nothing to roll back. |

---

## 8. Verification — before and after each cleanup phase

Pre-flight (already run for this audit — all green):

```sh
npm test                     # expect 616/616 pass
npm run check                # node --check over every JS file
git status --short           # only .feat-*.md as ?? (none after step 8)
```

After the doc commits (steps 1–2):

```sh
npm test && npm run check
# No dangling doc references introduced:
git grep -n "repository-hygiene-and-release-plan" -- docs CLAUDE.md README.md
# Mask checklist still parses (subset guard):
node --test tests/html-contract.test.js
```

After push (step 3): the `pages.yml` **verify** job must go green — it
polls `https://earino-assistant.github.io/geoparty/release.json` until the
served `run`/`commit` match the workflow run. If it exhausts retries,
re-run failed jobs before assuming a real failure (late CDN propagation).

After tagging (step 4):

```sh
git ls-remote --tags origin   # expect v0.1.0-couch, v0.2.0-h2h, v0.3.0, v0.4.0
git cat-file -t v0.4.0        # expect "tag" (annotated)
```

After external cleanup (steps 5–6):

```sh
git fetch --prune origin && git branch -a   # only origin/main remains
curl -s https://api.github.com/repos/earino-assistant/geoparty | \
  python3 -c "import json,sys;r=json.load(sys.stdin);print(r['description'],r['homepage'],r['topics'])"
```

After brief deletion (step 8):

```sh
tar tzf ~/geoparty-feat-briefs-*.tar.gz | wc -l   # 43, verified BEFORE rm
git status --short                                 # empty
npm test && npm run check                          # unchanged, green
```

---

## 9. Owner decisions (recommended defaults in bold)

| # | Decision | Recommendation |
|---|---|---|
| D1 | Apply the §5 doc banner + README/PRIVACY edits | **Yes** — two commits as in §4. |
| D2 | Delete all 43 `.feat-*.md` briefs after the §7 backup | **Yes** — last step in the sequence; requires this explicit approval, per your standing rule. |
| D3 | Add `.feat-*.md` to `.gitignore` | **Yes** — removes the accidental-commit risk every brief currently guards against by hand. |
| D4 | Delete remote branch `docs/beta-deployment-plan` | **Yes** — superseded by `0f28562` on `main`; SHA recorded for recovery. |
| D5 | Push `v0.1.0-couch` | **Yes** — public release notes already reference it. No release object needed. |
| D6 | Version = `v0.4.0` annotated, tagged post-hygiene; `package.json` → `0.4.0` | **Yes** — rationale in §6.1. (Alternative considered and rejected: v1.0.0.) |
| D7 | Set repo description/homepage/topics per §6.4 | **Yes.** |
| D8 | Create `docs/archive/` and move retired beta docs | **No** — banners preserve context with working cross-links; an archive move breaks inbound refs from README/architecture for little gain. Revisit only if `docs/` doubles again. |
| D9 | Public lhCursor note in the release | **Yes** — the §6.2 "Known gaps" phrasing is user-truthful without exposing internals. |
| D10 | Disable Wiki + Projects | **Yes**; keep Issues. |
| D11 | Firebase console `rooms-beta` removal + PostHog fact-check | **CLOSED — done 2026-08-20.** The owner removed the Firebase rule (live rules REST-verified: six-letter `rooms/` PUT 200, four-letter PUT 401, `rooms-beta/` PUT 401) and the PostHog check was API-inspected clean — no `deployment_channel` or `/beta/` filters anywhere, no cleanup needed (§2.5). The §3.3 deadline condition is satisfied. |
| D12 | Sequence: hygiene → push+verify → tag → external → briefs | **Yes** — order in §4. |

---

## 10. What must NOT be cleaned now

- **`docs/replay-mask-checklist.md`** — parsed by
  `tests/html-contract.test.js`; its section structure is load-bearing.
- **The three beta docs' bodies** — `beta-removal-plan.md` §8 mandates
  verbatim retention of the audit; the incident record is the provenance
  of the verify-live gate. Banners only.
- **`docs/gameplay-design-review.md`** — sole record of the G9–G13
  backlog.
- **`docs/g1-g8-gameplay-expansion-spec.md` §3.5.6** — the normative
  privacy boundary CLAUDE.md cites; must stay where CLAUDE.md points.
- **`tools/`, `data/location_pool.json`, `data/pool_quarantine.json`** —
  CLAUDE.md standing rule; quarantine is written only by the weekly PR.
- **`tools/pool-health-state.json` / `pool-suspects.json`** — deliberate
  committed baselines, not stale artifacts (workflow + tests depend on
  the design).
- **`.github/workflows/*`** — all three are current; `pages.yml`'s
  verify job and the no-beta invariant are test-pinned.
- **Existing tags/releases (`v0.2.0-h2h`, `v0.3.0`)** — published
  history; never retag.
- **The `.feat-*.md` briefs — until D2 is explicitly approved and the
  backup tarball is verified.** They are the only unrecoverable-by-git
  material in this plan.
- **PostHog init key/options, Firebase/Mapillary public keys** —
  owner-provided, by-design client-side.
