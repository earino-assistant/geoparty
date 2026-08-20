# Failure injection — runbook and results

The §15 verification plan of `docs/field-observability-plan.md`, in two
forms: an **automated** matrix that runs in CI, and a **manual** on-device
runbook for the parts a fake browser cannot prove (real replays, real
network waterfalls, real masking).

## Chaos hooks

`window.__gpChaos` is read by `js/viewer-ui.js` and is **inert anywhere but
a dev host** — `imagery.js#chaosAllowed()` accepts only `localhost`,
`127.0.0.1`, `::1` and the empty hostname (`file://`). There is no query
parameter and no build flag: a production page cannot be talked into
failing, and `tests/imagery.test.js` pins that (including near-miss hosts
like `evil.localhost.com`).

```js
// Paste into the console on http://localhost:8000/host.html
window.__gpChaos = {
  // Replace moveTo. Return a promise; null/undefined falls through to the SDK.
  moveTo: (imageId, purpose) =>
    Promise.reject(new Error("Image 1234567890123456 does not exist")),

  timeoutMs: 500,        // shorten the 20s/10s budget so a timeout is testable
  failInit: true,        // make `new mapillary.Viewer` throw
  webglUnsupported: true,// make mapillary.isSupported() return false
  offline: true,         // force the classifier's online:false branch
};

// Live viewers, for dispatching real canvas events:
window.__gpViewers[0].viewer            // the raw MapillaryJS viewer
document.querySelector("#hostViewer canvas")
  .dispatchEvent(new Event("webglcontextlost"));
```

Serve locally with any static server (`python3 -m http.server 8000`), accept
the consent banner, and watch the PostHog live-events view.

## Automated matrix (`npm test`)

`tests/viewer-ui.test.js` stands up a fake browser (DOM, navigator,
performance, a fake posthog and a fake MapillaryJS) and drives the same
`__gpChaos` hooks, so the matrix is a regression suite rather than a
one-time checklist. Results as of the implementation commit — 24/24 passing:

| # | Scenario | Injection | Asserted outcome | Result |
|---|---|---|---|---|
| A | Rejected `moveTo` | `moveTo` rejects "does not exist" | `imagery_load{ok:false, error_class:image_dead}`; one `$exception` whose message is our scrubbed `ImageryError` (no image id); `pool_entry` matches on both; the **original** error is rethrown so the caller's catch is unchanged; recording forced | ✅ pass |
| B | Timeout | `moveTo` never settles, `timeoutMs: 5` | rejects with "timed out"; classified `network_timeout`; `duration_ms` recorded; viewer **not** torn down | ✅ pass |
| B′ | Late success | settles 40 ms after a 5 ms budget | a second `imagery_load{ok:true, after_timeout:true}` corrects the record | ✅ pass |
| C | 429 | `moveTo` rejects "status 429" | `http_rate_limit` on both event and exception | ✅ pass |
| D | Chaos inert in production | hostname `geoparty.example` | injection ignored, real path runs, `window.__gpViewers` never created | ✅ pass |
| D′ | PostHog blocked | loader rejects (`tests/analytics.test.js`) | nothing throws, capture silently off, report flow shows the §10.3 failure copy (`tests/report-ui.test.js`) | ✅ pass |
| E | Offline mid-round | `navigator.onLine = false` | `network_offline`, `online:false` on the event | ✅ pass |
| F | No neighbours | `navigable:false` + a nav `moveTo` rejecting "No navigable edges" | `no_neighbors`; `pano_session{nav_available:false, nav_failures:1}` | ✅ pass |
| G | Handled skip loop | 2 dead ids then a live one | **one** `imagery_load{ok:true, skips:2}` for the whole loop; cursor left on the entry that loaded; recording forced at skips≥2 | ✅ pass |
| G′ | Dedup | the same entry retried 3× | exactly **one** `image_dead` exception | ✅ pass |
| G″ | Pool exhausted | every id dead | `imagery_load{ok:false, skips:3}`, `entry:null` → the caller's existing "pool exhausted" path | ✅ pass |
| — | `cancelled` | "cancelled by a newer request" | counted as an event, **never** an exception, no forced recording | ✅ pass |
| — | No WebGL | `isSupported() → false` | `viewer_init{ok:false, webgl:false, error_class:webgl_unavailable}`; a stub viewer whose `moveTo` always rejects; the skip loop short-circuits **without consuming a single pool entry** | ✅ pass |
| — | Constructor throws | `failInit` | classified `viewer_init`, exception captured | ✅ pass |
| — | `webglcontextlost` | dispatched on the canvas | `webgl_context_lost` exception + forced recording | ✅ pass |
| — | Privacy | successful load of a real 16-digit id | the raw image id appears in **no** captured property (whole capture buffer scanned) | ✅ pass |

