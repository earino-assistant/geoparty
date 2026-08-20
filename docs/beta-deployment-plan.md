# Beta / preview deployment plan — one candidate, one artifact, zero vendors

Status: **approved design, not yet implemented.** Companion to
`docs/field-observability-plan.md` §11 (release stamping), which this plan
subsumes and extends — the Pages workflow described there and the one
described here are the **same workflow**.

---

## 1. Executive recommendation

**Serve production and one beta candidate from a single GitHub Pages
deployment, assembled in GitHub Actions from two branches:**

- `main` → `https://earino-assistant.github.io/geoparty/` (production)
- `beta` → `https://earino-assistant.github.io/geoparty/beta/` (the one
  candidate)

One workflow checks out both branches, runs the existing test suite on
each, copies them into `_site/` and `_site/beta/`, stamps a `release.json`
into each folder, and publishes with the first-party
`actions/upload-pages-artifact` + `actions/deploy-pages`. No third-party
actions, no second host, no second Firebase/PostHog project, no build
step in the dev loop — the repo still runs from a plain checkout.

Why this is the happy path:

- **It is the officially supported shape.** GitHub Pages allows exactly
  one site per repo and (verified Aug 2026) has **no native PR-preview
  feature** — but an Actions-deployed artifact is just a directory tree,
  and nothing stops that tree containing `beta/` assembled from a second
  ref. This is the only way to get a second URL out of GitHub Pages using
  only first-party tooling.
- **The observability plan already requires the workflow.** §11 of the
  field-observability plan switches Pages from branch-deploy to the
  Actions flow to stamp `release.json`. Beta support is ~15 extra lines
  in that same workflow, not a second system.
- **Promotion is a git fast-forward** (`beta` → `main`) of the exact
  verified commit. There is no build, so "promote without rebuilding
  different source" holds by construction: the promoted tree is
  byte-identical; only the stamp (`release.json`, beta markers) differs.
- **Rollback is a branch operation** — revert on `main`, force-push on
  `beta`. State never lives anywhere except the two branch tips.
- **Beta is testable end-to-end on real devices** at a real HTTPS URL:
  phones scan the beta host's QR (all links are derived from
  `location.href`, so beta pages generate beta links), the TV-typeable
  address becomes `earino-assistant.github.io/geoparty/beta`, and PWA
  install works with its own scope and identity (§5.3).

Firm choices this plan commits to (details in §5):

| Question | Decision |
|---|---|
| Beta URL | `/geoparty/beta/` on the existing Pages site |
| Candidate count | Exactly one (`beta` branch tip). No PR previews. |
| Firebase isolation | Separate RTDB namespace `rooms-beta/`, chosen client-side by a pure path-derived channel function |
| PostHog | **Same project**, `deployment_channel` super property, KPI insights filter it out |
| Session replay for beta | On, same staged policy as production |
| Promotion | `git push origin origin/beta:main` (fast-forward only) |
| Prod rollback | `git revert` + push (never force-push `main`) |
| External hosts | None |

---

## 2. Verified current state (inspected 2026-08-20)

Repo / site facts this design rests on:

- **Pages today deploys from the `main` branch** (there is no deploy
  workflow in `.github/workflows/` — only `ci.yml` — and the site is
  live). The observability plan's switch to Actions deploys is pending.
- **Production is live** at `https://earino-assistant.github.io/geoparty/`
  with `cache-control: max-age=600` (Fastly CDN, 10-minute TTL, not
  configurable). `release.json` returns 404 (not yet shipped). The
  account root `https://earino-assistant.github.io/` is itself 404 —
  there is **no user site**, so we cannot control an origin-root
  `robots.txt`; beta de-indexing must be a per-page `<meta>` tag.
- **No service worker exists.** `js/pwa.js` is pure standalone-display
  detection; nothing registers a SW, nothing caches. This removes the
  entire SW-scope/stale-cache class of beta problems — keep it that way
  (§9).
- **The manifest is fully relative**: `id: "./"`, `start_url: "./"`,
  `scope: "./"`, relative icon paths. Served from `/geoparty/beta/`, it
  automatically defines a *distinct* PWA (different id, different scope)
  with zero changes.
