# Field observability plan — imagery & viewer debugging in the wild

**Status: PLAN ONLY — no production code changes until owner approval.**
Implementation is specified here for Opus to execute phase by phase (§14).

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
- Failing sessions get a session replay with synchronized console output
  and a network waterfall (timing/status/path only).
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
- No recording of every session — replay is failure-triggered (§9).
- No weakening of the schema-allowlist / consent-gate architecture.
  Observability *extends* `js/analytics.js`; it never bypasses it.

**Cost envelope** (PostHog free tier, current): 1M events/mo, 100k
exceptions/mo, 5k replays/mo. Budget math in §13 shows expected usage at
well under 5% of each; client-side caps (§7.4) make runaway loops unable to
blow the exception budget.

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
PostHog groups it as an issue → the `$exception` event triggers session
replay upload (buffered, §9.2) → issue links replay with console warns and
the Mapillary network waterfall → dashboard panel moves → (if chronic on
one entry) weekly health check confirms → quarantine PR.

Everything below `consent.js` in that diagram fires **only after consent**
(analytics consent, or the one-shot diagnostic consent). No new scripts,
no new vendors, no capture-before-opt-in — the existing `track()` gate is
reused verbatim, and `trackError` sits behind the same gate.

---

## 3. Consent model (unchanged core + one addition)

| State | Product events | Exceptions | Replay | Report flow |
|---|---|---|---|---|
| Accepted | yes (today) | yes (new) | on failure triggers (new) | full |
| Declined | no | no | no | one-time consent ask (§10.4) |
| Not chosen yet | no | no | no | one-time consent ask (§10.4) |

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

  // NEW — session replay behavior (recording itself is trigger-gated, §9)
  session_recording: {
    maskAllInputs: true,
    maskTextSelector: "[data-ph-mask]",   // team names, room codes (§9.3)
    captureCanvas: false,                 // WebGL pano NOT recorded (§9.3)
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
| Session replay → Sampling | **0%** | nothing records by default |
| Session replay → Event trigger | `$exception`, `imagery_report` | record only failing sessions (§9.2) |
| Session replay → Minimum duration | 2000 ms | drop empty blips |
| Session replay → Capture console logs | **ON** | synced warns/errors |
| Session replay → Capture network performance | **ON** | waterfall (timing/status/path) |
| Session replay → Record canvas | **OFF** | pano pixels stay out (§9.3) |
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

## 9. Session replay: triggers, sampling, privacy

### 9.1 What gets recorded

Only sessions where something went wrong: project-side **event triggers**
on `$exception` and `imagery_report` (§4.2), sampling otherwise **0%**.
Expected volume: (failing sessions) ≈ tens/month — far under the 5k cap.

### 9.2 Trigger mechanics and the buffering caveat

posthog-js with an event trigger buffers rrweb data client-side while the
trigger is *pending* and flushes the buffer when the trigger event fires —
which is exactly the "show me the lead-up to the failure" behavior we
want. **P1 must verify this buffering empirically** (it is the load-
bearing assumption of the replay design). Fallback if buffering proves
partial or absent: init with `disable_session_recording: true` and call
`posthog.startSessionRecording()` from the wrapper at the first classified
failure — accepting that the recording then starts *at* the failure
(retries, skips, and the report flow are still captured). A linked feature
flag (`replay-imagery-debug`) acts as a remote kill switch either way.

### 9.3 Replay privacy configuration

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
   `ref_code` — the exception ensures the replay trigger fires even in
   sessions with no prior `$exception`.
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

Alerts (PostHog insight alerts → owner email):

| Alert | Threshold |
|---|---|
| Imagery success rate | < 97% over 24 h (warn); < 90% (critical) |
| Exception spike | daily `$exception` > 3× trailing-7-day median, min 20 |
| Rate limiting | `error_class=http_rate_limit` > 20/day (token/quota problem) |
| Auth failure | any `http_auth` > 5/day (token revoked — page the owner) |
| Viewer init failure | `viewer_init` ok=false rate > 2%/day |
| Chronic entry | any `pool_entry` ≥ 5 failures across ≥ 3 sessions / 7 d (feeds §13 suspects) |

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
     `tools/pool-health-state.json` (committed via the PR below).
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

1. Replay: init `session_recording` block, project triggers/sampling
   (§4.2), `data-ph-mask` sweep checklist, console diag-id sweep,
   **empirical buffering verification** (§9.2) with documented result;
   fallback wiring if needed; `replay-imagery-debug` kill-switch flag.
2. `pano_session` event + wrapper listeners (`navigable`,
   `webglcontextlost`, interaction fold).
3. Report flow, consented path only (§10.1–10.3): toast action + ambient
   link + sheet + `imagery_report` + ref codes.
4. Dashboard panels 7, 9, 10, 11; alerts 5–6.
- **Tests:** pano-session fold; ref-code format/uniqueness; report bundle
  fold; mask-selector list snapshot (checklist file).
- **Failure injection:** scenarios B, C, D, F — proving the full chain
  issue → exception/event → replay → console+network → dashboard.
- **Rollback:** replay OFF is one project-settings toggle (or the flag);
  events revert with the commit.

### P2 — "Close the loop" (2 small PRs)

1. One-time diagnostic consent (§10.4) + PRIVACY.md section + tests
   (memory-persistence init never touches storage; declined flag
   unchanged).
2. Pool health workflow + `pool_health.mjs` + quarantine filter in
   `loadPool()` (+ tests: filter applied, absent-file no-op) +
   `tools/diag_lookup.mjs`.
3. Two-week threshold-tuning pass on alerts; Sentry checkpoint (§17).

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
  false`, §9.3).
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
2. **Pre-failure replay proves impossible** — §9.2's buffering
   verification fails AND post-failure-only recordings demonstrably miss
   root causes we needed.
3. **Volume** — exceptions trend past ~50k/mo (half the free tier) or
   replays past 2.5k/mo.
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
| P1 | (checklist file for mask sweep) | `js/analytics.js` (replay opts), `*-ui.js` (report flow, `data-ph-mask`), `css/*`, `tests/imagery.test.js`, `docs/analytics.md` |
| P2 | `.github/workflows/pool-health.yml`, `tools/pool_health.mjs`, `tools/diag_lookup.mjs`, `data/pool_quarantine.json` (empty seed) | `js/pool.js`, `js/analytics.js` (one-shot init), `js/consent.js`, `tests/pool.test.js`, `PRIVACY.md` |

Nothing in this plan touches `data/location_pool.json` generation,
Firebase, or game logic.
