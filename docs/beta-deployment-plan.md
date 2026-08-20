# Beta / preview deployment plan — one candidate, one artifact, zero vendors

Status: **amended spec (v2, 2026-08-20) — awaiting owner approval, then
Opus implements.** This version **supersedes the original plan text of
commit `0f28562` in full**; where any earlier revision, quotation, or
derived note contradicts this document, this document wins. The amendment
exists because the EM review (P2-2,
`docs/engineering-manager-review-v0.3.md:206–224`) found the original's
"verified current state" stale: `.github/workflows/pages.yml` had already
landed in the plan's own parent commit, so implementing the original
literally would have authored a *second* Pages deploy workflow and produced
dueling deploys, with `/beta/` flapping between live and 404.

Companion docs: `docs/field-observability-plan.md` §11 (release stamping —
now **implemented** as `pages.yml`; this plan extends that same file),
`docs/analytics.md` (super-property catalog), `README.md:140–158`
(published Firebase rules).

---

## 0. What this amendment changes (delta vs. `0f28562`)

Corrections of stale facts:

- `pages.yml` **exists and is live** (landed with `c7f7369`); root
  `release.json` is stamped and consumed by `js/consent.js:119–133`. The
  original claimed neither existed.
- The shipped workflow pins `actions/deploy-pages@v4`
  (`pages.yml:82`), not v5 as the original asserted (EM P3-10). This plan
  keeps **v4 as shipped**; version bumps are a separate chore, not part of
  the beta work.
- Tags: `v0.3.0` **exists at `28d2b5b`** (alongside `v0.1.0-couch`,
  `v0.2.0-h2h`). The original's "tags are optional/stale" framing is
  replaced by §10's tag policy.

Corrections of design traps the EM review identified in the original:

1. **One workflow, extended in place.** The plan now modifies
   `.github/workflows/pages.yml` itself. No `deploy-pages.yml` is ever
   created; §8 adds a static test asserting exactly one deploy workflow.
2. **`channelFromPath` gains a protocol guard.** The original's
   path-only match would classify a `file://` dev checkout living in a
   directory named `beta/` as the beta channel, contradicting its own
   "file:// → production" claim. §5.1 fixes the signature.
3. **`deployment_channel` registers synchronously at init**, not inside
   the async `release.json` fetch — otherwise early events pass production
   KPI filters. §5.5.
4. **`RELEASE_PROPS` must be extended.** `register()` sanitizes against
   the frozen allowlist at `js/analytics.js:419–422`; without adding
   `deployment_channel` there, a naive implementation registers nothing.
   §5.5.
5. **Immutable-SHA checkouts** and the resulting loss of the
   "re-run an old green run" rollback path are now explicit (§6.3, §6.7 —
   the trade the EM asked the plan to state,
   `engineering-manager-review-v0.3.md:419–425`).
6. **An owner walkthrough for publishing the Firebase rules** (§7) —
   the plan's single manual-step-or-nothing-works dependency — with
   sequencing that avoids a live-but-broken beta window.

Everything else — the options analysis, the isolation design, the
"what NOT to build" list — is retained with re-verified citations.

---

## 1. Executive recommendation (unchanged in substance)

**Serve production and one beta candidate from a single GitHub Pages
deployment, assembled by the existing `pages.yml` from two branches:**

- `main` → `https://earino-assistant.github.io/geoparty/` (production)
- `beta` → `https://earino-assistant.github.io/geoparty/beta/` (the one
  candidate)

The one shipped workflow gains: a `beta` push trigger, a resolve step that
pins both branch tips to immutable SHAs, a second checkout + test run in
an isolated directory, an assembly step that nests the beta tree under
`_site/beta/`, and per-channel `release.json` stamps. Still one artifact,
one deploy job, first-party actions only, no build step in the dev loop.

Why this stays the happy path:

- **It is the officially supported shape.** One Pages site per repo, no
  native PR-preview feature — but an Actions artifact is just a directory
  tree, and nothing stops it containing `/beta/` from a second ref.