Adjacent suites: `tests/imagery.test.js` (52) covers one classifier fixture
per taxonomy class, the scrubbers against 200 real pool ids, a
**collision-free diag id over all 5,312 pool entries**, the caps, the fold
and the health classifier; `tests/analytics.test.js` (80) covers the consent
gate on `trackError`, the one-shot diagnostic path and the `before_send` /
network sanitizers; `tests/report-ui.test.js` (13) covers the report sheet
including the decliner branch.

## Dead entry vs transient failure — the `degraded` retry contract

`loadRoundImage` distinguishes two kinds of round-start failure, because they
must be handled differently (stabilization: review P1-3, P2-1, P2-5):

- **A provably dead entry** (`image_dead` — a 404 / "does not exist" / "not
  found") is a property of the *content*: it is dead for everyone, so the
  seeded sampler **skips** it deterministically. Every device on the same seed
  skips the same entry to the same next spot, which is what keeps the Daily's
  "same five for everyone" intact.
- **Any other failure** (`network_timeout`, `network_offline`,
  `http_rate_limit`, `http_server`, `http_auth`, `webgl_*`, `sdk_unknown`, or a
  **stub viewer** with `iv.ok === false`) is transient or environmental — a
  property of *this device/moment*, not of the entry. Advancing the seeded
  sampler past a **live** entry on a slow-network timeout would silently give
  that device a different location than everyone else (the old P2-5 bug), and
  grinding the whole pool on a stub viewer would zero a Daily run at score 0
  (P1-3). So `loadRoundImage` keeps the same entry, consumes nothing, and
  returns `{ entry: null, degraded: true }`.

The `degraded` flag is the caller contract. On `degraded: true` no caller may
finish a Daily run, `finishGame()` a couch game, or push `{phase:"gameOver"}`
to an h2h room — each shows a retryable "couldn't load the imagery, nothing
was counted" overlay instead. Only a genuinely exhausted pool (every remaining
entry provably dead) returns `{ entry: null, degraded: false }`, which is the
sole null-entry case the finish/end paths act on. Covered by the
`degraded` scenarios in `tests/viewer-ui.test.js`.

## Manual on-device runbook (what CI cannot prove)

> Manual on-device runbook: **not yet executed on a real device** as of
> 2026-08-20 — no dated results recorded (required by the EM review §8
> item 5 and stabilization review §5 condition 2).

Run once before trusting the dashboard, on a real phone, consent accepted:

1. **Chain proof (B and G).** Force a dead-image round. In PostHog:
   issue → its `$exception` carries `error_class` / `pool_entry` /
   `release` → the linked **replay** shows the round, the synced **console**
   warn (`Pool entry k3x9q0ar failed…`) and the Mapillary request in the
   **network waterfall** with status and timing → panels 1/3/5 move →
   `node tools/diag_lookup.mjs <pool_entry>` names the real entry locally.
2. **Learning-mode proof.** Play one fully healthy round. A replay appears
   with no failure trigger firing, the session classifies healthy, and
   panel 12 counts it.
3. **Masking proof.** Walk `docs/replay-mask-checklist.md` §5 against that
   recording — masked names/codes/place, blank canvas, blocked maps, no
   `access_token`, no OSM tile rows.
4. **Kill switch.** Turn the `replay-imagery-debug` flag (id 255025) off and
   confirm a second session records nothing. Turn it back on.
5. **Release stamp.** Confirm events carry `release` = the deployed short
   SHA within 5 minutes of a deploy.
6. **Scenario C properly.** DevTools local override on
   `graph.mapillary.com` → 429, to confirm the real SDK message shape
   classifies as `http_rate_limit` (the fixture is our best reading of it).
7. **Scenario D properly.** Block `eu-assets.i.posthog.com` in an ad
   blocker: the game is unaffected and the report sheet shows "Couldn't
   send the report". Separately block `unpkg.com`: the landing degrades to
   its gradient exactly as before.
