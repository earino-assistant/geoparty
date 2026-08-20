# Beta delivery architecture audit — specification

**Status:** Requested by Eduardo; audit only.  
**Date:** 2026-08-20  
**Scope:** GeoParty’s proposed public beta delivery path, its actual GitHub Pages
behavior, and the minimum reliable alternative—or an explicit recommendation not
to build beta with current infrastructure.

> **HISTORICAL — audit brief, 2026-08-20.** The beta lane it commissions
> was audited and then **abandoned** by owner decision; GitHub Pages now
> publishes from `main` only. Kept as the incident evidence record;
> §2.6 of `docs/beta-delivery-architecture-audit.md` corrects one detail
> below. Nothing here is operational.

## Why this audit exists

We attempted an elegant single-site model:

```text
main branch  → public production at /geoparty/
beta branch  → public beta at /geoparty/beta/
one Pages artifact assembled from both refs
```

The promise was automatic behavior:

```text
push beta → test main + beta → deploy one Pages artifact → /beta/ updates
```

This was implemented in B0–B2, peer-reviewed, and partially validated. The key
assumption was wrong.

GitHub Pages’ official documentation says a custom Pages workflow deploys the
public site through `actions/deploy-pages` when triggered by a push to the
repository’s **default branch**. A beta-branch workflow can build/upload a valid
artifact and create a successful-looking deployment record without activating the
public Pages site.

This is not theoretical. We observed it.

## Observed evidence — exact incident record

### State before the beta attempt

- Production Pages artifact at main SHA `4641a74` was healthy.
- B0–B2 had been reviewed and pushed to `main`.
- Firebase `rooms-beta` rules were published and REST-validated:
  - valid 6-letter beta write: HTTP 200
  - invalid 4-letter beta write: HTTP 401
  - valid read: HTTP 200
  - valid cleanup: HTTP 200
  - invalid production 4-letter write: HTTP 401
- GitHub `github-pages` environment policy initially allowed only `gh-pages` and
  `main`; beta was then explicitly added as an allowed deployment branch.

### Beta branch run

- `beta` created from `4641a74` exactly.
- Run: `32392639719`.
- First deploy attempt failed because beta was disallowed by environment branch
  policy. This was corrected manually by adding `beta`.
- Rerun then showed all workflow build steps green:
  - main/beta SHA resolution
  - isolated main checkout
  - isolated beta checkout
  - tests/checks in both trees
  - artifact assembly
  - root + beta release stamps
  - beta noindex/PWA markers
  - artifact upload
  - `actions/deploy-pages@v4` reported success

### Artifact proof

The downloaded GitHub Pages artifact from that successful rerun contains:

```text
/release.json
/beta/index.html
/beta/release.json
/beta/manifest.webmanifest
```

Root stamp:

```json
{
  "short": "4641a74",
  "channel": "production",
  "ref": "main"
}
```

Beta stamp:

```json
{
  "short": "4641a74",
  "channel": "beta",
  "ref": "beta"
}
```

Beta manifest is correctly rewritten to `GeoParty Beta` / `GeoParty β`.

### Public-site result

Despite workflow and deployment success, GitHub Pages continued to serve the
prior main artifact:

```text
/geoparty/release.json           → previous main deployment stamp
/geoparty/beta/                  → HTTP 404
/geoparty/beta/release.json      → HTTP 404
```

This was checked repeatedly with cache-busting query parameters and headers for
more than two minutes after successful deployment. The old root artifact had a
prior last-modified timestamp/ETag. This is therefore not an artifact-content
failure.

The beta-ref deployment record reported `production_environment: false`; the
main-ref deployment was production. GitHub’s official Pages documentation
supports the conclusion that public activation is a default-branch behavior.

## How we missed it

This must be treated as a process failure, not merely an implementation bug.

1. The original beta plan assumed that allowing `beta` in the `github-pages`
   environment branch policy would make a beta-ref Pages deployment activate the
   public site. It does not establish that behavior.
2. Fable’s original plan and amendment focused on artifact assembly, GitHub
   Actions concurrency, branch protection, and Pages environment policy, but did
   not verify the decisive `deploy-pages` default-branch activation constraint.
3. Opus correctly implemented the approved plan, including robust local/static
   tests. Those tests could prove the artifact but not GitHub Pages activation.