- **The deploy workflow already exists and is proven** (EM: "deploy path:
  ready"). Beta support is an extension of a live, reviewed workflow, not
  a new system.
- **Promotion is a git fast-forward** of the exact verified SHA: no build
  means the promoted tree is byte-identical to what was verified; only
  the stamps (`release.json`, beta markers) differ.
- **Rollback is a branch operation** — `git revert` on `main`, force-push
  on `beta`. State never lives anywhere except the two branch tips.
- **Beta is testable end-to-end on real devices** at a real HTTPS URL:
  QR/share/TV links derive from the current page (§5.4), and the relative
  manifest yields a distinct PWA install under `/beta/` (§5.3).

Firm choices (details in §5–§7):

| Question | Decision |
|---|---|
| Beta URL | `/geoparty/beta/` on the existing Pages site |
| Workflow | Extend `.github/workflows/pages.yml` in place; never a second deploy workflow |
| Candidate count | Exactly one (`beta` branch tip). No PR previews. |
| Firebase isolation | Separate RTDB subtree `rooms-beta/`, chosen client-side by one pure channel function |
| PostHog | Same project; post-consent `deployment_channel` super property; KPI insights exclude beta |
| Session replay for beta | On, identical policy and masking as production |
| Promotion | `git push origin origin/beta:main` (fast-forward only, owner-approved) |
| Prod rollback | `git revert` + push (never force-push `main`) |
| External hosts / second projects | None |

---

## 2. Verified current state (re-inspected 2026-08-20 at `84924b8`)

Facts inspected in the working tree today:

- **`pages.yml` is the one deploy workflow.** Triggers: push to `main` +
  `workflow_dispatch` (`pages.yml:12–15`); least-privilege permissions
  (`:19–22`); concurrency `group: pages`, `cancel-in-progress: false`
  (`:25–27`); build job runs `npm run check` + `npm test`
  (`:41–45`), stamps `release.json` via inline `node -e` with
  `{commit, short, deployed_at, run, env:"pages"}` (`:52–65`), uploads the
  repo root as the artifact (`:69–71`), deploys with
  `configure-pages@v5` + `deploy-pages@v4` (`:67`, `:82`).
  `release.json` is gitignored (`.gitignore:1–4`) — it can never be
  committed.
- **`ci.yml` is the PR gate**: push-to-main + `pull_request`, same
  check/test pair. It does not deploy; it stays untouched.
- **`js/consent.js:119–133`** fetches `release.json` with a **relative**
  path and registers `release`/`commit`/`deployed_at`; absent file →
  `release: "dev"`. Under `/geoparty/beta/`, the same code fetches
  `/geoparty/beta/release.json` with zero changes.
- **`js/analytics.js`**: `register()` (lines 600–610) sanitizes against
  the frozen `RELEASE_PROPS` allowlist
  (`release`/`commit`/`deployed_at`, lines 419–422); the registered bag
  is buffered and applied **before** the queued events flush after the
  PostHog script loads (lines 522–530). `BANNED_KEY_RE`
  (line 427) does not match `deployment_channel`. `POSTHOG_INIT_OPTIONS`
  is owner-provided and deliberately mutable — this plan does not touch
  it.
- **`js/firebase.js:20–22`** — `roomRef()` is the single choke point:
  every room read/write/subscribe/transaction helper in the module routes
  through it; the only other `ref()` use is `.info/connected`
  (line 76). The string `rooms/` appears nowhere else in `js/` (grepped).
- **Published Firebase rules** (`README.md:144–158`): allowlist only
  `rooms/$roomCode`, 6-letter code regex `^[A-HJ-NP-Z]{6}$`, open read,
  24 h write window, `createdAt` +5 min skew tolerance, delete allowed
  (`newData.val() == null`). Top-level `.read/.write: false` — so
  `rooms-beta/` is **denied today**; adding its block cannot loosen
  anything retroactively.
- **Room codes are 6 letters in every mode** — couch and h2h share
  `isRoomCode` (`js/game.js:33`); there is no 4-letter code anywhere.
  (4-letter paths matter only as the *negative* case when validating
  rules, §7.3.)
- **No root-absolute URLs.** A grep across all HTML/JS/CSS for
  `src="/`, `href="/`, `url(/`, `from "/`, `import("/`, `fetch("/` found
  zero hits. All runtime links derive from the current page:
  `screenLink()`/`siteAddress()` build from `baseHref`
  (`js/tvlink.js:26–43`; `host-ui.js:384` passes `location.href`),
  `withUtm()` wraps a caller-supplied href (`js/share.js:19–23`),
  `joinHref` is relative (`js/frontdoor.js`). The only absolute URLs are
  the OpenGraph/Twitter meta tags pointing at production
  (`index.html:18–19`, `host.html:18–19`, `player.html:19`) — accepted
  as-is (§5.4).
- **The manifest is fully relative** (`manifest.webmanifest`): `id`,
  `start_url`, `scope` all `"./"`, relative icon paths. Served from
  `/beta/` it defines a distinct PWA automatically.
- **No service worker exists.** `js/pwa.js` is pure standalone-display
  detection; nothing registers a SW. This stays load-bearing (§12).
- **RTDB REST endpoint** (for the console-independent rules validation in
  §7.3): `databaseURL` in `config.js` is
  `https://geoparty-9ffe7-default-rtdb.europe-west1.firebasedatabase.app`
  (a public client identifier, by design).

Platform facts carried from the original plan (checked against official
docs Aug 2026, **not re-verifiable from this checkout**): one Pages site
per repo; no native PR previews; the artifact is a single tar (no
symlinks) and each deploy replaces the whole site; Actions deploys are
exempt from the 10-builds/hour branch limit; custom HTTP headers
(`X-Robots-Tag`, cache-control) are not supported — the ~10-minute Fastly
edge TTL is fixed; the account root `https://earino-assistant.github.io/`
serves no user site, so beta de-indexing must be per-page `<meta>` tags.
Additionally (GitHub documented behavior): for `push`-triggered runs the
workflow file is read **from the pushed ref** (§6.6), branch *deletion*
does not trigger push workflows, and a concurrency group holds at most
one pending run — a newer pending run supersedes an older pending one,
while `cancel-in-progress: false` protects the run that is already
deploying.

---

## 3. Options matrix (retained; option A re-scoped to the real workflow)

| Option | Simplicity | Safety | Cost | Maintenance | Promotion | Rollback | Verdict |
|---|---|---|---|---|---|---|---|
| **A. Extend the shipped `pages.yml`: `main` → `/`, `beta` branch → `/beta/`, one artifact** | Extends a live, reviewed workflow | Prod bytes are a pure function of `main`; both refs tested pre-deploy; single deploy job → no dueling deploys possible | $0 | One workflow + one branch to understand | `git` fast-forward of the verified SHA | Branch ops; prod never force-pushed | **Recommended** |
| B. Commit a `beta/` folder into `main` | No workflow change | Copy drift; beta commits pollute `main`; easy to ship beta to prod by accident | $0 | Manual copy/sync every iteration | Copy files over themselves | Revert a copy commit | Rejected |
| C. `gh-pages` publish branch | Extra generated branch | Third-party action or hand-rolled push | $0 | Diverging generated branch | Re-publish | Re-publish older | Rejected — A does the same with zero extra branches |
| D. PR-preview folders (third-party actions) | Comment bots, unbounded previews | Previews share the prod origin | $0 | Stale-preview cleanup | N/A | N/A | Rejected — product wants **one** candidate |
| E. Cloudflare Pages / Netlify previews | Second vendor, second origin | Good headers/auth | $0 tier | Second dashboard, config drift | Cross-vendor: verified bytes ≠ shipped origin | Two systems | Rejected — weakens "promote the exact verified thing" |
| F. Second repo with its own Pages site | Two repos | Full isolation | $0 | Permanent repo-sync machinery | Cross-repo push | Two histories | Rejected |

The post-`pages.yml` reality *strengthens* option A: the risky part of the
original A (authoring a deploy workflow from scratch) is already done,
reviewed, and live. What remains is an incremental, testable extension of
that file. The original A's one hazard — accidentally becoming two
workflows — is retired by making "extend in place" a stated invariant with
a static test (§8.2). Option E remains the fallback only if Pages itself
becomes the constraint (auth-gated previews, custom headers).

---

## 4. Architecture and URL / branch model

```
  git branches                   GitHub Actions                 GitHub Pages (one site)
  ────────────                   ──────────────                 ───────────────────────
  main ──────────┐               pages.yml (extended)           https://earino-assistant.github.io/geoparty/
   (production)  │  push to      ┌──────────────────────┐        ├── index.html … (main tip)
                 ├─ main or ───▶ │ build:               │        ├── release.json  channel=production
  beta ──────────┘  beta         │  resolve SHAs (once) │        └── beta/         (beta tip, if branch exists)
   (the one                      │  checkout prod/ beta/│             ├── index.html …
    candidate;                   │  check+test ×2       │             ├── release.json  channel=beta
    force-push                   │  assemble _site/     │             └── manifest      name "GeoParty Beta"
    freely)                      │  stamp + beta markers│
                                 │ deploy: (unchanged)  │       Firebase RTDB (one project)
                                 │  deploy-pages@v4     │        ├── rooms/       ← prod + dev clients
                                 └──────────────────────┘        └── rooms-beta/  ← /beta/ clients

                                                                PostHog (one project)
                                                                 every consented event:
                                                                 deployment_channel = production | beta
```

Model rules:

- **Site content is a pure function of the two branch tips.** Every run
  resolves both tips once, tests both trees, and publishes both. A deploy
  triggered by either branch republishes the whole site — but an
  unchanged `main` reproduces a byte-identical production tree (only
  `release.json`'s `deployed_at`/`run` metadata fields refresh, §6.4).
- **`beta` is disposable**: create it to open a beta, force-push to
  iterate, delete it to close the slot (plus one `workflow_dispatch` —
  branch deletion doesn't trigger push workflows).
- **`main` is sacred**: never force-pushed; rollback is `git revert`.
- **Channel identity is derived from the URL**, in one pure function
  (§5.1). `release.json` is *metadata* about a deploy (SHA, timestamp,
  channel label for humans and dashboards) — it is **never** the channel
  identity: it is fetched async, can be absent (dev), and nothing
  behavioral may branch on it.
- **Environments**: the single auto-managed `github-pages` environment;
  the Deployments tab is the deploy history. A separate "beta"
  environment would be theater — both channels ship in one deployment by
  design.
- **Tags**: promoted release trains get `v0.x.y` tags (the existing
  series: `v0.1.0-couch`, `v0.2.0-h2h`, `v0.3.0` = `28d2b5b`). Tags are
  human history; `release.json` + the Deployments tab are the runtime
  audit trail. (EM P3-11 asked for exactly this.)

---

## 5. Isolation design

### 5.1 One pure channel function (`js/channel.js`)

New pure module, no DOM/network, unit-tested:

```js
// channel.js — which deployment channel is this page running in?
// The URL is the identity: an http(s) page whose path contains the
// /beta/ directory is the beta channel; everything else — including
// every file:// dev checkout, whatever its filesystem path contains —
// is production. Everything channel-dependent (Firebase namespace,
// PostHog deployment_channel) derives from this ONE function.
export function channelFromPath(pathname, protocol) {
  if (protocol !== "http:" && protocol !== "https:") return "production";
  return /\/beta\//.test(pathname + "/") ? "beta" : "production";
}

export function roomsRoot(pathname, protocol) {
  return channelFromPath(pathname, protocol) === "beta"
    ? "rooms-beta" : "rooms";
}
```

Call sites pass `location.pathname, location.protocol`. The `protocol`
parameter is the EM-mandated deviation from the original single-argument
sketch: without it, a dev checkout under a directory named `beta/`
(`file:///home/e/beta/geoparty/index.html`) would silently talk to
`rooms-beta/` (`engineering-manager-review-v0.3.md:215–218`). The guard
mirrors the existing precedent in `siteAddress()`
(`js/tvlink.js:37–39`). Still one function, still pure, still synchronous
and infallible — usable at Firebase-connection time, unlike the async
`release.json`.

Test matrix (§8.1): `/geoparty/` → production; `/geoparty/beta/` and
`/geoparty/beta/player.html` → beta; `/geoparty/beta` (no trailing
slash) → beta; `/geoparty/betamax.html` → production (the appended `/`
plus the `/beta/` directory match defeats prefix false-positives);
`file://` anything — including paths containing `/beta/` — → production;
`http://localhost/beta/index.html` → beta (serving an assembled artifact
locally behaves like beta, which is correct).

### 5.2 Firebase: hard namespace isolation

**Beta clients use `rooms-beta/$code`; production and every dev checkout
keep `rooms/$code`.** Integration point: `js/firebase.js:20–22` —
`roomRef()` takes its root from `roomsRoot(location.pathname,
location.protocol)`, computed once at module scope. That one line is the
entire client-side change: all room operations (read/write/update/delete/
subscribe/transaction/heartbeat) verifiably route through `roomRef()`
(§2), so there is no second place to miss.

Design consequences (retained from v1, all still valid):

- **Schema drift is structurally impossible** across channels — a beta
  that changes room-state shape can never feed a production phone. No
  version-negotiation protocol in either client.
- **Room-code collisions** are a non-issue: disjoint subtrees.
- **Cross-channel joins fail safe as room-not-found.** QR and share
  links always carry channel-correct URLs (§5.4), so the only cross-over
  is hand-typing a code from the other channel's TV into the wrong site.
  That lookup hits the other namespace, finds nothing, and lands in the
  existing "check the TV or the invite" not-found path — symmetric,
  no new UI, no crash mode.
- **Rules** mirror the existing `rooms` block verbatim as a `rooms-beta`
  sibling (§7). Same threat model, same deliberate permissiveness; the
  24 h expiry write rule ages beta rooms out identically. Bonus: future
  rule changes can be trialed on the `rooms-beta` block against real
  beta traffic before touching the production block.
- If the rules paste hasn't happened, beta writes are **rejected, not
  misrouted** — fails closed into the known fire-and-forget failure
  shape (host plays on, nobody can join). §7.4's sequencing exists to
  keep that window at zero.

### 5.3 PWA / manifest / no service worker (verified unchanged)

- The fully-relative manifest (§2) makes a `/beta/` install a **separate
  PWA** with its own `id` and scope, unable to navigate onto production
  pages in-app, with zero repo changes.
- So the two home-screen icons are distinguishable, the workflow's beta
  stamp rewrites the beta copy's manifest: `"name": "GeoParty Beta"`,
  `"short_name": "GeoParty β"`. CI-artifact-only; the repo manifest stays
  canonical. Unlike v1's `sed`, the stamp is a node script that
  **fails the build** if the expected manifest shape is gone (§6.5) —
  fail-loud beats v1's silent cosmetic degradation.
- **No service worker exists and none is added.** No cross-channel cache
  poisoning is possible; "did I get the new beta?" is answered by
  `release.json`, not a SW update dance. (If one is ever proposed,
  Pages' inability to set `Service-Worker-Allowed` hard-caps a
  `/beta/sw.js` to `/beta/` scope — but SWs remain out of scope and
  discouraged, §12.)

### 5.4 Paths, links, QR, OG, indexing (verified against code, §2)

- **Asset/import cross-loading: structurally impossible** — zero
  root-absolute URLs in the tree (grep, §2); every `/beta/` page resolves
  every asset, module import, and navigation under `/beta/`.
- **QR / TV / share links stay in-channel**: `screenLink(location.href,…)`
  (`host-ui.js:384`), `siteAddress()` yields
  `earino-assistant.github.io/geoparty/beta` on beta pages, `withUtm()`
  wraps page-derived hrefs, `joinHref` is relative. Beta share links land
  as `deployment_channel=beta` traffic and are excluded from KPIs (§5.5).
- **`release.json` self-selects**: the relative fetch in
  `consent.js:119` resolves per-channel with no code change.
- **OG/Twitter meta tags** in beta pages point at production absolute
  URLs — accepted as-is: read only by link scrapers, and production card
  art on an accidentally shared beta link is the correct face anyway.
- **Indexing**: Pages supports neither `X-Robots-Tag` nor an origin-root
  `robots.txt` we control (§2), so the workflow injects
  `<meta name="robots" content="noindex">` into each beta page's `<head>`
  (fail-loud, §6.5). Nothing links to `/beta/`; the URL is private-ish,
  not private — acceptable: no secrets, DB open-by-design, worst case a
  stranger plays the beta.
- **Replay masking checklist**: `/beta/` serves the *same pages* with the
  same `data-ph-mask` and `blockSelector` coverage — no new screens, no
  checklist change. (Any future beta-only screen goes through the normal
  `docs/replay-mask-checklist.md` rule.)

### 5.5 PostHog: same project, `deployment_channel` super property

**One PostHog project** (a second would split replay quota, double
dashboards/alerts, and drift — for an audience of one owner). The channel
rides as a post-consent super property. Three EM-identified traps are now
design requirements:

1. **Extend the allowlist.** `RELEASE_PROPS` (`js/analytics.js:419–422`)
   gains `deployment_channel: "string"`. Without this, `register()`
   silently strips the key and nothing is stamped
   (`engineering-manager-review-v0.3.md:219–222`). `BANNED_KEY_RE` does
   not match it (verified).
2. **Register synchronously, in both consent paths — never inside the
   `release.json` fetch.** Required outcome: `deployment_channel` (from
   `channelFromPath(location.pathname, location.protocol)`) must be in
   the analytics `registered` buffer **before the PostHog script finishes
   loading**, for (a) a returning accepted visitor (the
   `analytics.init()` path) and (b) a first-time accept (the banner's
   accept handler). The buffer mechanics at `js/analytics.js:522–530`
   then guarantee every queued `track()` event flushes *after* the super
   property is applied. Note `register()` is consent-gated
   (`analytics.js:604–605`) — a module-load-time call alone covers only
   returning visitors; the accept path needs its own synchronous call.
   The exact call placement in `consent.js` is Opus's, the ordering
   outcome and its tests (§8.1) are not negotiable.
3. **Channel registration is independent of `release.json`.** Dev
   checkouts (no `release.json`) register
   `deployment_channel: "production"` + `release: "dev"` — dev noise
   stays excluded by `release`, exactly as today.

Residual timing risk, stated honestly: PostHog-internal events fired
during `posthog.init()` itself (the session's first `$pageview`, with the
owner-provided `defaults: "2026-05-30"`) may be captured before any
`register()` call can land, because this codebase loads the bundle and
inits in one step (`consent.js:50–57`) and the init options are
owner-frozen (no `loaded` callback may be added). Worst case is ≤ 1
unstamped event per beta session, from the owner's own devices. B3
verifies empirically whether the first `$pageview` carries the property;
the backstop below covers it either way. All `EVENT_SCHEMA` events are
immune (they pass through the queue, which flushes after `register`).

**KPI filtering strategy (owner console work, B3):**

- Project setting **"Filter out internal and test users"**: add the
  condition `deployment_channel = beta`, plus the backstop
  `$current_url contains /beta/` (an OR group), and enable
  filter-by-default for new insights. `$current_url` is already captured
  today on every consented event — using it as a filter adds **no new
  capture surface**.
- **Every existing KPI insight/dashboard panel** (the catalog in
  `docs/analytics.md`) adds `deployment_channel does not equal beta` —
  events *without* the property (all history, plus production traffic)
  pass this filter, so no historical data is lost. Traffic/pageview-based
  insights add the `$current_url does not contain /beta/` backstop to
  cover the init-time `$pageview` residual.
- **Beta analysis** filters `deployment_channel = beta` (or
  `$current_url contains /beta/` for the residual): events, `$exception`
  issues, `$web_vitals`, and session replays are all super-property
  stamped, so beta remains fully queryable in the same project.
- Session replay for beta: **on, identical policy and masking** — beta
  replays are the point of the observability work; `deployment_channel`
  + `release` keep beta issues distinguishable. No config fork.

Privacy: the new super property is one of two fixed strings — an
aggregate by construction. Consent gating, masking, the diagnostic
one-shot, and the banner flow are untouched. Super properties ride
outside `EVENT_SCHEMA` by the same mechanism `release` already uses;
`docs/analytics.md:109–112` gains the `deployment_channel` row (B2). No
new event is added — a dedicated event would duplicate the super property
(justification per the repo instrumentation rule).

### 5.6 No secrets (unchanged)

The artifact contains only what the repo already publishes (embeddable
Mapillary/Firebase/PostHog client keys). The workflow needs no repository
secrets; `GITHUB_TOKEN` with the declared permissions covers everything.

---

## 6. Workflow: extending `.github/workflows/pages.yml`

**Invariant: this repo has exactly one Pages deploy workflow, and it is
`pages.yml`, edited in place.** Never author `deploy-pages.yml` or any
second workflow that touches Pages — two workflows sharing (or worse, not
sharing) the `pages` concurrency group is precisely the
last-finisher-wins `/beta/` flapping hazard the EM review flagged. §8.2
adds a static test for this invariant. `ci.yml` stays untouched as the PR
gate.

### 6.1 Triggers

```yaml
on:
  push:
    branches: [main, beta]
  workflow_dispatch:
    inputs:
      include_beta:
        description: "Include /beta/ from the beta branch"
        type: boolean
        default: true
```

- **Pull requests never deploy** — `ci.yml` (`pull_request` trigger)
  remains the only PR automation. `pages.yml` gets no `pull_request`
  trigger.
- **`workflow_dispatch`** is the manual lever: routine re-deploys, the
  post-branch-deletion re-publish, and the `include_beta: false`
  emergency hatch that ships a production-only artifact while `beta` is
  broken. The guard is `github.event_name != 'workflow_dispatch' ||
  inputs.include_beta`: on push events the `inputs` context is null, so
  it short-circuits to `true` and always includes beta when the branch
  exists; only a dispatch falls through to the boolean input. (The
  earlier `inputs.include_beta != false` was broken — on a push
  `inputs.include_beta` is null and, under GitHub's loose equality,
  `null == false`, so `!= false` was `false` and beta was silently
  cleared on every push.)

### 6.2 Concurrency — what happens when main and beta change together

Keep the shipped block verbatim (`pages.yml:25–27`):

```yaml
concurrency:
  group: pages
  cancel-in-progress: false
```

Semantics (GitHub-documented): at most one run of the group executes at a
time; an executing deploy is never cancelled; at most one further run
waits as *pending*, and a newer pending run supersedes (cancels) an older
pending one. Combined with §6.3's tip resolution this gives convergence:

- Push to `main` and push to `beta` seconds apart → run 1 executes
  (resolving *both* current tips at its start — possibly already
  including the second push), run 2 waits, then executes and resolves
  both tips again. **The final deploy always reflects both current branch
  tips**; intermediate states are at worst one-run stale, never mixed.
- A burst of N pushes collapses to at most the running deploy plus one
  pending run — no queue buildup, no lost final state.

### 6.3 Immutable SHA resolution and isolated dual checkouts

First build step, before any checkout:

```yaml
- name: Resolve branch tips (pinned for the rest of the run)
  id: refs
  env:
    INCLUDE_BETA: ${{ github.event_name != 'workflow_dispatch' || inputs.include_beta }}
  run: |
    heads=$(git ls-remote "https://github.com/${{ github.repository }}" \
              refs/heads/main refs/heads/beta)
    main_sha=$(printf '%s\n' "$heads" | awk '$2=="refs/heads/main"{print $1}')
    beta_sha=$(printf '%s\n' "$heads" | awk '$2=="refs/heads/beta"{print $1}')
    test -n "$main_sha"   # main must exist
    [ "$INCLUDE_BETA" = "true" ] || beta_sha=""
    echo "main=$main_sha" >> "$GITHUB_OUTPUT"
    echo "beta=$beta_sha" >> "$GITHUB_OUTPUT"
```

Then two checkouts into **isolated directories**, pinned to those SHAs —
`actions/checkout@v4` with `ref: <sha>` and `path: prod` /
`path: beta-tree`; the beta checkout is skipped when
`steps.refs.outputs.beta == ''`. Both `npm run check` + `npm test` runs
execute with `working-directory` set per tree (one `setup-node`, node 22,
zero deps — no install step, no cross-contamination possible between the
trees).

Why resolve-then-pin instead of `github.sha` / branch-name checkouts:

- One atomic `ls-remote` gives both tips at a single instant; checkout,
  tests, and the `release.json` stamps all use **the same SHA** — the
  stamp can never disagree with the deployed tree (no
  check-then-fetch race).
- Uniform across all three trigger shapes (push-main, push-beta,
  dispatch) — no per-trigger special-casing.
- Deterministic within a run, convergent across runs: any run deploys
  the branch-tip state as of its own start, so the latest run always
  wins with the latest state.

**Stated trade (EM asked for this,
`engineering-manager-review-v0.3.md:419–425`):** under the shipped
workflow, *re-running an old green run* redeployed that old `github.sha`
— an undocumented-but-real fast rollback path. Under tip resolution, a
re-run redeploys **current** tips, so that path is gone. Production
rollback is the documented branch operation (`git revert` + push,
~2 min workflow + ≤10 min CDN) — one rollback story, no hidden second
one.

### 6.4 What deploys when

| Event | Root (`/geoparty/`) | `/geoparty/beta/` |
|---|---|---|
| Push to `main` | new `main` tip | current `beta` tip, republished |
| Push to `beta` | current `main` tip, **byte-identical** app tree (only `release.json`'s `deployed_at`/`run` refresh — the `release` super property is the SHA, so production attribution is unaffected) | new `beta` tip |
| Both change near-simultaneously | converges to both tips (§6.2) | converges |
| Dispatch, `include_beta: false` | `main` tip | **absent** → 404 |
| `beta` branch does not exist | `main` tip | absent → 404 |
| `beta` branch deleted | unchanged until the next run — deletion triggers nothing; run one dispatch to publish the beta-less artifact | then 404 |

**Bootstrapping:** the extended workflow merges to `main` *before* any
`beta` branch exists. Its first run resolves `beta_sha=""`, skips every
beta step, and publishes an artifact identical to today's plus
`channel`/`ref` fields in `release.json` — production provably unaffected
before beta ever exists (B0 acceptance, §9).

### 6.5 Assembly and per-channel release stamping

- `rsync -a --exclude .git --exclude .github prod/ _site/`, and (when
  beta exists) `… beta-tree/ _site/beta/`. Same exclusions as the
  artifact ships today (the shipped workflow uploads the repo root;
  `docs/`, `tests/`, `tools/` are already public content — parity kept).
  The artifact upload switches from `path: .` to `path: _site`.
- **Release stamps** extend the shipped `node -e` stamp
  (`pages.yml:52–65`), one per channel, each from its **own pinned SHA**:

  - `_site/release.json`:
    `{commit: <main sha>, short, deployed_at, run, env: "pages", channel: "production", ref: "main"}`
  - `_site/beta/release.json`: same shape with the beta SHA,
    `channel: "beta"`, `ref: "beta"`.

  Existing keys are preserved (`consent.js` reads only
  `short`/`commit`/`deployed_at` — verified, so the two new keys are
  additive metadata). `channel` in the file is a human/dashboard
  cross-check; runtime identity remains `channelFromPath` (§4).
- **Beta markers, fail-loud** (replacing v1's silent-degrade `sed`): a
  node script that (a) parses `_site/beta/manifest.webmanifest`, asserts
  `name === "GeoParty"`, rewrites `name`/`short_name` to the Beta
  variants; (b) inserts `<meta name="robots" content="noindex" />` into
  each top-level `_site/beta/*.html` `<head>`, asserting the insertion
  anchor exists in every file. Any assertion failure **fails the build**
  (nothing deploys, previous site keeps serving) — drift is surfaced at
  the moment it happens instead of shipping a cosmetic no-op.
- The `deploy` job stays exactly as shipped (`pages.yml:73–82`):
  `configure-pages@v5` in build, `upload-pages-artifact@v3`,
  `deploy-pages@v4`, `github-pages` environment, least-privilege
  permissions. **One artifact, one deploy step, per run.**

### 6.6 The workflow-file-per-ref subtlety

GitHub runs the workflow file **from the pushed ref**. Two consequences:

- A `beta` branch cut from a pre-B0 commit contains the old
  main-only `pages.yml` — pushing it triggers **nothing** (its `on:` has
  no `beta`), and `/beta/` silently never appears. Rule: **beta
  candidates must contain B0's workflow** — in practice, always branch
  candidates from current `main` (the normal flow) or rebase onto it.
- A candidate that *modifies* `pages.yml` will run its modified version
  on push-to-beta. Workflow edits therefore go through the same
  Fable-review + owner-approval gate as any change *before* being pushed
  to `beta` (§10) — which is already the project's process for every
  change.

### 6.7 Promotion and rollback (mechanics; policy in §10)

**Promote** the exact verified SHA — fast-forward only:

```sh
git fetch origin
git push origin origin/beta:main   # plain push: git itself rejects non-fast-forward
git tag v0.x.y origin/beta && git push origin v0.x.y   # meaningful trains
```

If rejected (`main` moved while verifying): rebase the candidate onto
`main`, force-push `beta`, **re-verify on the beta URL**, retry. Never
`push -f` to `main`. The promotion push triggers the workflow; production
then serves the verified tree byte-for-byte (only stamps differ — there
is no build to diverge).

**Roll back:**

```sh
# beta — anything goes; it's the disposable slot:
git push -f origin <any-sha>:refs/heads/beta

# production — history-preserving, the only path:
git revert <bad-sha..range> && git push origin main

# emergency: ship production alone while beta is broken:
gh workflow run pages.yml -f include_beta=false
# or delete the slot: git push origin :beta && gh workflow run pages.yml
```

Live in ~2 min workflow + ≤10 min CDN; always confirm via `release.json`
(`cache: no-store` / `curl`), never by eyeballing UI through a
possibly-stale cache.

---

## 7. Firebase rules and the owner walkthrough

### 7.1 The rules change

One change: the `rooms-beta` sibling, **byte-identical** to the existing
`rooms` block except the key. Full replacement ruleset (this exact text
also lands in `README.md`'s rules section in B1 as the canonical copy):

```json
{
  "rules": {
    ".read": false,
    ".write": false,
    "rooms": {
      "$roomCode": {
        ".read": true,
        ".write": "!data.exists() || data.child('createdAt').val() > (now - 86400000) || newData.val() == null",
        ".validate": "$roomCode.matches(/^[A-HJ-NP-Z]{6}$/)",
        "createdAt": { ".validate": "newData.isNumber() && newData.val() <= now + 300000" }
      }
    },
    "rooms-beta": {
      "$roomCode": {
        ".read": true,
        ".write": "!data.exists() || data.child('createdAt').val() > (now - 86400000) || newData.val() == null",
        ".validate": "$roomCode.matches(/^[A-HJ-NP-Z]{6}$/)",
        "createdAt": { ".validate": "newData.isNumber() && newData.val() <= now + 300000" }
      }
    }
  }
}
```

Why this is safe for production: the `rooms` block is unchanged
byte-for-byte; the top-level defaults still deny everything else; and
`rooms-beta` was **already fully denied** before this change (top-level
`false` defaults), so the edit only *adds* an allowlisted subtree that no
shipped client touches until B3. Publishing it early is inert.

Why channel mismatch is safe (§5.2 recap): a production client can only
ever address `rooms/…`, a beta client only `rooms-beta/…` — a code from
the other channel reads an empty path and lands in the existing
room-not-found flow. The rules make even a buggy cross-write fail:
each subtree validates independently.

### 7.2 Owner walkthrough — publishing (Eduardo, ~5 minutes)

No secrets involved anywhere in this flow; the database URL is the public
client identifier from `config.js`.

1. **Back up**: open the Firebase console → project `geoparty-9ffe7` →
   *Realtime Database* → *Rules*. Select the entire current rules text and
   save it into a local file (e.g. `rules-backup-2026-08-XX.json`). This
   file is the rollback.
2. **Sanity-check the backup** matches `README.md:144–158` (it should be
   exactly the published block there). If it differs, stop and report the
   diff before proceeding — the live rules would be drifted from the
   documented ones.
3. **Replace**: paste the §7.1 ruleset over the editor contents,
   replacing everything.
4. **Publish**: the console refuses syntactically invalid rules at
   publish time; on any error, do not publish — restore the backup text
   and report.

### 7.3 Owner walkthrough — validation (console-independent)

Validate from any shell via the RTDB REST API, which enforces the same
rules as the SDK. Expected results, in order (use a code like `ZZZZZZ` —
letters must avoid `I`/`O` per the allowed alphabet):

```sh
DB=https://geoparty-9ffe7-default-rtdb.europe-west1.firebasedatabase.app

# 1. Valid 6-letter beta room: ACCEPTED (HTTP 200, echoes the JSON)
curl -sw '\n%{http_code}\n' -X PUT -d "{\"createdAt\":$(date +%s000)}" \
  "$DB/rooms-beta/ZZZZZZ.json"

# 2. 4-letter code: REJECTED by the .validate regex
#    (HTTP 401, body contains "Permission denied")
curl -sw '\n%{http_code}\n' -X PUT -d "{\"createdAt\":$(date +%s000)}" \
  "$DB/rooms-beta/ZZZZ.json"

# 3. Read the beta room back: HTTP 200 with the createdAt payload
curl -sw '\n%{http_code}\n' "$DB/rooms-beta/ZZZZZZ.json"

# 4. Clean up (delete is allowed by design): HTTP 200
curl -sw '\n%{http_code}\n' -X DELETE "$DB/rooms-beta/ZZZZZZ.json"

# 5. Production regression check — 4-letter still rejected under rooms/:
curl -sw '\n%{http_code}\n' -X PUT -d "{\"createdAt\":$(date +%s000)}" \
  "$DB/rooms/ZZZZ.json"
```

Pass = 200 / denied / 200 / 200 / denied, in that order. Any deviation:
roll back (§7.4) and report which step diverged.

**Rollback**: paste the backup file's contents into the Rules editor and
publish. That single action restores the exact pre-change state;
production clients are unaffected throughout (their subtree never
changed).

### 7.4 Sequencing

Publish order is: **rules before beta exists**.

1. B1 merges (canonical rules text lands in `README.md`; no shipped page
   can reach `rooms-beta` yet, because `/beta/` isn't served).
2. Owner publishes + validates the rules (§7.2–7.3). Inert for
   production; nothing consumes `rooms-beta` yet.
3. Only then is the `beta` branch first created (B3), making `/beta/`
   live with its namespace already writable.

This ordering makes the "beta is live but every room-create is silently
rejected" window — the plan's known-broken interval — structurally
impossible, instead of merely unlikely. The inverse order (beta live
first) is prohibited.

---

## 8. Test and verification matrix

### 8.1 Unit tests (Node runner, `npm test` — all local)

- **`tests/channel.test.js`** (new): the full §5.1 matrix — beta paths
  with and without trailing slash and page names, the `betamax`
  false-positive, `file://` paths *including ones containing `/beta/`*,
  localhost-http beta. Plus: `roomsRoot` returns only values in
  `{"rooms", "rooms-beta"}` (the rules allowlist — a table test keeps a
  future third value from silently escaping the rules).
- **`tests/analytics.test.js`** (extended):
  - `RELEASE_PROPS` contains `deployment_channel: "string"`, and
    `register({deployment_channel: "beta"})` survives sanitization
    (i.e. is not stripped by allowlist or `BANNED_KEY_RE`).
  - Ordering: with a fake `loadPosthog`, events `track()`ed *before* the
    script "loads" flush **after** the registered super properties are
    applied — for both the returning-visitor and fresh-accept flows —
    so no schema event can ever be channel-unstamped.
  - `register` stays consent-gated (no consent → `false`, nothing
    buffered to a live client).
  - Dev path: channel registration works with `release.json` absent
    (`release: "dev"` + `deployment_channel: "production"` coexist).
- **Firebase namespace**: `js/firebase.js` itself imports the CDN SDK and
  is not unit-loadable (unchanged constraint); isolation is carried by
  the pure `roomsRoot` tests above plus the single-choke-point property —
  §8.2 adds a static guard that `rooms/` appears in no other `js/`
  module, so `roomRef()` remains the only namespace decision site.

### 8.2 Static / workflow checks (local, in `npm test`)

New `tests/deploy-workflow.test.js` reading the YAML as text (no YAML
dependency needed — the repo has zero deps and keeps it that way):

- Exactly **one** file under `.github/workflows/` references
  `deploy-pages` / `upload-pages-artifact` — the single-deploy-workflow
  invariant (the anti-dueling guard).
- `pages.yml` triggers on `main` **and** `beta` pushes plus
  `workflow_dispatch`, and has **no** `pull_request` trigger.
- Concurrency block present: `group: pages`,
  `cancel-in-progress: false`.
- The build resolves both refs (`ls-remote` + both `refs/heads/`
  entries), runs check+test with **two distinct working directories**,
  stamps **two** `release.json` paths with `channel` fields, and guards
  every beta step on the branch-exists output (the
  no-beta-until-branch-exists bootstrap property).
- `ci.yml` contains no Pages/deploy references.
- Cross-module guard: `rooms/` as a database path string appears only in
  `js/firebase.js` (and `rooms-beta` only via `roomsRoot`).

These are deliberately string-level assertions: cheap, dependency-free,
and they pin exactly the properties this plan declares invariant.

### 8.3 Manual beta acceptance (B3, owner on real hardware)

1. `curl …/geoparty/beta/release.json` → `short` = pushed beta SHA,
   `channel: "beta"`; root `release.json` still shows the `main` SHA.
2. Direct `/geoparty/beta/` URL loads on a phone; view-source shows the
   `noindex` meta; no console errors.
3. Phone A hosts a couch game on `/beta/` → **room appears under
   `rooms-beta/` in the Firebase data view** (first-ever beta only:
   proves rules + namespace end-to-end).
4. Phone B scans the lobby QR → lands on a `/beta/` URL, joins, plays a
   round. TV path: typeable address reads
   `earino-assistant.github.io/geoparty/beta`; screen attaches.
5. Production spot-check in parallel: `/geoparty/` hosts a room → lands
   under `rooms/`; both games are mutually invisible.
6. Consent-accept on a beta device → PostHog Activity shows events with
   `deployment_channel=beta` and `release` = beta SHA. Check whether the
   session's first `$pageview` carries the property (the §5.5 residual);
   record the answer in `docs/analytics.md`.
7. PWA: install from `/beta/` → separate "GeoParty Beta" icon; both
   installs coexist and open their own channel.
8. Promotion drill: fast-forward push → root `release.json` shows the
   promoted SHA; site behavior verified.
9. Rollback drill (once): `git revert` a trivial doc commit on `main`,
   push, confirm redeploy; force-push `beta` back a commit, confirm
   `/beta/` follows.

### 8.4 What is provable where (explicit split)

**Locally verifiable before any deploy** (all green required to merge):
every §8.1 unit test, every §8.2 static check, `npm run check`, plus
`node --check` on the workflow's inline node scripts if extracted for
testing. **Only provable by the first production Actions run + a
browser**: that Pages accepts and serves the assembled artifact, real
concurrency behavior, CDN timing, the Firebase rules as published (§7.3
REST checks), PostHog console filtering, PWA install identity, and the
`$pageview` timing question. B0/B3 acceptance criteria (§9) are written
around exactly this split — nothing live-only is claimed verified until
the corresponding checklist item runs.

---

## 9. Implementation phases

Ground rules: repo policy applies to every phase (pure logic in pure
modules with tests; `npm test` + `npm run check` green; analytics
schema/docs updated together; consent gate untouched). **This plan is
subject to owner review; no phase starts before Eduardo's explicit
approval, and Opus 4.8 (pinned) implements — one repo agent at a time.**

**B0 — extend the deploy workflow.**
Scope: `pages.yml` edits per §6 (triggers, resolve step, dual checkout /
dual checks, assembly, per-channel stamps, fail-loud beta markers);
`tests/deploy-workflow.test.js` (§8.2, the workflow-shape half).
Order: first — everything else is inert without it, and its no-beta
bootstrap path (§6.4) means it can merge alone safely.
Acceptance: static tests green locally; then the first live run —
`/geoparty/` byte-identical in behavior, root `release.json` gains
`channel: "production"`/`ref: "main"`, `/geoparty/beta/` 404s, Deployments
tab shows one deploy.
Rollback: `git revert` the workflow commit → shipped `pages.yml` behavior
returns on the next push.

**B1 — channel module + Firebase namespace + rules text.**
Scope: `js/channel.js` (§5.1); `js/firebase.js` root from `roomsRoot`
(§5.2); canonical §7.1 ruleset into `README.md`; `tests/channel.test.js`
and the `rooms/`-choke-point static guard.
Order: after B0 (any order relative to B2; both before B3). Inert in
production: with no `/beta/` served, every client resolves
`production`/`rooms/`.
Acceptance: unit tests green; a dev checkout (`file://`) and the live
production site both still use `rooms/` (spot-check one room).
Instrumentation: none — no new decision point; the channel rides on every
event via B2 (a dedicated event would duplicate the super property).
Rollback: `git revert`.

**B2 — PostHog channel stamping.**
Scope: `RELEASE_PROPS` + `deployment_channel` (§5.5 item 1);
synchronous registration in both consent paths (§5.5 item 2);
`docs/analytics.md` super-property row; §8.1 analytics tests.
Order: after B1 (imports `channelFromPath`).
Acceptance: tests green; on production, consented events carry
`deployment_channel: "production"` (visible in PostHog Activity) — no
behavior change otherwise.
Rollback: `git revert`.

**B3 — owner manual steps + first live beta (Eduardo, with the agent
on standby for verification).**
Scope, strictly ordered: (1) publish + validate Firebase rules
(§7.2–7.3); (2) PostHog console: internal-users filter + KPI insight
filters (§5.5); (3) create the `beta` branch from current `main`
(`git push origin main:refs/heads/beta`) — the first candidate; (4) run
the full §8.3 acceptance checklist, including the promotion and rollback
drills; (5) record the `$pageview` timing finding.
Dependencies: B0+B1+B2 all merged and live on production first.
Acceptance: every §8.3 item passes.
Rollback: delete the `beta` branch + one dispatch (site returns to
production-only); re-paste the rules backup (§7.3); PostHog filter
changes are additive and reversible in the console.

Out of scope, explicitly: the v1 plan's "BETA corner badge" polish is
dropped from the phase list (it was optional there too); it may return as
a separately approved change. `deploy-pages` version bumps likewise (§0).

---

## 10. Operational policy

- **Roles (project policy, restated as binding):** Fable plans and
  reviews; pinned Opus 4.8 implements; exactly one repo agent works at a
  time, sequentially. **Nothing is pushed, merged, promoted, or
  force-pushed without Eduardo's explicit approval** — including every
  `beta` force-push and every promotion.
- **Branch lifecycle:** `beta` exists only while a candidate is under
  verification. Created from (or rebased onto) current `main` — never
  from a pre-B0 commit (§6.6). Force-pushing `beta` is normal and
  expected (it is the disposable slot); deleting it closes the slot
  (+ one dispatch). `main` is never force-pushed, ever.
- **Default flow for every future code change:** Opus implements on a
  feature branch → Fable review → Eduardo approves → the branch is pushed
  to `beta` (force-push over whatever was there) → Eduardo verifies on
  the live `/beta/` URL per §8.3's relevant subset → Eduardo approves
  promotion → fast-forward push of the **verified SHA** to `main`.
  Changes only skip the beta step when Eduardo explicitly says so
  (e.g. doc-only commits).
- **PR relationship:** PRs against `main` remain the review/discussion
  vehicle (as PR #1 was). The *merge* mechanics change: promotion is the
  fast-forward push of the verified beta SHA — GitHub then marks any open
  PR whose head is that SHA as merged automatically. Merge-commit and
  squash merges are **not** used for promotions: both would create a SHA
  on `main` that was never the SHA verified on `/beta/`.
- **Release tags:** meaningful promoted trains get `v0.x.y` on the
  promoted SHA (continuing `v0.1.0-couch`, `v0.2.0-h2h`,
  `v0.3.0` = `28d2b5b`; EM P3-11). Tags are pushed only with the
  promotion, by the same approval.
- **Workflow-file changes** ride the same flow — with the §6.6 caveat
  that they take effect on `beta` pushes immediately, so they get review
  *before* reaching the `beta` branch, like everything else.

---

## 11. Day-to-day runbook (owner quick reference)

**Open / update the beta** (after approval):

```sh
git push -f origin <candidate-sha>:refs/heads/beta
# workflow ~1–2 min, then ≤10 min CDN
curl -s https://earino-assistant.github.io/geoparty/beta/release.json
# → "short" must equal the pushed SHA, "channel":"beta"
```

**Verify:** §8.3 checklist (or its relevant subset for small changes).

**Promote / tag / close the slot / roll back:** §6.7 command cards.

**Broken beta blocking a prod hotfix:**

```sh
gh workflow run pages.yml -f include_beta=false   # ship prod alone
# or: git push origin :beta && gh workflow run pages.yml
```

---

## 12. Risks, failure modes, and what NOT to build

- **Red `beta` blocks all deploys** (both trees must be green).
  Accepted for predictability; the unblock is a documented one-liner
  (§11). This is the same trade the shipped workflow already makes for
  `main`.
- **Forgotten rules paste** → beta writes silently rejected (host plays,
  nobody joins). Designed out by §7.4's rules-before-beta-exists
  ordering plus §8.3 item 3.
- **Stale CDN confusion** → `release.json` is always the first verify
  step, never UI eyeballing.
- **First-`$pageview` channel gap** (§5.5 residual) → bounded to ≤1
  owner-device event per beta session; `$current_url` backstop filter;
  empirically resolved in B3.
- **Beta marker drift** (manifest/HTML shape changes) → fail-loud build
  error at the moment of drift (§6.5), not a silent no-op.
- **Non-ff promotion race** → plain push is rejected by git; rebase,
  re-push beta, **re-verify**, retry. Never `-f` to `main`.
- **Old workflow file on the beta branch** → beta push deploys nothing
  (§6.6); rule: candidates branch from current `main`.
- **Rules edits affect a shared DB** → the two blocks are independent
  siblings; trial rule changes on `rooms-beta` first (§5.2); rollback is
  the backup re-paste (§7.3).
- **Lost re-run-rollback path** → deliberate (§6.3); the one documented
  rollback is `git revert`.

What NOT to build (retained; nobody re-litigates without new facts):

- No second Pages deploy workflow — **ever** (the P2-2 hazard).
- No PR previews / multiple candidates — one `beta` slot, period.
- No second Firebase or PostHog project, no separate PostHog key.
- No service worker, for either channel — no-SW is load-bearing for
  cache safety.
- No third-party deploy actions, no `gh-pages` branch, no external
  preview host, no second repo.
- No room-schema version negotiation — the namespace split makes it dead
  code.
- No committed version/beta files, no beta config forks in JS — the URL
  is the channel; stamps live only in the CI artifact.
- No robots.txt/custom-domain machinery — the per-page `noindex` meta is
  the ceiling of what Pages supports and is proportionate.

---

## 13. Owner checklist (one-time + per-beta)

One-time, strictly in order:

- [ ] Approve this amended plan (gates all phases).
- [ ] B0 merged → confirm root `release.json` gains
      `channel: "production"` and the site is unchanged; `/beta/` 404s.
- [ ] B1 + B2 merged → production spot-checks per §9.
- [ ] Publish + validate Firebase rules (§7.2–7.3) — **before any beta
      branch exists**.
- [ ] PostHog: internal/test-users filter + KPI insight filters (§5.5).
- [ ] Create `beta` from current `main`; run the §8.3 checklist once in
      full (including promote + rollback drills).

Per-beta cycle:

- [ ] Approve the candidate → `git push -f origin <sha>:refs/heads/beta`.
- [ ] `curl …/beta/release.json` — SHA matches.
- [ ] Verify on devices (§8.3 subset appropriate to the change).
- [ ] Approve promotion → `git push origin origin/beta:main`
      (+ `v0.x.y` tag for meaningful trains).
- [ ] Confirm root `release.json` shows the promoted SHA.
- [ ] Optionally close the slot: `git push origin :beta` + one dispatch.

Rollback cards: §6.7 (git), §7.3 (rules re-paste).

---

## 14. Implementation notes (B0–B2, Opus 4.8 — built candidate, local only)

B0–B2 were implemented exactly to this spec as one local candidate (no beta
branch, no push, no rules published, no PostHog console change — those remain
the B3 owner steps). Files: `.github/workflows/pages.yml` (extended in place),
`js/channel.js` (new), `js/firebase.js`, `js/analytics.js`, `js/consent.js`,
`README.md`, `docs/analytics.md`, `docs/architecture.md`, and tests
`tests/channel.test.js`, `tests/deploy-workflow.test.js`,
`tests/analytics.test.js`. `npm test` (all green) and `npm run check` pass.

One honest realization detail, not a design change:

- **Namespace literals live in `js/channel.js`, not `js/firebase.js`.** §5.2
  mandates `roomRef()` take its root from `roomsRoot(...)`; the two legal root
  strings (`rooms`, `rooms-beta`) therefore live in one frozen `ROOMS_ROOTS`
  map in `channel.js`, and `firebase.js` composes `` `${ROOMS_ROOT}/${code}` ``
  from it. So the literal `rooms/` DB *path* string no longer appears in
  `firebase.js` (or anywhere) — it is *built* at the single choke point.
  §8.2's cross-module guard is implemented as the equivalent, slightly
  stronger set: the `rooms-beta` namespace literal appears only in
  `channel.js`; no module contains a hardcoded `rooms/`-shaped DB path
  literal; and `roomsRoot()` is called from exactly one module
  (`firebase.js`). Same invariant — `roomRef()` is the only namespace
  decision site — enforced without a raw path literal to drift.

Everything else (workflow triggers/resolve/dual-tree/assembly/stamps/fail-loud
markers, the `channelFromPath(pathname, protocol)` signature, the
`deployment_channel` allowlist + synchronous dual-path registration, the
`deploy-pages@v4` pin, `path: _site` upload) matches the spec verbatim.
Runtime-only proofs (Pages serving the artifact, real concurrency, CDN timing,
published rules, console filtering, `$pageview` timing) remain B3 per §8.4.
