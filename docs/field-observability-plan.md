# Field observability plan — imagery & viewer debugging in the wild

**Status: IMPLEMENTED (2026-08-20).** P0–P2 are in the tree; see the
implementation note at the end of this document for the delta between plan
and code, and `docs/failure-injection.md` for the verification results.

> **Revision 2026-08-20 — learning mode.** Owner decision: the original
> failure-triggered-only replay posture was too cautious for a product
> with almost no users and a 5,000-free-replays/month allowance. Replay
> now follows a **staged policy** (§9): a time-boxed **learning mode**
> records 100% of explicitly-consented sessions to establish what healthy
> looks like, then steps down to sampled healthy sessions plus guaranteed
> recording of degraded/failed sessions. No privacy requirement is
> weakened — recording remains strictly behind explicit analytics
> consent, with every masking rule (§9.4) intact.

The three field complaints this system must make diagnosable:

1. "Images fail to load" — the pano never appears, or rounds burn through
   pool entries.
2. "Imagery is slow" — the pano appears, seconds too late.
3. "Pan / zoom / movement doesn't work" — the viewer renders but doesn't
   respond, or navigation to neighbors fails.

Today all three degrade gracefully and *silently*: every `viewer.moveTo`
rejection is caught, `console.warn`ed, and skipped (see the call-site
inventory in §6). Users see a working game; we see nothing. This plan makes
failures visible **without adding a vendor** (PostHog error tracking +
session replay, both inside current free tiers) and **without weakening a
single privacy invariant** (everything stays behind explicit consent; the
only exception is a user-initiated one-time diagnostic report, §10.4).

---

## 1. Goals, non-goals, constraints

**Goals**

- Every imagery/viewer failure that today dies in a `catch` becomes a
  classified, release-stamped PostHog exception or event.
- Session replay establishes what *normal* looks like before failures
  need explaining: a time-boxed learning mode records 100% of consented
  sessions; after a baseline exists, healthy sessions are sampled and
  every degraded/failed session is still recorded — always with
  synchronized console output and a network waterfall
  (timing/status/path only). Staged policy in §9.
- A "Report it" affordance turns a frustrated user into a diagnostic
  bundle with a support reference code — including users who declined
  analytics, via explicit one-time consent.
- A reliability dashboard answers "is imagery healthy, for whom, since
  which release, on which pool entries" at a glance, with alerts.
- A polite weekly GitHub Action turns field failures into pool-quarantine
  proposals, closing the loop on dead imagery.

**Non-goals**

- No Sentry now (§17 defines when that changes). Single vendor: PostHog.
- No server-side code, no build step, no npm dependencies (repo law).
- No *permanent* 100% recording — learning mode (§9.2) is explicitly
  time-boxed; the steady state samples healthy sessions and guarantees
  recording only for degraded/failed ones. And no recording of any kind,
  in any stage, without explicit analytics consent.
- No weakening of the schema-allowlist / consent-gate architecture.
  Observability *extends* `js/analytics.js`; it never bypasses it.

**Cost envelope** (PostHog free tier, current): 1M events/mo, 100k
exceptions/mo, 5k replays/mo. Budget math in §9.5 shows even 100%
learning-mode recording at current traffic consuming well under 10% of
the 5k replay allowance; a 50%-of-allowance warning threshold prompts a
sampling review (not billing), and client-side caps (§7.4) make runaway
loops unable to blow the exception budget.

---

## 2. Architecture and data flow

```
                    ┌──────────────────────────────────────────────┐
                    │ page (host / player / screen / daily / index) │
                    └──────────────────────────────────────────────┘
                        │ creates viewers via
                        ▼
  js/viewer-ui.js  — instrumented Mapillary wrapper (browser glue, thin)
        │   createViewer(surface) / iv.moveTo(id, purpose) / loadRoundImage()
        │   listens: image, navigable, webglcontextlost; times with
        │   performance.now(); classifies via ↓
        ▼
  js/imagery.js    — PURE module (unit-tested, no DOM/network):
        │   error classifier (§5), pool diag-id hash (§8), message scrubber,
        │   ref-code maker, timeout policy, pano-session fold, report bundle
        ▼
  js/analytics.js  — extended, same discipline as today:
        │   EVENT_SCHEMA gains imagery events (§7.1–7.3, hard allowlist)
        │   NEW: EXCEPTION_PROPS allowlist + trackError(error, props)
        │        → posthog.captureException, consent-gated identically
        ▼
  js/consent.js    — unchanged gate + NEW one-time diagnostic path (§10.4)
        ▼
  PostHog EU  ── issues (error tracking) ── replays (console+network)
              ── events (dashboard §12) ── web vitals
        ▲
  release.json  — deploy-stamped by the Pages workflow (§11), registered
                  as super properties (release / commit / deployed_at)

  GitHub Actions (weekly) ── tools/pool_health.mjs ── Mapillary Graph API
                          └─ PR proposing data/pool_quarantine.json (§13)
```

Flow for a field failure: `moveTo` rejects → wrapper classifies →
`track("imagery_load", {ok:false, error_class, …})` + `trackError(...)` →
PostHog groups it as an issue → the session's replay is available per the
staged policy (§9: 100% of consented sessions in learning mode; in later
stages the `$exception` trigger and client-side override guarantee the
failing session recorded, §9.3) → issue links replay with console warns
and the Mapillary network waterfall → dashboard panel moves → (if chronic
on one entry) weekly health check confirms → quarantine PR.