4. Reviews checked workflow mechanics but accepted the plan’s platform premise.
5. We discovered the issue only through the first live beta deployment, which is
   exactly why claimed green deployment status must not be treated as proof that a
   public endpoint changed.

No party should defend the earlier design merely because B0–B2 code, Firebase
rules, or an environment policy already exist.

## Existing infrastructure and constraints

- GeoParty is a static, no-build GitHub Pages app.
- Current public production URL: `https://earino-assistant.github.io/geoparty/`.
- Current production source branch: `main`.
- One public Pages site per repository.
- No server/back-end, custom domain, external hosting, second repository, or
  build system is currently desired.
- The host cannot expose a public service; do not propose the Hermes container as
  an internet beta host.
- Firebase rooms can use isolated `rooms-beta/`; rules have already been
  published, but this may be reverted if beta is abandoned.
- PostHog channel code is present in main but beta PostHog console filters have
  not yet been configured.
- Production must remain live throughout.
- The user wants an easy, reliable verification lane, not abstract elegance.
- Policy: Fable plans/reviews; pinned Opus 4.8 implements; one repo agent at a
  time; no implementation/push/merge/promotion without Eduardo’s explicit
  approval.
- A public/noindex beta is acceptable, but authentication is not required.

## Audit question

What is the **most reliable, basic, low-operational-burden** way to let Eduardo
verify a candidate directly while production remains live?

The answer may be:

- Keep `/beta/`, but deploy the combined artifact only from a main-ref manually
  dispatched workflow after beta CI/review.
- Keep a beta branch but use an explicit main-branch deployment command/dispatch.
- Use GitHub-native PR mechanisms in a different shape.
- Adopt a tiny external preview service only if it is genuinely simpler/reliable
  enough to justify a second vendor.
- Do not pursue beta at all; use release tags/reverts/direct production validation
  because the current infrastructure cannot support a trustworthy beta lane.

Do not assume any option is favored because work already exists.

## Required audit method

1. Treat GitHub’s official documentation, official action source/README, and
   observed deployment evidence as primary sources.
2. Verify every proposed mechanism against the actual GitHub Pages constraints.
   Do not infer behavior from an action returning success.
3. Separate:
   - static artifact correctness,
   - GitHub deployment-record success,
   - public endpoint activation,
   - production safety,
   - user verification ergonomics.
4. Evaluate realistic operational failure modes: wrong ref, stale beta tip,
   deploy race, workflow ref semantics, failed candidate build, rollback,
   accidentally publishing unreviewed beta, Firebase room isolation, PWA/cache,
   PostHog KPI contamination, and user confusion.
5. State what existing B0–B2 work is reusable, what must change, and what should
   be reverted if an option is abandoned.
6. Give a decisive recommendation and a minimal migration plan.

## Deliverable required from Fable

Create `docs/beta-delivery-architecture-audit.md` only. Do not edit the existing
beta plan, code, workflows, rules, GitHub settings, PostHog, or branches. Do not
push.

The audit must include:

1. Executive verdict: recommended architecture, or “do not build beta with current
   infra.”
2. A factual reconstruction of the incident and missed assumption.
3. An options matrix with at least:
   - main-ref explicit dispatch of combined main+beta artifact,
   - current beta-ref auto-deploy attempt (rejected with evidence),
   - GitHub-native alternatives if actually viable,
   - external preview host if justified,
   - no-beta/release-tag path.
4. Reliability and complexity comparison.
5. Exact proposed operational flow: candidate creation, CI/review, public beta
   publication, verification, promotion, rollback.
6. Explicit branch/ref/deployment semantics; no vague “deploy beta” wording.
7. Firebase/PostHog/PWA privacy and isolation implications.
8. Exact changes/reverts required, with scope and testing requirements.
9. Owner decisions still required.
10. A learning/process section: source-first platform validation, the difference
    between a green deploy record and public endpoint verification, and what
    release check must become mandatory.

## Non-goals

- Do not invent a hidden server or expose the Hermes host.
- Do not assume future GitHub Pages preview support.
- Do not make an external vendor sound free operationally when it introduces
  accounts, permissions, configuration, secrets, or cross-origin differences.
- Do not recommend a solution just because it salvages existing code.
