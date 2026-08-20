# GeoParty — project rules for agents

Static, no-build Jackbox-style geoguessing party game (GitHub Pages). Plain
ES modules, no framework, no bundler, no runtime dependencies. Pure logic
lives in `js/game.js` / `js/h2h.js` / `js/pool.js` / `js/qr.js` /
`js/imagery.js` / `js/analytics.js` (no DOM, no network — these are the
unit-tested layer); DOM/Firebase glue lives in the `*-ui.js` modules and
`js/consent.js`.
Architecture: `docs/architecture.md`. Analytics catalog: `docs/analytics.md`.
Field observability: `docs/field-observability-plan.md`.

## MANDATORY: every feature ships with tests AND instrumentation

Any new feature or behavior change in this repo MUST include, in the same
change:

1. **Automated tests.** Put the decision logic in one of the pure modules
   (or a new pure module) and cover it in `tests/*.test.js` (Node's built-in
   runner; `npm test`). New logic without tests is an incomplete change. If
   a change is genuinely untestable (pure CSS, copy edits), say so
   explicitly in your summary — don't silently skip.

2. **PostHog event instrumentation.** Decide what product question the
   feature raises, then instrument it:
   - Add or extend an event in `EVENT_SCHEMA` (`js/analytics.js`) —
     the schema is a hard allowlist; an uninstrumented `track()` call is
     silently dropped, so schema + call site always change together.
   - Call `track("event_name", {...})` from the feature's decision point
     (see existing call sites in `host-ui.js` / `player-ui.js` /
     `screen-ui.js`).
   - Properties must be aggregates only: distances, counts, scores, times,
     mode, slot ids. NEVER coordinates, user-entered text (team names!),
     or anything identifying. The sanitizer strips coordinate-shaped keys,
     but do not rely on it — don't put them in the schema either (a test
     enforces this).
   - Add a sanitizer test in `tests/analytics.test.js` and document the
     event and the KPI it feeds in `docs/analytics.md`.
   - If an event genuinely adds no product signal, state that justification
     explicitly in your summary instead of instrumenting.

3. **Consent gating is inviolable.** All capture goes through `track()` or
   `trackError()` from `js/consent.js`. Never load or reference PostHog
   directly, never capture before opt-in, and never weaken the
   banner/revoke flow. The PostHog init key/options in `js/analytics.js`
   are owner-provided — don't change them. `POSTHOG_INIT_OPTIONS` must stay
   **mutable** (posthog-js writes onto it; a test enforces this).

   The single, deliberate exception is the §10.4 one-time diagnostic report
   (`sendDiagnostic`): user-initiated, explicitly consented in its own
   dialog, memory-only persistence, no replay, and it must **never** change
   the stored consent flag.

## MANDATORY: the imagery/viewer rules

- **Never construct `new mapillary.Viewer` or call `viewer.moveTo` in a
  page module.** Go through `createViewer()` / `iv.moveTo(id, purpose)` /
  `loadRoundImage()` in `js/viewer-ui.js`, or the failure becomes invisible
  again. Decision logic belongs in `js/imagery.js` (pure, tested).
- **Session replay masking is a ship-blocker, not a follow-up.** Any new
  screen that renders a team name, a room code or a place name needs
  `data-ph-mask`; any new map needs to fall under `blockSelector` (a tile
  URL is a coordinate). Update `docs/replay-mask-checklist.md` in the same
  change.
- **Nothing derived from a user's guess may be sent, hashed or otherwise.**
  Pool entries travel as the opaque `poolDiagId` only — never a raw
  Mapillary image id, never a coordinate.

Before finishing any change: `npm test` (all green) and `npm run check`
(every JS file must pass `node --check`). Both run in CI.

## Other constraints

- No build step, no npm dependencies, no server-side code. Everything must
  work served as static files (and degrade gracefully offline / file://).
- Don't touch `tools/` or `data/location_pool.json` unless the task is
  specifically about the location pool. `data/pool_quarantine.json` is
  written only by the weekly pool-health PR, which is never auto-merged.
- Third-party scripts are pinned with SRI where the asset is versioned
  (PostHog's `array.js` is unversioned and consent-gated instead).
- Public embeddable keys (Mapillary, Firebase, PostHog) live in client code
  by design; never add secret/server keys.