Flow for a *healthy* session (learning mode's whole point): consented
session records from the start → the health classifier (§9.1) marks it
healthy → it feeds the baseline panels (§12.1) — P50/P95 load times, skip
rates, navigation use — so failure numbers have a "normal" to be compared
against.

Everything below `consent.js` in that diagram fires **only after consent**
(analytics consent, or the one-shot diagnostic consent). No new scripts,
no new vendors, no capture-before-opt-in — the existing `track()` gate is
reused verbatim, and `trackError` sits behind the same gate.

---

## 3. Consent model (unchanged core + one addition)

| State | Product events | Exceptions | Replay | Report flow |
|---|---|---|---|---|
| Accepted | yes (today) | yes (new) | yes (new) — staged: 100% in learning mode, then sampled healthy + guaranteed failures (§9.2) | full |
| Declined | no | no | **no — never, in any stage** | one-time consent ask (§10.4) |
| Not chosen yet | no | no | **no — never, in any stage** | one-time consent ask (§10.4) |

Because replay now records *healthy* consented sessions too (not only
failing ones), the consent banner copy and PRIVACY.md must clearly
disclose session replay and technical telemetry **before** recording
turns on — this is a P1 ship-blocker (§14), not a follow-up. The
one-time diagnostic path never records a replay in any stage (§10.4).

The one-time diagnostic path is user-initiated (a tap on "Report it"),
explicitly consented in its own dialog, sends exactly one report bundle
through a memory-persistence PostHog init, and leaves no cookies/storage
and no change to the stored consent flag. Details in §10.4. PRIVACY.md
gains a section describing it (P0 task; not edited now).

---

## 4. Exact PostHog changes (init options + project settings)

### 4.1 `POSTHOG_INIT_OPTIONS` (js/analytics.js) — additions

The current object stays; these keys are added (owner sign-off required,
since CLAUDE.md marks init values owner-provided):

```js
export const POSTHOG_INIT_OPTIONS = {
  api_host: "https://eu.i.posthog.com",
  defaults: "2026-05-30",
  person_profiles: "identified_only",
  autocapture: { element_allowlist: ["button", "a"] },

  // NEW — error tracking (window.onerror + unhandledrejection → issues)
  capture_exceptions: {
    capture_unhandled_errors: true,
    capture_unhandled_rejections: true,
    capture_console_errors: false,   // our console.warn/error stay out of
  },                                 // the issue stream (replay captures
                                     // them in context instead)

  // NEW — Web Vitals autocapture ($web_vitals: LCP/CLS/INP/FCP)
  capture_performance: { web_vitals: true },

  // NEW — session replay behavior (retention follows the staged
  // policy in §9.2; masking below applies identically in every stage)
  session_recording: {
    maskAllInputs: true,
    maskTextSelector: "[data-ph-mask]",   // team names, room codes (§9.4)
    captureCanvas: false,                 // WebGL pano NOT recorded (§9.4)
    recordHeaders: false,
    recordBody: false,
    maskCapturedNetworkRequestFn: (req) => {
      // timing/status/path only: strip query strings (tokens ride in
      // Mapillary query params!) and drop any non-allowlisted host.
      req.name = req.name.split("?")[0];
      return req;
    },
  },
  enable_recording_console_log: true,     // console synced into replays

  // NEW — belt-and-braces URL hygiene on every event (release-stamped
  // events, exceptions, pageviews): query strings never leave the device.
  before_send: sanitizeBeforeSend,        // pure helper in analytics.js
};
```

`sanitizeBeforeSend(event)` (pure, unit-tested): for every property in
`$current_url`, `$pathname`, `$referrer`, `$referring_domain`, and inside
`$exception_list` frames/values — strip `?query` and `#fragment`, and
replace runs of ≥10 digits with `<id>` (Mapillary image ids are long digit
strings that reverse to places; see §8). Returns the event (never null —
dropping stays the schema's job).

Note: `capture_exceptions` and replay triggers require a current
posthog-js; `array.js` is evergreen (unversioned, consent-gated by
design), so no pinning change is needed. The implementation must verify
the option names against the posthog-js docs current at build time — the
shapes above are the current documented API.

### 4.2 PostHog project settings (dashboard-side, owner clicks these)

| Setting | Value | Why |
|---|---|---|
| Error tracking → Exception autocapture | **ON** | groups `$exception` into issues |
| Session replay → Record user sessions | **ON** | master switch |
| Session replay → Sampling | **stage-dependent (§9.2): 100% (Stage 1) → 15% (Stage 2) → 1–5% (Stage 3)** | healthy-session retention; stage transitions are a project-settings click, no deploy |
| Session replay → Event trigger | `$exception`, `imagery_report` | belt-and-braces guarantee that failing sessions record in *every* stage (§9.3) — redundant at 100% sampling, load-bearing from Stage 2 |
| Session replay → Minimum duration | 2000 ms | drop empty blips |
| Session replay → Capture console logs | **ON** | synced warns/errors |
| Session replay → Capture network performance | **ON** | waterfall (timing/status/path) |
| Session replay → Record canvas | **OFF** | pano pixels stay out (§9.4) |
| Web analytics → Discard client IP | **ON** (verify) | PRIVACY.md already promises it |
| Autocapture → Web vitals | **ON** | pairs with `capture_performance` |

---

## 5. Error taxonomy

One closed enum, produced by `classifyImageryError(err, ctx)` in
`js/imagery.js` (pure; fixture-tested against real captured messages —
collecting those fixtures is part of P0 verification). `ctx` carries
`{ online, timedOut, phase }` from the wrapper.

| `error_class` | Meaning | Detection |
|---|---|---|
| `http_auth` | Mapillary 401/403 — token revoked/expired/blocked | message contains `401`/`403`/`Unauthorized`/`Forbidden` |
| `http_rate_limit` | Mapillary 429 — quota/rate exceeded | message contains `429`/`rate` |
| `http_server` | Mapillary 5xx | message contains `50x` status |
| `network_timeout` | request(s) never completed in budget | wrapper timeout fired (`ctx.timedOut`, §6.2) |
| `network_offline` | device offline | `ctx.online === false` (`navigator.onLine`) |
| `image_dead` | id no longer resolves (deleted/private imagery) | graph "not found" / "does not exist" messages |
| `no_neighbors` | image loads but has no navigable adjacency | `navigable=false` + nav attempt, or empty-adjacency SDK message |
| `viewer_init` | `new mapillary.Viewer` threw / container invalid | constructor try/catch |
| `webgl_unavailable` | no WebGL context on this device/browser | `mapillary.isSupported() === false` pre-check |
| `webgl_context_lost` | GPU/memory pressure killed the context | `webglcontextlost` canvas event |
| `gesture_blocked` | pointer events never reach the viewer (overlay, `touch-action`, scroll traps) | **not auto-classified** — inferred from report flow + replay + `pano_session` (pointer-downs > 0, pov changes = 0) |
| `reanchor_bounce` | app-level re-anchor/recreate fighting the user (the fixed movement-bounce class) | `pano_session.reanchors` counter (§7.2) — a regression canary, not an exception |
| `cancelled` | `moveTo` superseded by a newer `moveTo`/`remove` | SDK cancellation message; **never captured as an exception** (expected churn), counted in events only |
| `sdk_unknown` | anything else out of MapillaryJS | fallback |

Rules: `cancelled` is excluded from failure-rate math; `gesture_blocked`
and `reanchor_bounce` are diagnostic labels applied by humans/dashboards,
not classifier outputs; everything else is both an event property and an
exception's `error_class`.

---

## 6. Mapillary wrapper design and call-site migration

### 6.1 API (`js/viewer-ui.js`, browser glue; logic in `js/imagery.js`)

```js
// One instrumented viewer per surface.
const iv = createViewer({
  surface,        // "host"|"player"|"tv"|"tv_panel"|"daily"|"landing"
  container,      // element id
  moveAllowed,    // direction/sequence/keyboard components
  displayOnly,    // TV surfaces: pointer/zoom/bearing all off
});
iv.viewer                       // raw Viewer (pose APIs unchanged)
await iv.moveTo(imageId, purpose)  // timed + classified + instrumented
iv.session()                    // pano_session fold for this round (§7.2)
iv.destroy()

// The one shared dead-image skip loop (today copy-pasted 3×):
const { entry, skips } = await loadRoundImage(sampler, iv);
// entry === null → pool exhausted (caller keeps its existing handling);
// emits ONE imagery_load with the outcome + skip count, and per-skip
// trackError(image_dead) deduped by pool entry per session.
```

`purpose` enum: `anchor` (round start), `resume` (rejoin/refresh),
`follow` (TV mirroring a phone), `seed` (h2h panel first image), `hero`
(landing pano), `nav` (programmatic navigation — user arrow-clicks are
internal to the SDK and surface via `image` events instead).

Behavior inside `iv.moveTo`:

- `performance.now()` timing around the promise.
- Timeout race (policy in `imagery.js`): 20 s for `anchor`/`resume`/
  `seed`, 10 s for `follow`/`hero`. A timeout classifies as
  `network_timeout` but does **not** tear down the viewer — if the SDK
  finishes late, the `image` event still lands and a
  `imagery_load {ok:true, late:true}` corrects the record.
- On rejection: classify → `track("imagery_load", {ok:false, …})` →
  `trackError(wrapped, props)` (except `cancelled`) → rethrow, so every
  caller's existing catch/skip/toast behavior is untouched.
- `createViewer` pre-checks `mapillary.isSupported()`; a failed
  construction emits `viewer_init {ok:false}` + exception, and returns a
  stub whose `moveTo` always rejects `viewer_init` — callers' existing
  degradation paths handle the rest.
- Listeners: `image` (nav success + pose-sync passthrough), `navigable`
  (availability), `webglcontextlost` on the canvas (exception, class
  `webgl_context_lost`).

### 6.2 Every current call site, and what it migrates to

| # | Site | Today | Migrates to |
|---|---|---|---|
| 1 | `js/host-ui.js:388` `makeViewer()` | raw `new mapillary.Viewer` | `createViewer({surface:"host", moveAllowed})`; keep `pov`/`position`/`image` handlers on `iv.viewer` |
| 2 | `js/host-ui.js:455-468` round-start skip loop | silent `console.warn` + skip | `loadRoundImage(sampler, iv)` (purpose `anchor`) |
| 3 | `js/host-ui.js:1412-1414` resume `moveTo` | `catch → console.warn` | `iv.moveTo(id, "resume")` — catch stays |
| 4 | `js/host-ui.js:441` pose-read catch | silent | **unchanged** (expected mid-navigation churn; not a failure) |
| 5 | `js/player-ui.js:751` `makeViewer()` | raw | `createViewer({surface:"player", moveAllowed})` |
| 6 | `js/player-ui.js:622-633` h2h host skip loop | silent skip | `loadRoundImage(sampler, iv)` (purpose `anchor`) |
| 7 | `js/player-ui.js:729-737` re-anchor `moveTo` + toast | warn + toast | `iv.moveTo(target, "anchor")` — toast stays and gains the report link (§10) |
| 8 | `js/daily-ui.js:149` `makeViewer()` | raw | `createViewer({surface:"daily", moveAllowed:true})` |
| 9 | `js/daily-ui.js:123-136` daily skip loop | silent skip | `loadRoundImage(sampler, iv)` |
| 10 | `js/screen-ui.js:252-268` `ensureViewer()` | raw, display-only | `createViewer({surface:"tv", displayOnly:true})` |
| 11 | `js/screen-ui.js:291-302` follow `moveTo` | `catch → warn` | `iv.moveTo(target, "follow")` |
| 12 | `js/screen-h2h.js:262-274` 4× panel viewers + seed | raw + warn | `createViewer({surface:"tv_panel", displayOnly:true})`; `iv.moveTo(seed, "seed")` |
| 13 | `js/screen-h2h.js:387-390` panel follow | warn | `iv.moveTo(target, "follow")` |
| 14 | `js/landing-ui.js:82-96` hero viewer (try/catch) | silent return | `createViewer({surface:"landing", displayOnly:true})` — init failure now visible |
| 15 | `js/landing-ui.js:100-107` hero candidate loop | silent per-id skip | `iv.moveTo(id, "hero")` per candidate; failures tracked, loop unchanged |
| 16 | `applyPose` catches (`screen-ui.js:283`, `screen-h2h.js:434`), drift `setCenter` catch (`landing-ui.js:121`), all `resize()` catches | silent | **unchanged** — expected transient churn, not failures |

Migration invariant: **no behavior change**. Every catch, skip, toast, and
fallback stays exactly as it is; the wrapper only observes. The movement-
bounce guard (`shouldReanchorViewer`) is untouched — the wrapper just
counts re-anchors into `pano_session.reanchors` as its regression canary
(complementing the `guess_submitted.moved` KPI already in docs/analytics.md).

---

## 7. Event and exception schemas

### 7.1 New `EVENT_SCHEMA` entries (js/analytics.js)

Types are the existing sanitizer types. Enum values are documented here
and in docs/analytics.md; the sanitizer keeps enforcing shape (length ≤40)
as today.

```js
// Viewer construction, one per createViewer call.
viewer_init: {
  surface: "string",      // host|player|tv|tv_panel|daily|landing
  ok: "bool",
  error_class: "string",  // §5 enum; absent when ok
  duration_ms: "int",
  webgl: "bool",          // mapillary.isSupported()
  sdk: "string",          // "4.1.2" (pinned tag version)
},

// One per moveTo outcome AND one per round-start skip-loop resolution.
imagery_load: {
  surface: "string",
  purpose: "string",      // anchor|resume|follow|seed|hero|nav
  ok: "bool",
  late: "bool",           // resolved after the timeout already fired
  error_class: "string",
  duration_ms: "int",
  skips: "int",           // dead entries burned before this outcome (loop)
  pool_entry: "string",   // opaque diag id, §8 — never the image id
  net_type: "string",     // navigator.connection.effectiveType|"unknown"
  online: "bool",
},

// One per (surface, round) when the round leaves play or the viewer dies.
pano_session: {
  surface: "string",
  round_number: "int",
  looks: "int",           // pov-change bursts (throttled count)
  zoom_changes: "int",
  nav_moves: "int",       // image changes not caused by our moveTo
  nav_failures: "int",
  nav_available: "bool",  // last `navigable` state seen
  reanchors: "int",       // re-anchor writes during active play (§5)
  first_move_ms: "int",   // round start → first user interaction
  pointer_downs: "int",   // with looks==0 → gesture_blocked signal
},

// One per user-initiated report (§10).
imagery_report: {
  surface: "string",
  ref_code: "string",       // "GP-XXXXXX"
  error_class: "string",    // last classified failure, or "none"
  pool_entry: "string",
  net_type: "string",
  online: "bool",
  recent_failures: "int",   // imagery ring-buffer count, this session
  consent: "string",        // "analytics" | "one_time"
},
```

Volume sanity: a 5-round couch game ≈ 1 `viewer_init` + ~6 `imagery_load`
+ 5 `pano_session` on the host, similar on the TV — tens of events per
game, comfortably inside the existing 1M/mo envelope.

Naming note: the existing `BANNED_KEY_RE` (`/…device|user…/i`) stays; the
schema above deliberately avoids banned substrings. Browser/OS/device
class ride on PostHog's automatic `$browser` / `$os` / `$device_type` —
no custom properties needed.

### 7.2 Exception properties (`EXCEPTION_PROPS` allowlist, new)

`trackError(error, props)` in analytics.js mirrors `track()`: consent
check → sanitize against this allowlist → `posthog.captureException`.

```js
EXCEPTION_PROPS = {
  surface: "string", purpose: "string", error_class: "string",
  pool_entry: "string", duration_ms: "int", skips: "int",
  net_type: "string", online: "bool", webgl: "bool", ref_code: "string",
}
```

The captured `Error` is always our own wrapper
(`ImageryError: <error_class>`), with the original SDK message attached
*after* `scrubErrorMessage()` (strip query strings, replace ≥10-digit runs
with `<id>`), so stacks and messages can never smuggle an image id or a
tokened URL. Release/commit ride as super properties (§11) on every
exception automatically.

### 7.3 Auto-captured exceptions (`window.onerror`/rejections)

Grouped by PostHog as issues; `before_send` (§4.1) scrubs URLs/ids in
frames. No custom properties beyond super props — these are the unknown-
unknowns channel.

### 7.4 Client-side caps (budget protection)

In `imagery.js`, a per-session counter: at most **5 exceptions per
`error_class` per session** and at most **20 total**; past the cap,
`trackError` degrades to the (cheap, aggregated) `imagery_load` event
only. A device stuck in a retry loop cannot spend the monthly exception
budget. Events are already bounded by rounds-per-game.

---

## 8. Pool-entry diagnostic correlation (no coordinates)

**Requirement:** correlate failures on the *same pool entry* across
sessions without sending coordinates or the raw Mapillary image id (long
digit ids reverse to a place via the public Graph API).

**Design:** `poolDiagId(image_id)` in `js/imagery.js` — pure, dependency-
free: two FNV-1a 32-bit passes with distinct salts (the `hashSeed`
pattern already in `pool.js`), rendered as 8 base36 chars (`"k3x9q0ar"`).
Works on `file://` (no `crypto.subtle` dependency). A collision test over
the full `data/location_pool.json` id set joins the pool-integrity suite.

**Local lookup:** `tools/diag_lookup.mjs <diagid>` maps a dashboard id
back to the pool entry (id, name, viewer URL) by hashing the local pool.

**Reversibility tradeoff, documented honestly:** the pool file is public
in this repo, so anyone can precompute the hash→entry mapping; this is
**pseudonymization of app content, not a secret**. That is acceptable and
deliberate: pool entries are *game content we chose*, not user data — the
privacy line this preserves is that PostHog holds no coordinates and no
directly-reversible location keys, honoring the schema's banned-key
invariant and PRIVACY.md's "no coordinates" promise. What must *never*
appear, hashed or not, is anything derived from a **user's guess** — and
nothing in this plan touches guess data.

---

## 9. Session replay: staged policy, health model, privacy

Replay retention is **staged: learn first, sample later**. GeoParty has
almost no users yet, and the free tier includes 5,000 replays/month. A
failure-only posture at this volume would leave us with a handful of
broken-session recordings and *zero* examples of what a healthy session
looks like — no baseline load times, no normal skip rate, no picture of
how real players actually use navigation. The owner's call: optimize for
learning now, not for hypothetical future scale.

### 9.1 Session health model

Sessions are classified into three classes by `classifySessionHealth()`
— a pure fold in `js/imagery.js` over the session's instrumentation
(`viewer_init`, `imagery_load`, `pano_session`, exceptions, reports),
unit-tested with fixtures per class. The same definition is used
client-side (to force recording of non-healthy sessions in Stage 2+,
§9.3) and dashboard-side (the healthy/degraded/failed comparison panels,
§12.1). Precedence: **failed > degraded > healthy**.

| Class | Definition |
|---|---|
| **Healthy** | All of: viewer(s) constructed (`viewer_init ok:true`); every anchor/resume `imagery_load` ok with `duration_ms < 10 s`, `skips = 0`, not `late`; where movement is enabled, navigation available when attempted (`nav_available` true, `nav_failures = 0`); rounds progress normally (`guess_submitted` → `reveal_shown` for each started round); zero captured exceptions (`cancelled` never captures, §5) and zero `imagery_report`s. |
| **Degraded** | Playable but impaired — any of: a successful load with `duration_ms ≥ 10 s` or `late:true`; pool skips (`skips ≥ 1`) that still landed a pano; `no_neighbors`, `nav_available:false`, or `nav_failures > 0` where movement is enabled; partial interaction failure (`pointer_downs > 0` with `looks = 0` — the gesture-blocked signal). |
| **Failed** | The user saw a broken game — any of: no playable panorama for a round (anchor skip loop exhausted, or every attempt `ok:false`); `viewer_init ok:false` / `webgl_unavailable` / `webgl_context_lost`; any captured classified exception of a hard class (`http_auth`, `network_timeout` never corrected by a late success, `image_dead` exhausting the loop); or an explicit `imagery_report`. |

A skip that ultimately lands a pano marks the session **degraded**, not
failed — failed is reserved for sessions where the player experienced
breakage, so the failure-rate panels stay honest.

### 9.2 Staged retention policy

**Stage 1 — Learning mode (initial launch).**

- Record **100% of sessions where the user has explicitly accepted
  analytics** — healthy, degraded, and failed alike.
- **Time-box: 30 days, or 300 useful sessions, whichever comes first.**
  A *useful session* is a consented session with at least one round
  reaching `reveal_shown`, or at least one classified failure. Why 300
  (from the defensible 200–500 range): split across the top ~3 browser
  families × two device classes, 300 leaves roughly 50 sessions per
  major segment — about the minimum for stable per-segment P50s and
  meaningful P95s. Under ~200 the segment P95s are noise; past ~500,
  more data buys little at this traffic level and delays Stage 2.
- Failure triggers and the client-side override (§9.3) are configured
  from day one — redundant while sampling is 100%, but they make the
  Stage-2 transition a pure sampling change with no code risk.
- **Weekly replay-consumption review** (§9.5) and a **remote kill
  switch** (§9.3) run for the whole stage.
- Users who **declined or have not chosen remain completely
  unrecorded** — the only capture path outside accepted consent stays
  the explicit one-time diagnostic *report* flow (§10.4), which sends a
  single event bundle and **never a replay**.

**Stage 2 — Baseline sampling (after the learning threshold).**

- Healthy sessions: **15% random retention** (default; midpoint of the
  10–20% range). Justification: at current volumes 15% still yields a
  steady trickle of fresh healthy baselines — enough to notice drift in
  "normal" after a release — while cutting steady-state consumption
  ~85%; tune with §9.5 consumption data before moving off it.
- **100% recording** for sessions with: any captured exception; any
  `imagery_load ok:false`; a successful anchor load with
  `duration_ms ≥ 10 s`; `skips ≥ 2` in one round; navigation failures
  (`nav_failures > 0` or `no_neighbors`); or a manual `imagery_report`.
  (I.e., everything §9.1 classes as degraded or failed.)

**Stage 3 — Future scale (only if traffic materially grows).**

- Trigger: sustained consented traffic where Stage-2 policy would
  approach the §9.5 warning threshold (roughly >2k consented
  sessions/mo).
- Healthy sampling drops to **1–5%**; high-severity failures stay at
  100%.
- **Targeted temporary sampling** during investigations: boost recording
  for a specific browser/device/release via project settings or the
  linked feature flag, reverted when the investigation closes.

Stage transitions are owner decisions executed as PostHog
project-settings changes (no deploy); each transition gets a dated line
appended to the revision note at the top of this doc.

### 9.3 Recording mechanics: sampling, guaranteed triggers, kill switch

Healthy-session retention and failure guarantees ride on independent
mechanisms, so failing sessions record in *every* stage:

1. **Project-side sampling** governs healthy retention (100% → 15% →
   1–5%), adjustable remotely without a deploy.
2. **Failure guarantee**, twice over: project-side event triggers on
   `$exception` and `imagery_report` (§4.2), plus client-side — when the
   wrapper classifies a failure or a degraded condition (slow anchor,
   `skips ≥ 2`, nav failure), it calls
   `posthog.startSessionRecording()` to override a negative sampling
   decision. Buffering caveat: posthog-js buffers rrweb data client-side
   while a trigger is pending and flushes the lead-up when it fires —
   in Stage 1 this is moot (recording runs from session start), so
   **empirical verification of the buffering becomes a Stage-2 entry
   criterion** rather than a P1 blocker. If buffering proves partial or
   absent, Stage 2 accepts recording-from-the-failure-onward, with
   sampled healthy sessions still providing lead-up coverage
   statistically.
3. **Remote kill switch:** recording is linked to the
   `replay-imagery-debug` feature flag — turning it off stops all
   recording remotely, in any stage, without a deploy. The project-level
   "Record user sessions" master toggle is the second, vendor-side
   lever.

### 9.4 Replay privacy configuration (identical in every stage)

Learning mode does not loosen one bit of masking: a 100%-sampled healthy
session is recorded under exactly the same configuration as a failing
one, and all of it only ever after explicit analytics consent.

- `maskAllInputs: true` — nothing typed is recorded, ever (team names!).
- `maskTextSelector: "[data-ph-mask]"` — a P1 sweep adds `data-ph-mask`
  to every element that renders a team name or a room code (lobby lists,
  HUDs, scoreboards, headings, QR captions). The tests can't see DOM, so
  the sweep is enumerated as an explicit checklist in the P1 PR.
- `captureCanvas: false` — the WebGL pano is a black box in replays. This
  is deliberate: it keeps replay payloads small and keeps street imagery
  (a location proxy) out of PostHog. Debugging does not need the pixels —
  it needs console + network + UI state, which replay provides.
- Network capture: timing/status/path only; `recordHeaders`/`recordBody`
  false; query strings stripped in `maskCapturedNetworkRequestFn` (§4.1)
  — Mapillary access tokens travel in query params today, so this strip
  is mandatory before replay ships.
- Console capture: on; our own warn lines (which already name skipped
  image ids locally) are P1-swept to log the diag id instead of the raw
  id, so consoles inside replays match the no-raw-id rule.
- Page URLs inside replay metadata may include `?room=CODE`. Room codes
  are already an allowlisted, ephemeral (≤24 h) event property by policy
  (PRIVACY.md), so this is accepted, not a leak — but `before_send`
  strips query strings from event-side URLs anyway, and the P1 checklist
  evaluates `history.replaceState` cleanup on the player/screen pages as
  a nice-to-have.

To restate the invariants that hold even at 100% learning-mode
recording: replay only after explicit analytics consent; canvas/street
imagery never captured; inputs, team names, and room-code UI masked;
headers and request/response bodies never recorded; URL query
strings/tokens stripped; no coordinates and no raw image ids leave the
device. And per §3, consent copy + PRIVACY.md disclose replay before any
of it ships.

### 9.5 Replay budget, weekly review, warning thresholds

- **Free allowance: 5,000 replays/month.** Expected Stage-1 volume:
  current traffic is, optimistically, tens of consented sessions per
  week — even at 100% recording that is a few hundred replays/month,
  comfortably under 10% of the allowance. The headroom is large; the
  binding constraint in learning mode is *owner review attention*, not
  quota.
- **Weekly consumption review** (owner, ~10 minutes, every stage):
  check the month-to-date replay count against the thresholds below,
  skim a few new recordings (feeding the §12.1 baseline notes), and
  spot-check that masking holds on real recordings.
- **Warning threshold: 2,500 replays/month (50% of allowance).**
  Crossing it prompts a *sampling review* — consider entering Stage 2
  early, raising the minimum-duration floor, or tightening degraded
  triggers. It is a review prompt, **not** automatic billing: the free
  tier stops ingesting rather than charging, and the plan never
  intentionally rides the allowance edge. At **4,000/month (80%)**,
  reduce sampling immediately rather than waiting for the weekly slot.
- The 2000 ms minimum-duration setting (§4.2) keeps empty blips from
  consuming quota in every stage.

---

## 10. "Image not working? Report it" flow

### 10.1 Placement

Phones only (the TV has no convenient input; TV problems get reported
from the host phone). The affordance appears in two places:

1. **Reactive:** the existing failure toast (`player-ui.js:735`) becomes
   a toast with an inline action link, and the host/daily equivalents
   gain the same.
2. **Ambient:** a small text link under the pano on host / player / daily
   round screens, visible whenever the round is active — findable when
   the viewer *renders but misbehaves* (the `gesture_blocked` class that
   no automatic signal catches).

Respecting the UI/UX review's "≤2 non-game elements on any play screen"
rule: the ambient link is typographically quiet (small, dim) and counts
as chrome only while the pano screen is up.

### 10.2 What a report does

1. Builds the diagnostic bundle (pure fold in `imagery.js` over the
   session ring buffer): last classified failure, counts, surface,
   connection, release, viewer state (`webgl`, `nav_available`).
2. Generates `ref_code` = `"GP-" + 6` Crockford-base32 chars derived from
   the PostHog session id + a monotonic counter (pure, tested; no
   `Math.random` needed for uniqueness at our scale).
3. Fires `imagery_report` (event) + `trackError(ReportedByUser, …)` with
   `ref_code` — from Stage 2 on, the exception ensures the replay
   trigger fires even in sessions with no prior `$exception` (in
   learning mode the session is already recording).
4. Shows the confirmation with the reference code.

Lookup path for support: search `ref_code` in PostHog → the
`imagery_report` event → its session → replay + issues + full event trail.

### 10.3 Exact copy (consented users)

- Ambient link: `📷 Image not working? Report it`
- Sheet title: `Report an image problem`
- Sheet body: `This sends an anonymous snapshot of what went wrong —
  what failed to load, how long it took, and your browser type. Never
  your location, guesses, or names.`
- Buttons: `Send report` / `Cancel`
- Confirmation: `Thanks — sent. Your reference code is GP-XXXXXX.
  Mention it if you get in touch.`
- Failure (PostHog unreachable/blocked): `Couldn't send the report — you
  may be offline or blocking analytics. No data was collected.`

### 10.4 Declined / undecided users: one-time diagnostic consent

If the stored consent is `declined` (or not chosen), the sheet becomes an
explicit one-shot ask — **no silent collection, ever**:

- Title: `Send a one-time diagnostic report?`
- Body: `You've said no to analytics — we've respected that and collected
  nothing. To debug this image problem we'd need to send one anonymous
  report: what failed, timings, and your browser type. Never your
  location, guesses, or names. This is one report, not ongoing tracking —
  your "no" stays in place.`
- Buttons: `Send one report` / `No thanks`

Mechanics: a dedicated one-shot init path in analytics.js —
`posthog.init(key, { ...same options, persistence: "memory",
disable_session_recording: true, autocapture: false })` — sends the
`imagery_report` event + one exception, then `opt_out_capturing()`. No
replay (recording a session under one-shot consent exceeds what was asked
for), no cookies/localStorage (memory persistence), stored consent flag
untouched (stays `declined`). This is the **only** capture path outside
the accepted-consent gate, it cannot fire without two explicit taps, and
it is documented in PRIVACY.md (P2, with this feature).

---

## 11. Release stamping (static GitHub Pages)

**Mechanism:** switch Pages deployment to the official GitHub Actions
flow (`actions/upload-pages-artifact` + `actions/deploy-pages`). The
workflow checks out, runs the existing CI checks, writes one generated
file into the artifact (never committed):

```json
// release.json (artifact-only)
{ "commit": "<GITHUB_SHA>", "short": "<sha7>",
  "deployed_at": "<ISO8601>", "run": "<run id>", "env": "pages" }
```

Client side (consent.js glue, after a successful PostHog init only):
`fetch("release.json", { cache: "no-store" })` →
`posthog.register({ release: short, commit, deployed_at })`. Fetch failure
or `file://` → `posthog.register({ release: "dev" })`. Every event,
exception, and replay is thereby release-correlated; the "exceptions by
release" panel and regression alerts key off `release`.

Why this shape: no build step enters the dev loop (the repo runs from a
checkout exactly as today; `release.json` is simply absent → `dev`);
nothing is committed per deploy; the SHA and timestamp are exact, not
hand-maintained. Rejected alternatives: committing a version file each
push (history noise, races), querying the GitHub API at runtime (latency,
rate limits, a new third-party call pre-consent).

---

## 12. Reliability dashboard + alerts

One PostHog dashboard, **"Field reliability"**:

| # | Panel | Definition |
|---|---|---|
| 1 | Imagery success rate | `imagery_load` ok share, excluding `error_class=cancelled`; trend + by `surface` |
| 2 | Anchor load speed | P50/P95 `duration_ms`, `purpose=anchor`, `ok=true`; by `net_type` |
| 3 | Failures by class | stacked count by `error_class` |
| 4 | Failures by environment | failure rate by `$browser`, `$os`, `net_type` |
| 5 | Worst pool entries | table: `pool_entry` by failure count + distinct sessions (feeds §13) |
| 6 | Skips per round | avg + distribution of `imagery_load.skips` (purpose=anchor); share with skips>0 |
| 7 | Navigation health | share of `pano_session` with `nav_failures>0`; `nav_available=false` count; `reanchors>0` count (bounce-regression canary) |
| 8 | Exceptions by release | `$exception` count by `release` (+ issue list widget) |
| 9 | First playable pano rate | share of `imagery_load` (purpose=anchor) with `ok=true`, `skips=0`, `duration_ms<10000` — "round 1 just worked" |
| 10 | Reports | `imagery_report` table: `ref_code`, `error_class`, `surface` → session/replay links |
| 11 | Web Vitals | built-in `$web_vitals` panel (LCP/INP on phone pages) |
| 12 | Session health mix | share of sessions healthy / degraded / failed (§9.1), trended, by `release` and `surface` |
| 13 | Health-class comparison | healthy vs degraded vs failed side by side: anchor load P50/P95, skip rate, navigation use, round-completion rate |

### 12.1 Baseline learning (the Stage-1 deliverable)

Learning mode is only worth its replays if it ends with written answers.
Panels 12–13 give every reliability number a healthy/degraded/failed
comparison, and the learning-mode **exit report** (written at the §9.2
threshold, before flipping to Stage 2) must answer, from data:

- **Load-time baseline:** P50/P95 anchor image load by `$browser`,
  `$os`, `net_type`, and `surface` — what "normal speed" is per segment,
  so the panel-2 alert thresholds stop being guesses.
- **Normal skip rate:** share of rounds with `skips > 0` and its
  distribution — what background pool decay looks like when nothing is
  wrong.
- **Navigation availability and use:** how often `nav_available` is
  true where movement is enabled, how often players actually navigate
  (`nav_moves`), and the baseline `nav_failures` rate.
- **Completion differences:** do degraded sessions still finish rounds
  and games at healthy rates (`guess_submitted` / `reveal_shown` funnels
  per health class), or do slow loads and skips bleed players?
- **WebGL and mobile Safari behavior:** WebGL support rate,
  `webgl_context_lost` frequency, and whether iOS Safari's load P95s and
  context losses differ enough to deserve segment-specific thresholds.

Those answers become the Stage-2 alert thresholds and the yardstick
every future "is imagery healthy?" question is measured against.

Alerts (PostHog insight alerts → owner email):

| Alert | Threshold |
|---|---|
| Imagery success rate | < 97% over 24 h (warn); < 90% (critical) |
| Exception spike | daily `$exception` > 3× trailing-7-day median, min 20 |
| Rate limiting | `error_class=http_rate_limit` > 20/day (token/quota problem) |
| Auth failure | any `http_auth` > 5/day (token revoked — page the owner) |
| Viewer init failure | `viewer_init` ok=false rate > 2%/day |
| Chronic entry | any `pool_entry` ≥ 5 failures across ≥ 3 sessions / 7 d (feeds §13 suspects) |
| Replay consumption | month-to-date replays > 2,500 (50% of allowance → sampling review, §9.5); > 4,000 (80% → reduce sampling now) |

Thresholds are starting points; the P1 exit criterion is two weeks of real
data without a false-positive-dominated inbox, tuning as needed.

---

## 13. Pool health check (GitHub Actions)

**Goal:** stop paying the dead-entry tax (skips) permanently — recheck
field-reported entries and a rotating sample, and *propose* quarantine.

- `.github/workflows/pool-health.yml`: weekly cron (Mon 04:13 UTC — odd
  minute, politeness) + `workflow_dispatch`. Timeout 30 min.
- `tools/pool_health.mjs` (Node ≥22, zero deps):
  1. Load `data/location_pool.json`.
  2. Build the check set: (a) up to 100 **suspects** from
     `tools/pool-suspects.json` — curated from dashboard panel 5 (manual
     export at first; an optional P2 step queries the PostHog HogQL API
     with a `POSTHOG_PERSONAL_API_KEY` repo secret and maps diag ids back
     via the local pool); (b) 150 rotating-sample entries, seeded by ISO
     week so the whole pool is swept over ~ a year.
  3. For each id: `GET https://graph.mapillary.com/<id>?fields=id`
     with the public token. **One request per ~1.2 s + jitter** (≤ 250
     requests ≈ 5 min of polite traffic weekly). On the third 429:
     abort the run cleanly (exit 0, log a notice) — never hammer.
  4. Update per-id consecutive-failure counts in
     `tools/pool-health-state.json`, persisted between runs via the **Actions
     cache** (restored before the check, saved after with `if: always()` under
     a `run_id`-unique key). Persisting the counter — rather than committing
     bookkeeping to `main` — is what makes the two-strike threshold reachable
     at all; the original workflow only echoed a notice, so `fails` maxed at 1
     forever and no PR could ever open (fixed in the v0.3 stabilization pass).
- **Quarantine proposal:** ids dead on ≥ 2 consecutive runs go into a PR
  adding them to `data/pool_quarantine.json` (a plain id array). The PR
  is opened with `gh`, never auto-merged — the owner reviews (a 404 can
  be transient Mapillary indigestion). The game change (P2, small +
  tested): `loadPool()` filters quarantined ids when the file exists;
  absent file → no-op, so `file://` and old checkouts keep working.
  Runtime dead-skip stays as the belt to this suspender.
- This is the **only consent-independent signal** in the system: it
  measures the pool, not users, so it also covers the invisible-user
  population (§16).

---

## 14. Phased implementation plan (for Opus, post-approval)

Ground rules for every phase: pure logic in `js/imagery.js` /
`js/analytics.js` with tests in `tests/*.test.js`; UI files stay thin;
`npm test` + `npm run check` green; docs/analytics.md rows for every new
event; no behavior change to any existing catch/skip/toast path.

### P0 — "See the failures" (1 PR, ~a day)

1. Pages deploy workflow + `release.json` + register glue (§11).
2. `POSTHOG_INIT_OPTIONS` additions: `capture_exceptions`,
   `capture_performance.web_vitals`, `before_send` (§4.1). Project
   settings: exception autocapture ON (owner).
3. `js/imagery.js`: classifier + fixtures, `scrubErrorMessage`,
   `poolDiagId` (+ pool-wide collision test), timeout policy, caps
   (§7.4). `js/viewer-ui.js`: `createViewer`, `iv.moveTo`,
   `loadRoundImage`.
4. analytics.js: `viewer_init` + `imagery_load` schema entries,
   `EXCEPTION_PROPS` + `trackError`.
5. Migrate call sites 1–3, 5–15 (§6.2).
6. Docs: analytics.md rows; **PRIVACY.md**: exceptions + release stamp
   language.
7. Dashboard panels 1–6, 8; alerts 1–4.
- **Tests:** classifier fixtures per class; scrubber (query strings,
  digit runs); diag-id format/stability/collisions; sanitizer accepts new
  events and strips banned keys; `trackError` never calls through without
  consent; caps counter.
- **Failure injection (§15):** scenarios A, E, G.
- **Deploy verification:** post-deploy checklist — real phone, consent
  accepted, one forced dead-image round → issue visible in PostHog with
  `release` = deployed SHA within 5 minutes.
- **Rollback:** revert commit (Pages redeploys previous state); project-
  side kill: exception autocapture toggle OFF stops ingestion instantly.

### P1 — "See the story" (1 PR + settings, ~a day)

1. Replay in **learning mode**: init `session_recording` block; project
   settings sampling **100%** + failure event triggers (§4.2, §9.2–9.3);
   client-side `startSessionRecording()` override wiring; console
   diag-id sweep; `replay-imagery-debug` kill-switch flag wired and
   tested off/on.
2. **Ship-blockers before recording turns on:** (a) the `data-ph-mask`
   sweep checklist completed and verified against a *real* recording
   (masked team names/room codes, black canvas); (b) consent banner copy
   and PRIVACY.md updated to clearly disclose session replay and
   technical telemetry (§3).
3. `pano_session` event + wrapper listeners (`navigable`,
   `webglcontextlost`, interaction fold); `classifySessionHealth` in
   `js/imagery.js` (§9.1).
4. Report flow, consented path only (§10.1–10.3): toast action + ambient
   link + sheet + `imagery_report` + ref codes.
5. Dashboard panels 7, 9–13; alerts 5–7; the weekly consumption review
   (§9.5) starts with the first deploy.
- **Tests:** pano-session fold; health classifier fixtures per class
  (healthy/degraded/failed, precedence rules); ref-code
  format/uniqueness; report bundle fold; mask-selector list snapshot
  (checklist file).
- **Failure injection:** scenarios B, C, D, F — proving the full chain
  issue → exception/event → replay → console+network → dashboard — plus
  the healthy-session recording check (§15).
- **Rollback:** replay OFF is one project-settings toggle (or the flag);
  events revert with the commit.

### P1.5 — Stage-2 transition (no PR; settings + a written report)

At 30 days or 300 useful sessions (§9.2), whichever first: write the
learning-mode exit report (§12.1); **empirically verify trigger
buffering** (§9.3) with documented result, wiring the fallback if
needed; then flip project-side sampling 100% → 15%. One settings change,
one dated line in the revision note.

### P2 — "Close the loop" (2 small PRs)

1. One-time diagnostic consent (§10.4) + PRIVACY.md section + tests
   (memory-persistence init never touches storage; declined flag
   unchanged).
2. Pool health workflow + `pool_health.mjs` + quarantine filter in
   `loadPool()` (+ tests: filter applied, absent-file no-op) +
   `tools/diag_lookup.mjs`.
3. Threshold-tuning pass on alerts using the §12.1 baseline numbers;
   Sentry checkpoint (§17).

### Explicitly deferred (not in P0–P2)

- Replaying canvas/pano pixels (privacy + payload cost; revisit never,
  probably).
- Automatic `gesture_blocked` classification (heuristics too flaky; the
  report flow + replay covers it).
- PostHog API-driven suspect export (optional P2+; manual curation first).

---

## 15. Verification plan — deliberate failure simulation

Run on a local static server + one real phone, consent accepted, chaos
hooks active **only** on `localhost`/`127.0.0.1` (`window.__gpChaos`,
inert in production by hostname check; its inertness is part of code
review, not shipped behind a query param).

| # | Scenario | How to simulate | Must produce |
|---|---|---|---|
| A | Rejected `moveTo` | chaos: force `moveTo` rejection with a graph "not found" message; also a real bogus id | `imagery_load{ok:false, image_dead}` + issue, round skips forward exactly as today |
| B | Timeout | DevTools "Slow 3G" + chaos delay > 20 s | `network_timeout` classified; late SDK completion emits `ok:true, late:true`; replay shows the stall in the waterfall |
| C | 429 | DevTools local override on `graph.mapillary.com` → 429 body | `http_rate_limit` issue; alert insight increments |
| D | Script blocked | block `eu-assets.i.posthog.com` (adblock/DevTools) | zero errors thrown to the user; analytics stays silently off (existing catch); report flow shows the §10.3 failure copy. Separately block `unpkg.com` → `viewer_init` cannot send (PostHog fine) — landing degrades to gradient as today |
| E | Offline mid-round | DevTools offline after round start | `network_offline` classified; events queue (existing QUEUE_MAX) and flush on reconnect |
| F | No neighbors | curated single-image pool entry (found during P1) with movement on | `no_neighbors` on nav attempt; `pano_session.nav_available=false` |
| G | Handled failure | prepend a dead id to a local pool copy | the silent-skip path emits `imagery_load{skips:1}` + one deduped `image_dead` exception; gameplay identical |

Chain proof (P1 exit criterion, run for B and G): PostHog **issue** →
its `$exception` event carries `error_class`/`pool_entry`/`release` →
linked **replay** shows the round, the synced **console** warn, and the
Mapillary request in the **network** waterfall with status/timing →
dashboard panels 1/3/5 move → `tools/diag_lookup.mjs` maps the
`pool_entry` back to the real entry locally.

Learning-mode proof (P1 exit criterion, alongside the chain proof): play
one fully *healthy* round on a real phone with consent accepted →
a replay appears without any failure trigger firing, the §9.1 classifier
marks the session healthy, panel 12 counts it — and the recording shows
masked inputs/team-name elements, a black canvas, and query-stripped
network entries (§9.4 verified on a real recording, not just in code
review). Then flip the `replay-imagery-debug` flag off and confirm a
second session records nothing.

---

## 16. What remains invisible (honest limits)

- **Users who decline analytics** — the largest blind spot, by design and
  by conviction. No events, no exceptions, no replay, ever. Their only
  voluntary window is the one-time diagnostic report (§10.4). Note we
  cannot even measure the size of this population (decliners send
  nothing — PRIVACY.md's consent-rate caveat applies to observability
  too).
- **First-visit failures before a consent choice** — the banner shows on
  first load; a user whose very first round breaks before they've tapped
  "Sounds good" is invisible unless they report.
- **Ad-blocked / tracker-blocked users** — PostHog's script simply never
  loads (the existing silent-off path). Likely correlated with exactly
  the privacy-conscious segment that also declines.
- **`file://` and offline play** — no PostHog reachability; events queue
  only within a live page's memory (QUEUE_MAX 100).
- **Hard tab deaths** — OOM kills, iOS WebGL tab reloads, and TV-stick
  browser crashes can drop the buffer before `sendBeacon` flushes; the
  exception often outruns the crash, the replay tail may not.
- **The pano pixels in replays** — deliberately black (`captureCanvas:
  false`, §9.4), in learning mode exactly as in every later stage.
- **Internal SDK arrow-click navigation failures** — no rejection reaches
  our code; visible only via console capture inside replays and
  `pano_session` counters, not as classified exceptions.

The two consent-independent instruments — the pool health check (§13,
measures the pool, not people) and the ref-coded report flow — are the
only lights in these shadows, and that is the intended trade.

---

## 17. Sentry: adoption criteria (not now)

Stay single-vendor on PostHog until **at least one** of these is true and
sustained for a month:

1. **Grouping fails in practice** — PostHog issue grouping produces
   duplicate/fragmented issues per release at a rate that makes triage
   slower than reading raw events (evaluate after 2 months of real
   traffic, P2 checkpoint).
2. **Pre-failure replay proves impossible** — the §9.3 buffering
   verification (Stage-2 entry criterion) fails AND post-failure-only
   recordings demonstrably miss root causes we needed — a gap that
   Stage-1's full recordings and Stage-2's sampled healthy sessions are
   expected to cover statistically first.
3. **Volume** — exceptions trend past ~50k/mo (half the free tier) or
   replays sustain past the 2.5k/mo warning threshold (§9.5) *after*
   sampling has already been tightened.
4. **Release-health gating** — we want crash-free-session rates to gate
   deploys automatically, which PostHog doesn't model.
5. **Alert routing** — email alerts stop being enough (on-call routing,
   escalation), beyond PostHog's integrations.

Counter-argument to record: Sentry would *not* fix the biggest blind spot
(decliners) — under GDPR its SDK sits behind the same consent gate. Adding
it buys grouping/workflow maturity, not visibility. If adopted, it takes
exceptions + replay only; product analytics stays in PostHog.

---

## Appendix A — files touched per phase (for review scoping)

| Phase | New | Modified |
|---|---|---|
| P0 | `js/imagery.js`, `js/viewer-ui.js`, `tests/imagery.test.js`, `.github/workflows/pages.yml` | `js/analytics.js`, `js/consent.js`, `js/host-ui.js`, `js/player-ui.js`, `js/daily-ui.js`, `js/screen-ui.js`, `js/screen-h2h.js`, `js/landing-ui.js`, `tests/analytics.test.js`, `docs/analytics.md`, `PRIVACY.md` |
| P1 | (checklist file for mask sweep) | `js/analytics.js` (replay opts), `js/imagery.js` (`classifySessionHealth`), `*-ui.js` (report flow, `data-ph-mask`), `css/*`, `tests/imagery.test.js`, `docs/analytics.md`, `PRIVACY.md` + consent banner copy (replay disclosure, ship-blocker §3) |
| P2 | `.github/workflows/pool-health.yml`, `tools/pool_health.mjs`, `tools/diag_lookup.mjs`, `data/pool_quarantine.json` (empty seed) | `js/pool.js`, `js/analytics.js` (one-shot init), `js/consent.js`, `tests/pool.test.js`, `PRIVACY.md` |

Nothing in this plan touches `data/location_pool.json` generation,
Firebase, or game logic.

---

## Implementation note — 2026-08-20 (P0–P2 shipped)

Implemented from this plan in one pass. What follows is the honest delta
between the plan as written and the code as built; everything not listed
here was implemented as specified.

**Owner sequencing decision (recorded).** Stage-1 learning mode ships as
specified (100% of explicitly consented sessions, 30 days / 300 useful
sessions), but it is **not a deployment gate**: later roadmap work does not
wait on it. The Stage-2 transition (§9.2, §14 P1.5) remains future
operational policy.

**Plan conflict resolved — no permanent pano chrome.** §10.1's *ambient*
"Image not working? Report it" link under the active panorama conflicts
with `docs/ui-ux-design-review.md`, which protects the pano as the
product's cleanest screen. Per PM decision the ambient link was **not**
built. Reportability is preserved three ways instead (see the header
comment in `js/report-ui.js`): a reactive inline action inside the toast
that a failure already raises; a quiet link on the existing 🍪
analytics/diagnostics settings surface (the calm-state path, and the only
route for `gesture_blocked`, which raises no toast); and fully automatic
consent-gated reporting for classified failures. The §10.4 one-time
diagnostic consent for decliners is implemented exactly as specified.

**Deviations, each with its reason:**

1. **`imagery_load.late` → `after_timeout`.** The existing
   `BANNED_KEY_RE` (`/lat|…/`) strips any property whose key contains
   `lat` — including `late`. Renaming the property was the safe fix;
   weakening the coordinate guard was not.
2. **Maps are blocked from replay, and OSM tile hosts are not in the
   network allowlist.** §9.4 enumerated canvas, inputs, team names and room
   codes but not Leaflet. A tile URL is `/{z}/{x}/{y}.png` — literally a
   coordinate — so recording tiles would have leaked both the round's
   answer and the player's aim. `blockSelector: ".leaflet-container,
   [data-ph-block]"` plus dropping tile hosts from the waterfall closes it.
   Reveal **place names** are masked for the same reason.
3. **Stage-1 replay event triggers are NOT configured project-side.** In
   PostHog, `session_recording_event_trigger_config` *gates* recording:
   with triggers set, sessions that never fire the trigger do not record.
   Configuring `$exception` / `imagery_report` triggers now would have
   defeated learning mode's entire purpose. Sampling is 100% and the
   client-side `startSessionRecording()` override (§9.3.2) is wired and
   tested; the triggers become a Stage-2 settings change, applied in the
   same click as the 100% → 15% sampling drop.
4. **`loadRoundImage` short-circuits on a stub viewer.** With no WebGL,
   every attempt rejects; the plan's unbounded loop would have ground
   through all 5,312 pool entries. It now reports the real cause once and
   returns "no entry" without consuming a pool entry. The loop is otherwise
   unbounded exactly as before.
5. **The per-purpose timeout is a real behavior change**, as §6.1
   specifies: a `moveTo` that never settles now rejects at 20 s / 10 s
   instead of hanging forever, and a late SDK success emits a correcting
   `imagery_load{ok:true, after_timeout:true}`. Every other catch, skip,
   toast and fallback is byte-for-byte unchanged.
6. **`pano_session` is emitted on TV surfaces too** (`tv`, `tv_panel`),
   where the interaction counters are structurally zero. `nav_available`
   and `webglcontextlost` still carry signal about TV-stick browsers, and
   the health model already ignores navigation facts where movement is not
   offered.
7. **Alert coverage is bounded by the PostHog API.** Six insight alerts
   exist (§12 rows 1–5). The "3× trailing-7-day median" exception spike is
   not expressible — PostHog alert thresholds are absolute — so it fires on
   the plan's floor (>20/day) and the trend is read on panel 8. "Chronic
   pool entry" (a per-entity threshold) and "replay consumption" (replays
   are not events) have no alert primitive; both are dashboard panels /
   the §9.5 weekly owner review.
8. **`anonymize_ips` was OFF** on the PostHog project despite PRIVACY.md
   promising it. Turned **on** as part of this work.

**Verified external objects** (PostHog EU, project 252836): dashboard
`905962` "Field reliability" with 17 tiles (13 plan panels + 4
alert-backing insights); feature flag `replay-imagery-debug` id `255025`,
linked to session recording as the remote kill switch; six enabled daily
alerts. IDs and URLs are listed in `docs/analytics.md` and the
implementation report.