- **Every runtime URL is derived from the current page**: `screenLink()`
  and `siteAddress()` in `js/tvlink.js` build from `baseHref`,
  `withUtm()` wraps the given href, QR codes encode `screenLink`
  output, `joinHref` is relative. A grep found **no root-absolute
  (`/...`) asset or link paths** in HTML/JS/CSS. A copy of the tree under
  `/beta/` is therefore self-contained: beta QR codes, share links, TV
  links, and module imports all stay inside `/beta/`.
- **The only absolute URLs are OpenGraph/Twitter meta tags** pointing at
  production. Fine for beta (they only matter to link scrapers; a
  private-ish beta URL shared in chat will show production card art —
  accepted, §5.4).
- **Firebase**: RTDB rooms live at `rooms/$code` (`js/firebase.js
  roomRef()`); README rules allowlist only `rooms/` with
  `$roomCode.matches(/^[A-HJ-NP-Z]{6}$/)`, open read, 24 h write window.
  Rules are a manual console paste. Threat model is drive-by vandalism,
  not adversaries.
- **PostHog**: EU host, consent-gated via `js/consent.js` →
  `js/analytics.js`; `EVENT_SCHEMA` is a hard allowlist; §11 of the
  observability plan will `posthog.register()` release super properties
  after init.
- **CI** (`ci.yml`): `npm run check` + `npm test` on push-to-main and
  PRs. No dependencies, node 22.

GitHub platform facts (verified against current official docs, Aug 2026):

- One Pages site per repo; project sites at `/<repo>/`. **No native
  per-PR preview deployments exist** (only an internal alpha in
  `actions/deploy-pages`; nothing shipped publicly through 2026).
- Actions-based Pages publishing is GA. Current first-party versions:
  `actions/checkout@v4`, `actions/upload-pages-artifact@v3`,
  `actions/deploy-pages@v5`. Deploy job needs `pages: write` +
  `id-token: write` and should target the auto-created `github-pages`
  environment; `deploy-pages` outputs `page_url`.
- The artifact is a single tar (≤ ~1 GB supported; **no symlinks**);
  each deploy **replaces the whole site**. The 10-builds/hour soft limit
  applies only to branch builds, **not** Actions deploys.
- Official concurrency pattern: `group: "pages"`,
  `cancel-in-progress: false`.
- **Custom HTTP headers are still not supported** on Pages — no
  `X-Robots-Tag`, no cache-control tuning. 10-minute edge cache is fixed.
- Free personal accounts get environments (and protection rules) on
  public repos; not needed here beyond the default `github-pages` one.

---

## 3. Options matrix

| Option | Simplicity | Safety | Cost | Maintenance | Promotion | Rollback | Verdict |
|---|---|---|---|---|---|---|---|
| **A. One Actions artifact: `main` → `/`, `beta` branch → `/beta/`** | One workflow, first-party actions only | Prod bytes are a pure function of `main`; both refs tested pre-deploy | $0 | One workflow + one branch to understand | `git` fast-forward of the verified SHA | Branch ops; prod never force-pushed | **Recommended** |
| B. Commit a `beta/` folder into `main` (keep branch-deploy) | No workflow change | Copy drift; beta commits pollute `main` history; easy to ship beta to prod by accident | $0 | Manual copy/sync every iteration — exactly the long-lived sync step to avoid | Copy files over themselves | Revert a copy commit | Rejected |
| C. `gh-pages` publish branch (peaceiris-style) | Extra generated branch | Third-party action or hand-rolled push; generated history | $0 | Diverging generated branch to garbage-collect | Re-publish | Re-publish older | Rejected — option A does the same with zero extra branches |
| D. PR-preview folders (`rossjrw/pr-preview-action` etc.) | Third-party action, comment bots | Unbounded preview count — explicitly not wanted; previews share the prod origin | $0 | Stale-preview cleanup | N/A (previews aren't candidates) | N/A | Rejected — no official path exists, and the product wants **one** candidate |
| E. Cloudflare Pages / Netlify for previews | Second vendor, second origin, second deploy pipeline | Good (auto `noindex`, headers, access control) | $0 tier | Second dashboard, second auth, config drift vs Pages | Cross-vendor (verify on CF, ship on Pages) — verified bytes ≠ shipped origin | Two systems | Rejected — materially *less* simple, and cross-origin verify weakens "promote the exact verified thing" |
| F. Second repo (`geoparty-beta`) with its own Pages site | Two repos | Full isolation | $0 | Permanent repo-sync machinery | Cross-repo push | Two histories | Rejected |

Only option A satisfies all of: official/first-party, one candidate, one
vendor, promotion = moving a ref, and verify-what-you-ship on the same
origin. Option E is the fallback if GitHub Pages itself ever becomes the
constraint (e.g. a future need for auth-gated previews or custom
headers) — revisit then, not now.

---

## 4. Architecture and URL / branch / environment model

```
  git branches                    GitHub Actions                GitHub Pages (one site)
  ────────────                    ──────────────                ───────────────────────
  main ──────────┐                deploy-pages.yml              https://earino-assistant.github.io/geoparty/
   (production)  │  push to       ┌─────────────────────┐        ├── index.html … (from main)
                 ├─ main or ────▶ │ build:              │        ├── release.json   channel=production
  beta ──────────┘  beta          │  checkout main→prod/ │        └── beta/          (from beta, if branch exists)
   (the one                       │  checkout beta→beta/ │             ├── index.html …
    candidate;                    │  npm check+test ×2   │             ├── release.json  channel=beta
    force-push                    │  assemble _site/     │             └── manifest      name "GeoParty Beta"
    freely)                       │  stamp release.json  │
                                  │ deploy:              │       Firebase RTDB (one project)
                                  │  environment:        │        ├── rooms/       ← prod + dev clients
                                  │   github-pages       │        └── rooms-beta/  ← /beta/ clients
                                  │  deploy-pages@v5     │
                                  └─────────────────────┘       PostHog (one project)
                                                                  every event: deployment_channel =
                                                                  production | beta  (super property)
```

Model rules — small enough to hold in one head:

- **Site content is a pure function of two branch tips.** `/geoparty/` ≡
  tree of `main`; `/geoparty/beta/` ≡ tree of `beta`. No other state
  exists. A deploy triggered by either branch republishes both (the
  artifact replaces the whole site) — but unchanged `main` reproduces
  byte-identical production, so beta pushes never change production
  behavior.
- **`beta` is disposable.** It is the one candidate slot: create it to
  open a beta, force-push it to iterate, delete it to close the beta
  (the workflow then publishes an artifact without `/beta/`, and the
  URL 404s). It carries no history obligations.
- **`main` is sacred.** Never force-pushed; rollback is `git revert`.
- **Channel identity is derived from the URL path**, in one pure
  function (§5.1) — never from config files, never stamped into JS.
- **Environments**: the single auto-managed `github-pages` environment,
  with `deploy-pages`' `page_url` wired to `environment.url` so the repo
  Deployments tab is the deploy history. No protection rules (single
  owner; the protection is that both refs must pass tests in `build`).
  A separate "beta" GitHub environment would be theater — both channels
  ship in one deployment by design.
- **Tags**: optional, not load-bearing. On promotion the owner may tag
  `prod-YYYYMMDD` on the promoted SHA for human history; `release.json`
  (commit + timestamp, queryable at both URLs) is the runtime source of
  truth, and the Deployments tab is the audit trail.

---

## 5. Isolation design

### 5.1 One pure channel function (`js/channel.js`)

New pure module, unit-tested, no DOM/network:

```js
// channel.js — which deployment channel is this page running in?
// The path is the identity: /beta/ anywhere in the directory chain
// means the beta channel. Everything channel-dependent (Firebase
// namespace, PostHog deployment_channel) derives from this ONE function.
export function channelFromPath(pathname) {
  return /\/beta\//.test(pathname + "/") ? "beta" : "production";
}

export function roomsRoot(pathname) {
  return channelFromPath(pathname) === "beta" ? "rooms-beta" : "rooms";
}
```

Tests: `/geoparty/` → production; `/geoparty/beta/` and
`/geoparty/beta/player.html` → beta; `/geoparty/betamax.html` →
production (the trailing-slash normalization plus `/beta/` match makes
`/geoparty/beta` the directory, not a prefix match); `file://` dev paths
→ production (dev keeps today's behavior exactly). Synchronous and
infallible — usable at Firebase-connection time, unlike `release.json`
(which is fetched async and is *metadata*, not identity: §5.5).

### 5.2 Firebase: hard namespace isolation

**Decision: beta clients use `rooms-beta/$code`; production and dev
checkouts keep `rooms/$code`.** `js/firebase.js` `roomRef()` takes its
root from `roomsRoot(location.pathname)`.

Resolutions to the required questions:

- **Schema compatibility / drift.** This is the real risk (a beta that
  changes room-state shape must never feed a production phone). Hard
  namespace separation makes it structurally impossible — no
  version-negotiation protocol needed in either client.
- **Room-code collisions.** Non-issue: the namespaces are disjoint
  subtrees, so the same 6-letter code can exist in both without contact.
  Within a channel, collision odds are unchanged from today.
- **Prod phone joins a beta room (or vice versa).** Only possible by
  hand-typing a code from the other channel's TV into the wrong site —
  QR and share links always carry the channel-correct URL. The typed
  code hits the other namespace and behaves exactly like a mistyped
  code: the existing "check the TV or the invite" not-found path. No new
  UI, no crash mode, symmetric in both directions.
- **Security rules.** Mirror the existing `rooms` block verbatim as a
  `rooms-beta` sibling (same regex, same 24 h write window, same
  `createdAt` skew validation) in the one-time console paste (§10).
  Same threat model, same deliberate permissiveness. Bonus: future
  rule *changes* can be trialed on the `rooms-beta` block against real
  beta traffic without touching the production block — the rules are
  per-subtree even though the database is shared.
- **Cleanup.** The existing 24 h room-expiry write rule applies to both
  subtrees; beta rooms age out like production rooms. No new jobs.

Rejected alternative: a `channel` field inside each room plus a
join-time compatibility check. More code in both clients, needs shipping
a forward-compat check to production *first*, and still lets a beta
client touch production data if the check has a bug. The namespace is
simpler and fails closed.

### 5.3 PWA / manifest / service worker under `/beta/`

- The relative manifest already yields a **separate installed app** for
  beta: `id` and `scope` resolve against the manifest URL, so a beta
  install is scoped to `/geoparty/beta/` and cannot navigate onto
  production pages in-app, and vice versa. Verified: no `start_url`,
  `scope`, or icon path in `manifest.webmanifest` is absolute.
- So the two installs don't look identical on a home screen, the beta
  **stamp step** (CI-only, §6) rewrites the beta copy's manifest:
  `"name": "GeoParty Beta"`, `"short_name": "GeoParty β"`. Nothing is
  committed; the repo manifest stays canonical.
- **No service worker exists and none is added by this plan.** That is a
  feature: no cross-channel cache poisoning is possible, and "did I get
  the new beta?" is answered by the 10-minute Pages CDN TTL plus
  `release.json`, not by a SW update dance. If a SW is ever introduced,
  its file placement gives the split for free (Pages can't set
  `Service-Worker-Allowed`, so a SW at `/geoparty/beta/sw.js` is
  hard-capped to `/beta/` scope) — but that is out of scope and
  discouraged (§9).

### 5.4 Paths, links, QR, OG, indexing

- **Asset cross-loading: structurally impossible.** All imports, hrefs,
  and CSS URLs are relative (verified §2); `/beta/` pages resolve every
  asset under `/beta/`. The only cross-channel references are the
  absolute `og:url` / `og:image` meta tags in beta pages, which point at
  production. **Accepted as-is**: they're read only by link-unfurling
  scrapers, beta links aren't meant to be shared publicly, and
  production card art on an accidentally shared beta link is the
  *correct* face anyway. Not worth a rewrite step.
- **QR / TV / share links** are generated from `location.href` at
  runtime, so the beta host's QR opens the beta player page, the beta
  TV-typeable address reads `earino-assistant.github.io/geoparty/beta`,
  and share cards from a beta game carry beta URLs (UTM-tagged as
  usual; they land as `deployment_channel=beta` traffic and are filtered
  out of KPIs — §5.5).
- **Indexing**: no `X-Robots-Tag` and no origin-root `robots.txt` are
  possible on Pages (§2), so the stamp step injects
  `<meta name="robots" content="noindex">` into each beta `*.html`
  `<head>`. Nothing links to `/beta/` from production, so this is a
  belt on an already-unlinked suspender. The URL is "private-ish", not
  private: acceptable because the site holds no secrets, the DB is
  open-by-design within its rules, and the worst case is a stranger
  playing the beta.
- **CDN caching**: both channels share the fixed 10-minute edge TTL.
  The verify flow (§7) therefore starts by fetching
  `beta/release.json` with `cache: no-store` semantics (`curl` or the
  in-page release stamp) and comparing `short` to the pushed SHA —
  never by eyeballing UI differences through a possibly-stale cache.

### 5.5 PostHog: same project, `deployment_channel` super property

**Decision: one PostHog project.** A second project would double
dashboards, alerts, and API keys, split the replay quota, and drift —
for an audience of one owner. Instead:

- `release.json` gains a `channel` field, and the §11 register glue
  (consent.js, post-init only) registers
  `posthog.register({ release, commit, deployed_at, deployment_channel })`
  where `deployment_channel` comes from `channelFromPath()` (the path is
  identity; `release.json`'s `channel` is cross-check metadata). Every
  event, exception, `$web_vitals`, and replay is thereby
  channel-stamped. Dev checkouts register `release: "dev"`,
  `deployment_channel: "production"` — unchanged dev semantics, and dev
  noise is already excluded by `release`.
- Super properties ride outside `EVENT_SCHEMA` (they're registered on
  the PostHog client, not passed through `track()`) — same mechanism §11
  already established for `release`. Documented in `docs/analytics.md`
  alongside the release properties. They are aggregates by construction
  (two fixed strings, a SHA, a timestamp): no privacy surface.
- **KPI hygiene**: every KPI insight/dashboard panel adds the filter
  `deployment_channel is not "beta"` (which also matches historical
  events that predate the property). Additionally, set PostHog's
  project-level **"filter out internal and test users"** default filter
  to `deployment_channel = beta`, so *new* insights exclude beta by
  default and beta data is one toggle away when wanted. Beta analysis
  happens by flipping that toggle or filtering `= beta` — no separate
  project needed.
- **Session replay / error tracking for beta: on, identical policy.**
  Beta sessions are the owner's own devices and consent-gated like
  everything else; replays of beta bugs are precisely the point of the
  observability work, and `deployment_channel` + `release` on the
  exception events keep beta issues distinguishable in the issues list.
  No config fork between channels — one less thing to drift.

### 5.6 No secrets

Unchanged: the artifact contains only what the repo already publishes
(Mapillary/Firebase/PostHog embeddable client keys, by design). The
workflow needs no repository secrets at all — `GITHUB_TOKEN` with the
declared permissions covers checkout and Pages deploy. Anything that
would need a secret is out of scope by definition.

---

## 6. GitHub Actions workflow design

One new workflow, `.github/workflows/deploy-pages.yml`. The existing
`ci.yml` stays untouched (it remains the PR gate); the deploy workflow
runs the same checks itself so a deploy can never outrun a red suite.

- **Triggers**: `push` to `main` or `beta`; `workflow_dispatch` with an
  `include_beta` boolean (default true) — the escape hatch that ships a
  prod-only artifact if the beta branch is broken/abandoned mid-hotfix.
- **Jobs**: `build` (checkout both refs, test both, assemble, stamp,
  upload) → `deploy` (`deploy-pages` into the `github-pages`
  environment). Least-privilege permissions per job.
- **Concurrency**: the official Pages pattern — serialize deploys, never
  cancel an in-flight production deploy.
- **Failure semantics**: any red check on *either* ref fails the run
  before upload; the live site keeps serving the previous deployment.
  A broken `beta` therefore blocks deploys until the owner either fixes
  it, force-pushes it elsewhere, deletes it, or dispatches with
  `include_beta: false` — four one-liners, all explicit (§7).

Representative YAML (versions per current starter workflow):

```yaml
name: Deploy Pages (production + beta)

on:
  push:
    branches: [main, beta]
  workflow_dispatch:
    inputs:
      include_beta:
        description: "Include /beta/ from the beta branch"
        type: boolean
        default: true

permissions:
  contents: read

concurrency:
  group: "pages"            # official pattern: one deploy at a time,
  cancel-in-progress: false # never cancel an in-flight deploy

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Check out production (main)
        uses: actions/checkout@v4
        with: { ref: main, path: prod }

      - uses: actions/setup-node@v4
        with: { node-version: 22 }

      - name: Detect beta branch
        id: beta
        env:
          INCLUDE_BETA: ${{ inputs.include_beta != false }}
        run: |
          if [ "$INCLUDE_BETA" = "true" ] && \
             git ls-remote --exit-code --heads \
               "https://github.com/${{ github.repository }}" beta >/dev/null; then
            echo "exists=true"  >> "$GITHUB_OUTPUT"
          else
            echo "exists=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Check out beta
        if: steps.beta.outputs.exists == 'true'
        uses: actions/checkout@v4
        with: { ref: beta, path: beta }

      - name: Checks — production
        working-directory: prod
        run: npm run check && npm test

      - name: Checks — beta
        if: steps.beta.outputs.exists == 'true'
        working-directory: beta
        run: npm run check && npm test

      - name: Assemble site
        run: |
          stamp () {  # stamp <checkout-dir> <channel> <ref>
            sha=$(git -C "$1" rev-parse HEAD)
            printf '{"commit":"%s","short":"%s","deployed_at":"%s","run":"%s","channel":"%s","ref":"%s"}\n' \
              "$sha" "${sha:0:7}" "$(date -u +%FT%TZ)" \
              "${{ github.run_id }}" "$2" "$3"
          }
          rsync -a --exclude .git --exclude .github prod/ _site/
          stamp prod production main > _site/release.json
          if [ "${{ steps.beta.outputs.exists }}" = "true" ]; then
            rsync -a --exclude .git --exclude .github beta/ _site/beta/
            stamp beta beta beta > _site/beta/release.json
            # Beta identity: distinct PWA name, and noindex (Pages
            # cannot set X-Robots-Tag; meta tag is the only mechanism).
            sed -i 's/"name": "GeoParty"/"name": "GeoParty Beta"/;
                    s/"short_name": "GeoParty"/"short_name": "GeoParty β"/' \
              _site/beta/manifest.webmanifest
            find _site/beta -maxdepth 1 -name '*.html' -exec \
              sed -i 's|</title>|</title>\n  <meta name="robots" content="noindex" />|' {} +
          fi

      - uses: actions/upload-pages-artifact@v3
        with: { path: _site }

  deploy:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      pages: write      # to deploy to Pages
      id-token: write   # to verify the deployment source
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v5
```

Notes for the implementer:

- `prod` is always checked out from `refs/heads/main` (not
  `github.sha`), so every run — whichever branch triggered it — deploys
  the *current* branch tips. Deterministic and re-run-safe; rollback is
  a branch operation, never a workflow re-run.
- `rsync -a` copies (no symlinks — the Pages artifact forbids them; the
  repo has none). Excluding only `.git`/`.github` preserves exact parity
  with today's branch-deploy (which already publishes `docs/`, `tests/`,
  `tools/` — all public content).
- The stamp `printf` is the whole "build step". It never enters the dev
  loop; a checkout still runs from `file://` with `release.json` simply
  absent → `release: "dev"`, exactly as the observability plan specifies.
- The `sed` edits touch only the CI-assembled beta copy. Repo files are
  never modified. If the manifest/`</title>` shapes drift, the beta stamp
  degrades to a no-op (identical PWA name, no noindex) — cosmetic, not
  breaking; the phase-B0 acceptance check (§8) catches it.
- One-time settings change (owner, §10): repo **Settings → Pages →
  Source: GitHub Actions**. Flip it first — the live site keeps serving
  the last branch-build until the first Actions deploy replaces it.

---

## 7. Day-to-day operations

All flows are plain git against two well-known branches. (`gh` shown
where it's the natural tool; the Actions tab works for all of it too.)

**Open / update the beta** (from any candidate commit):

```sh
git push origin <candidate-sha>:refs/heads/beta   # create or move
git push -f origin my-feature:refs/heads/beta     # iterate: force-push freely
```

→ workflow runs (~1–2 min), then up to 10 min CDN cache.

**Verify the beta:**

```sh
curl -s https://earino-assistant.github.io/geoparty/beta/release.json
# → {"short":"<must match the pushed sha>","channel":"beta",...}
```

Then the owner checklist on real hardware:
1. Phone A opens `/geoparty/beta/`, hosts a couch game; **confirm the
   room appears under `rooms-beta/` in the Firebase console** (proves
   the namespace + rules are live — do this on the first-ever beta).
2. Phone B scans the QR → lands on a `/beta/` URL, joins, plays a round.
3. TV path: scan/type — the typeable address shows
   `…/geoparty/beta`; screen attaches.
4. Consent-accept on one device → PostHog Activity shows events with
   `deployment_channel=beta` and `release` = the beta SHA.
5. Production spot-check: open `/geoparty/` — `release.json` still
   shows the `main` SHA; a prod room lands in `rooms/`.

**Promote the exact verified commit:**

```sh
git fetch origin
git push origin origin/beta:main    # fast-forward only; rejected if main moved
# if rejected: rebase the candidate onto main, re-push beta, re-verify, retry
git tag prod-$(date +%Y%m%d) origin/beta && git push origin --tags   # optional
```

The push triggers the same workflow; production now serves the verified
tree byte-for-byte (only `release.json` and the beta stamps differ —
there is no build to diverge). Leaving `beta` == `main` afterwards is
harmless (`/beta/` mirrors prod); to close the beta slot:

```sh
git push origin :beta                      # delete the branch
gh workflow run deploy-pages.yml           # branch deletion doesn't trigger
                                           # push workflows; one dispatch
                                           # publishes the beta-less artifact
```

**Roll back:**

```sh
# beta (anything goes — it's the disposable slot):
git push -f origin <any-sha>:refs/heads/beta

# production (history-preserving, never force-push main):
git revert <bad-sha> && git push origin main
# or for a multi-commit promotion: git revert -m/<range> as usual
```

Live in ~2 min plus ≤10 min cache; confirm via `release.json`.

**Broken beta is blocking a prod hotfix** (the one awkward mode, §9):

```sh
gh workflow run deploy-pages.yml -f include_beta=false   # ship prod alone
# or: git push origin :beta        (delete the slot entirely)
```

---

## 8. Implementation phases (for Opus)

Ground rules per repo policy: pure logic in pure modules with
`tests/*.test.js` coverage; `npm test` + `npm run check` green; analytics
schema/docs updated with any event change; consent gate untouched.

**B0 — the workflow (supersedes observability P0 item 1).**
`deploy-pages.yml` exactly as §6, including the beta half from day one;
extend the §11 `release.json` shape with `channel`/`ref`; owner flips
the Pages source (§10).
*Tests:* none in-repo (YAML isn't node-testable) — acceptance is live:
after merge, `/geoparty/` serves identical content with a valid
`release.json` (`channel=production`, `short` = `main` SHA); pushing a
throwaway `beta` branch makes `/geoparty/beta/release.json` appear with
`channel=beta`, beta pages contain the `noindex` meta and the renamed
manifest; deleting it + one dispatch returns `/beta/` to 404. Genuinely
untestable-in-CI portions are this list, stated per repo rule.

**B1 — channel + Firebase namespace.**
New `js/channel.js` (`channelFromPath`, `roomsRoot`) with the §5.1 test
matrix; `js/firebase.js` `roomRef()`/rules-adjacent helpers take the
root from `roomsRoot(location.pathname)`; README rules block gains the
mirrored `rooms-beta` sibling; owner pastes rules (§10) **before** the
first real beta session.
*Tests:* channel/table tests incl. the `betamax` false-positive and
`file://` cases; a test that `roomsRoot` returns only values the rules
allowlist. *Acceptance:* verify-checklist items 1 and 5 (§7).
*Instrumentation:* none — no new product decision point; channel rides
on every event via B2 (justification per repo rule: a dedicated event
would duplicate the super property).

**B2 — PostHog channel stamping + KPI hygiene.**
Extend the §11 register glue's payload with `deployment_channel` from
`channelFromPath`; add the super-property row to `docs/analytics.md`;
owner sets the PostHog internal/test-user default filter and adds
`deployment_channel is not "beta"` to existing KPI insights (§10).
*Tests:* pure register-payload builder covered for both channels and the
dev (`release.json`-absent) case; existing sanitizer tests untouched
(super properties bypass `track()` by design — assert the builder emits
only the five fixed keys).
*Acceptance:* verify-checklist item 4; a beta event visibly excluded
from a KPI insight.

**B3 (optional polish, not blocking).** A small "BETA" corner badge on
`/beta/` pages driven by `channelFromPath` (pure predicate already
tested; DOM glue only) — helps mid-party "which site is this phone on?"
No event (the super property already answers every product question).

Sequencing with the observability work: B0 merges *with or immediately
after* observability P0 (same workflow file — coordinate so only one of
the two plans authors it, with this plan's version as the superset).
B1/B2 are independent of the observability phases and of each other.

---

## 9. Risks, failure modes, and what NOT to build

Failure modes and their designed responses:

- **Red `beta` blocks all deploys** (including prod hotfixes). Accepted
  for predictability ("nothing deploys unless everything deployable is
  green") because the unblock is a documented one-liner
  (`include_beta=false` dispatch, or delete the branch) — §7.
- **Forgotten rules paste** → beta room creation writes are silently
  rejected (fire-and-forget), host plays on while nobody can join — the
  known Firebase failure shape. Mitigated by verify-checklist item 1
  (console check on first beta) and the B1 acceptance gate.
- **Stale CDN confusion** — owner tests old bytes for up to 10 min.
  Mitigated by making `release.json` the first verify step, never UI
  eyeballing.
- **Beta URL leaks** — noindex meta, nothing links to it, no secrets,
  DB open-by-design; worst case a stranger plays the beta. Accepted.
- **`sed` stamp drift** (manifest/`</title>` shape changes) — degrades
  to cosmetic no-op, caught by B0's acceptance checks on next beta open.
- **Non-ff promotion race** (`main` moved while verifying) — the plain
  push is rejected; the documented response is rebase → re-verify →
  retry, never `-f`.
- **Both-channels-one-DB rules mistakes** — a bad rules edit can affect
  production; mitigated by trialing rule changes on the `rooms-beta`
  block first (§5.2) and by the rules being two independent siblings.

What NOT to build (each rejected above; listed so nobody re-litigates):

- **No PR previews / multiple candidates** — one `beta` slot, period.
- **No second Firebase or PostHog project**, no separate PostHog key.
- **No service worker**, for either channel — the no-SW state is
  load-bearing for cache-safety here.
- **No third-party deploy actions**, no `gh-pages` branch, no external
  preview host, no second repo.
- **No room-schema version negotiation** — the namespace split makes it
  dead code.
- **No committed version/beta files, no beta config forks in JS** — the
  path is the channel; the stamp lives only in the CI artifact.
- **No custom-domain / robots.txt machinery** for privacy — noindex
  meta is the ceiling of what Pages supports and is proportionate.

---

## 10. Owner checklist (one-time + per-beta)

One-time setup, in order:

- [ ] Confirm with the observability track who lands
      `deploy-pages.yml` (this plan's §6 version is the superset).
- [ ] Repo **Settings → Pages → Build and deployment → Source: GitHub
      Actions** (site keeps serving until the first Actions deploy).
- [ ] Merge B0; confirm `/geoparty/release.json` goes live and the
      site is unchanged.
- [ ] Firebase console → Realtime Database → Rules: paste the updated
      rules with the mirrored `rooms-beta` block; publish.
- [ ] PostHog: set the internal/test-user default filter to
      `deployment_channel = beta`; add `deployment_channel is not
      "beta"` to existing KPI insights/dashboards.

Per-beta cycle:

- [ ] `git push -f origin <candidate>:refs/heads/beta`
- [ ] `curl …/beta/release.json` — SHA matches.
- [ ] Run the §7 device checklist (two phones + TV path + consent/
      PostHog + prod spot-check).
- [ ] Promote: `git push origin origin/beta:main`; optional tag.
- [ ] Confirm `/geoparty/release.json` shows the promoted SHA.
- [ ] Optionally close the slot: `git push origin :beta` + one
      `workflow_dispatch`.

Rollback cards (keep handy):

- Beta: `git push -f origin <good>:refs/heads/beta`
- Production: `git revert <bad> && git push origin main`
- Prod-only emergency deploy: `gh workflow run deploy-pages.yml
  -f include_beta=false`
