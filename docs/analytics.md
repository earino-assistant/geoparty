# Analytics — events & KPIs

GeoParty uses [PostHog](https://posthog.com) (EU cloud) for product
analytics, gated behind **GDPR opt-in consent** — nothing loads or fires
until a user explicitly accepts the banner. See `PRIVACY.md` for the
user-facing policy and `js/analytics.js` / `js/consent.js` for the
implementation (unit-tested in `tests/analytics.test.js`).

## Architecture

- `js/analytics.js` — pure core, no DOM: consent flag, the event schema
  below (a hard allowlist — unknown events/properties/coordinate-shaped keys
  are dropped before anything is sent), and the gated tracker.
- `js/consent.js` — browser glue on every page: consent banner, the 🍪
  settings control, and the PostHog script loader (injected only after
  accept). Exports `track(event, props)`.
- Instrumented call sites live in `js/host-ui.js` (couch), `js/player-ui.js`
  (head-to-head), `js/screen-ui.js` (TV), `js/landing-ui.js` (the front
  door), `js/daily-ui.js` (the Daily Challenge), `js/share-ui.js` (the
  shared result-card glue), and `js/fx-ui.js` (the S4 sound toggle).
- **Field observability** (`docs/field-observability-plan.md`) adds a second
  pure module and one wrapper: `js/imagery.js` (error taxonomy, scrubbers,
  the opaque pool diag id, timeout/caps policy, the `pano_session` fold and
  the session-health classifier — all unit-tested in
  `tests/imagery.test.js`) and `js/viewer-ui.js`, the instrumented
  MapillaryJS wrapper every viewer on every page is now built through.
  `js/report-ui.js` is the "Report it" flow.
- `trackError(error, props)` is the exception twin of `track()`: identical
  consent gate, its own `EXCEPTION_PROPS` allowlist, and an Error object we
  construct ourselves (`makeImageryError`) so a raw SDK message can never
  carry an image id or a tokened URL into an issue title.
- `before_send` (`sanitizeBeforeSend`) scrubs query strings and runs of ≥10
  digits out of every URL property and exception frame on the way out —
  belt and braces over the schema allowlist.

### Session replay + exceptions (what is enabled, and why it is safe)

Both sit entirely behind the existing accept gate — posthog-js is not
loaded at all until the user taps "Sounds good", so a decliner produces no
event, no exception and no recording, ever.

| Setting | Value | Why |
|---|---|---|
| `capture_exceptions` | unhandled errors + rejections, `capture_console_errors: false` | unknown-unknowns become issues; our own warns stay out of the issue stream and show up in replay instead |
| `capture_performance.web_vitals` | on | a page-level baseline next to the viewer timings |
| `session_recording.maskAllInputs` | true | nothing typed is ever recorded |
| `session_recording.maskTextSelector` | `[data-ph-mask], .leaflet-tooltip` | team names, room codes, place names, map pin labels (checklist: `docs/replay-mask-checklist.md`) |
| `session_recording.blockSelector` | `.leaflet-container, [data-ph-block]` | **a map tile URL is a coordinate** — maps are blocked, not merely masked |
| `session_recording.captureCanvas` | false | the WebGL panorama (street imagery = a location proxy) is never recorded |
| `session_recording.recordHeaders` / `recordBody` | false | plus both are deleted defensively in `maskNetworkRequest` |
| `maskCapturedNetworkRequestFn` | `maskNetworkRequest` | timing/status/path only, host-allowlisted, query strings stripped (Mapillary tokens ride in query params) |
| `enable_recording_console_log` | true | the imagery story is in the console |

Project-side (PostHog project **252836**, EU): recording ON, sampling
**100%** (Stage-1 learning mode), minimum duration 2000 ms, console + network
performance capture ON, canvas recording OFF, exception autocapture ON,
**discard client IP ON**, recording linked to the `replay-imagery-debug`
feature flag (id 255025) — the remote kill switch.

PostHog init (owner-provided, verbatim): key
`phc_Au8ogwiWbfcWqhbP6iE8ayyT5JSQtambPHFSffykdvkE`, `api_host:
https://eu.i.posthog.com` (EU data residency), `defaults: '2026-05-30'`,
`person_profiles: 'identified_only'` (anonymous visitors get no person
profile). Autocapture is restricted to button/link clicks so user-entered
team names never ride along in `$el_text`.

## Events

`mode` is `"couch"` or `"h2h"` (`result_shared` adds `"daily"`). `room` is
the random 6-letter room code
(ephemeral, deleted within 24h — useful for stitching one game's events
together, identifies nobody). `team_id` is the slot id (`t1`–`t4`), never
the user-entered team name.

| Event | Properties | Fired from | When |
|---|---|---|---|
| `party_choice` | `choice` | landing page | "Start a party" chooser picked an experience: `phones` (everyone on their own phone → h2h) or `tv` (one phone + the TV → couch). Fires before any room exists — the gap to `game_created` is chooser→setup drop-off |
| `front_door_join` | `mode` | landing page | A room code entered at the landing (or a `?room=` link into it) was routed to its experience — `h2h` to the player page, `couch` to the screen page. Offline fallback routes count as `h2h` |
| `game_created` | `room, mode, num_teams, num_rounds, round_seconds, difficulty` | host phone | Room created (couch setup, h2h create, h2h next-game). `difficulty` (S3) is the host's pool setting: `casual` \| `world` \| `expert`. `room` is the join key that lets per-guess events be broken down by the room's difficulty (h2h guesses fire on other devices, so no person/device join can do it) |
| `team_joined` | `mode, team_count` | joining phone | h2h only: a phone claims a team slot (creator counts as team 1). Couch teams are configured on one phone — see `game_created.num_teams` |
| `screen_joined` | `room, mode, via` | TV | The screen page attaches to a room. `via` is how it got there: `qr` (lobby QR scanned — that device is usually then cast/AirPlayed to the TV) \| `link` (a shared TV link was opened) \| `typed` (code entered by hand: TV browser, front door, or direct visit) \| `follow` (auto-rejoined the host's next game) |
| `round_started` | `room, mode, round_number, advance, screen_attached` | host phone | Round pushed live (once per round per game). `advance` (S6) is how the round was reached from the previous reveal: `auto` (the soft auto-advance countdown fired) \| `manual` (host tapped Next Round). Absent on round 1, which no reveal precedes. `screen_attached` (S7, couch only) is whether a TV heartbeat was live when the round started — `false` is a game being played with the host phone as the shared screen |
| `guess_submitted` | `room, mode, team_id, distance_km, time_bonus, total_score, time_seconds, super_sure, moved` | guessing phone | A pin is confirmed/locked in. One event per team per round. `super_sure` is true when the pin carries the once-per-game SUPER SURE bet (`total_score` stays the **raw** round total — the ×2/0 lands in `super_sure_resolved`). `moved` is true when the pano was navigated off the round's anchor image before the pin (street movement got used — an image-id comparison on-device; no id or place ever leaves). Forfeits (h2h timeout with no pin) are **not** guesses and are not sent |
| `reveal_shown` | `room, mode, round_number` | host phone | Reveal reached (once per round, host-only, so cardinality matches `round_started`) |
| `super_sure_resolved` | `mode, round_number, rounds, outcome, round_total` | host phone | One event per SUPER SURE bet, at the reveal (same once-per-round discipline as `reveal_shown`). `outcome` is `won` \| `lost` \| `burned`; `round_total` is the raw round total at stake (0 when burned). Exists because a burned bet has no `guess_submitted` (a forfeit is not a guess) and win/lose is only known at reveal |
| `super_sure_sheet_opened` | `mode` | guessing phone | The 🔥 chip on the guess map was tapped and the SUPER SURE sheet opened. Added by the de-clutter pass (`docs/ui-ux-design-review.md` §6.1), which replaced an always-on labelled pill — unmissable, and shouting "double or nothing, once per game" through every round — with a chip you have to tap. `mode` is `h2h` \| `couch` (the Daily has no bet). Aggregates only: the sheet opens while the player is still aiming, so nothing about the pin may ride along |
| `auto_advance_hold` | `room, mode, round_number, seconds_left` | host phone | S6: the host held the soft auto-advance countdown open (wanted more time on the reveal). `seconds_left` is what remained of the countdown when held — the direct tuning signal for the 15s default (consistently small values mean it's too short; near-full values mean hosts reject the timer outright) |
| `game_completed` | `room, mode, rounds, winner_team, winning_score, team_count, advance` | host phone | Final round finished (incl. pool-exhaustion end). `advance` mirrors `round_started`: how the final reveal resolved to the scoreboard (`auto` \| `manual`; absent on pool-exhaustion ends, which skip the final reveal) |
| `game_abandoned` | `room, mode, rounds_played` | host phone | Host explicitly abandons the room |
| `invite_shared` | `mode, method` | lobby phone | h2h lobby "Send invite link" used; `method` is `share` (Web Share sheet opened without error) or `copy` (clipboard fallback). The remote-play (no shared TV) recruitment path |
| `tv_link_shared` | `mode, method` | lobby phone | The lobby "Send the TV link" affordance was used (both modes); `method` mirrors `invite_shared`. Top of the link path of TV Attach; the bottom is `screen_joined` with `via=link` |
| `result_shared` | `mode, method` | game-over screen / daily done screen | S1: a post-game result card left the app. `mode` is `couch` \| `h2h` \| `daily`; `method` mirrors `invite_shared`. The card's **text** (score, closest distance, place name) and link never ride on the event — inbound attribution uses the link's UTM tags instead (see KPIs) |
| `daily_challenge_started` | `day_number` | daily page | S2: "Play Today's Daily" pressed and the seeded run began. `day_number` is the public puzzle index ("Daily #37") — a calendar fact, not an identity |
| `daily_challenge_completed` | `day_number, score, rounds_played, best_distance_km` | daily page | All five rounds resolved (forfeits included). `rounds_played` counts rounds that landed a pin (0–5); `best_distance_km` is the run's closest guess, absent when every round forfeited. The started→completed gap is mid-run bail-out |
| `sound_toggled` | `surface, enabled` | 🔊/🔇 corner toggle (all game pages) | S4: the sound toggle was tapped. `surface` is `host` \| `player` \| `tv` \| `daily`; `enabled` is the state **after** the tap. Defaults are muted on phones and ON on the TV, so phone→on taps measure demand for sound where we mute it, and tv→off taps measure rejection where we impose it — both direct reads on the §2.4 "silence feels unfinished" hypothesis |
| `pwa_launch` | — | landing page | S5: the page opened in an installed-app display mode (`standalone`/`fullscreen`/`minimal-ui`, or iOS's `navigator.standalone`) — i.e. launched from a home-screen icon, not a browser tab. Fires once per launch: the manifest's `start_url` is the landing, and in-scope navigation stays in the same app window. Deliberately propertyless — the launch itself is the signal |
| `consent_given` | — | consent module | Banner accepted (first event after PostHog init) |
| `consent_denied` | — | consent module | A previously-consented user revokes. A **first-time** decline sends nothing — PostHog was never loaded, by design |
| `next_game` | `mode` | host phone | "New game" chosen from the game-over screen |
| `viewer_init` | `surface, ok, error_class, duration_ms, webgl, sdk` | every page with a panorama | One per `createViewer()` call. `surface` is `host` \| `player` \| `tv` \| `tv_panel` \| `daily` \| `landing`. `ok=false` carries the §5 `error_class` (`webgl_unavailable`, `viewer_init`, …) and means the player got no viewer at all; `webgl` is `mapillary.isSupported()`; `sdk` is the pinned MapillaryJS tag |
| `imagery_load` | `surface, purpose, ok, after_timeout, error_class, duration_ms, skips, pool_entry, net_type, online` | the viewer wrapper | One per `moveTo` outcome, and one per round-start skip-loop resolution (the loop emits a single event carrying its `skips` count, not one per attempt). `purpose` is `anchor` \| `resume` \| `follow` \| `seed` \| `hero` \| `nav`. `pool_entry` is the **opaque** diag id (see below) — never the Mapillary image id, never a coordinate. `after_timeout` is the plan's `late`, renamed because `BANNED_KEY_RE` strips any key containing `lat` |
| `pano_session` | `surface, round_number, looks, zoom_changes, nav_moves, nav_failures, nav_available, reanchors, first_move_ms, pointer_downs` | the viewer wrapper | One per (surface, round), emitted when the round leaves play or the viewer is destroyed. `looks` are throttled pov bursts, `nav_moves` are image changes we did **not** ask for (the player walked), `reanchors` is the movement-bounce regression canary, and `pointer_downs > 0` with `looks = 0` is the only signal we have for `gesture_blocked` |
| `imagery_report` | `surface, ref_code, error_class, pool_entry, net_type, online, recent_failures, consent` | report sheet | One per user-initiated report. `ref_code` (`GP-XXXXXX`, Crockford base32) is the support reference code shown to the user; `consent` is `analytics` (already opted in) or `one_time` (the §10.4 explicit one-shot path, which never records a replay and never alters the stored decline) |

Plus PostHog defaults: `$pageview`, (button/link-only) autocapture,
`$exception` (autocaptured unhandled errors **and** our `trackError`
captures) and `$web_vitals`.

Every event, exception and replay also carries the release super properties
`release` (short SHA), `commit` and `deployed_at`, registered from
`release.json` — written into the Pages artifact at deploy time and absent
in a dev checkout, where `release` is simply `"dev"`.

### Retired: `deployment_channel`

`deployment_channel` (values `production` | `beta`) was a super property of
the removed beta deployment lane. It is gone from the code and the
`RELEASE_PROPS` allowlist (see `docs/beta-removal-plan.md`). Historical
events captured on production between the `4641a74` deploy (2026-08-20
15:54 UTC) and the removal deploy carry `deployment_channel: "production"` —
a stored property on past events, harmless and left as-is.

### `pool_entry` — correlating failures without coordinates

`imagery.js#poolDiagId(image_id)` is two salted FNV-1a passes folded to 41
bits and rendered as 8 base36 chars (`k3x9q0ar`). It lets us say "this same
pool entry failed for 6 people this week" while PostHog holds no coordinate
and no directly-reversible location key. The pool file is public in this
repo, so this is **pseudonymisation of game content, not a secret** — and
deliberately so: pool entries are content we chose, not user data. Nothing
derived from a *user's guess* is hashed or sent, in any form.

Map it back locally: `node tools/diag_lookup.mjs k3x9q0ar`.

## KPIs and where they come from

| KPI | Definition | Events |
|---|---|---|
| **Game Completion Rate** | `game_completed` ÷ `game_created` (trend: insight with both series; per-mode breakdown on `mode`) | `game_created`, `game_completed` |
| **Abandonment funnel** | Funnel `game_created → round_started → reveal_shown → game_completed`; the drop-off step shows *where* games die. `game_abandoned` (explicit) and its `rounds_played` show deliberate bail-outs; silent abandons (closed tab) appear as funnel drop-off, not as an event | `game_created`, `round_started`, `reveal_shown`, `game_completed`, `game_abandoned` |
| **Average Guess Distance** (accuracy) | Mean/median of `guess_submitted.distance_km`; break down by `mode` or `round_number`-joined data to see learning curves | `guess_submitted` |
| **Average Time-to-Guess** (speed) | Mean/median of `guess_submitted.time_seconds` (round start → pin locked); `time_bonus` shows how often speed actually pays | `guess_submitted` |
| **Street-movement usage** | Share of `guess_submitted` with `moved=true`, by `mode`: is walking the street actually part of play (it defaults on in every mode)? Also the regression canary for the movement-bounce fix — a collapse to ~0 means navigation is broken again, since a bounced viewer ends every round on its anchor image. Split `distance_km` by `moved` to see whether moving helps accuracy | `guess_submitted` |
| **Mode Adoption** | `game_created` broken down by `mode` (couch vs head-to-head); `screen_joined` by `mode` shows how often a TV is attached | `game_created`, `screen_joined` |
| **TV Attach path** | `screen_joined` broken down by `via` (`qr` \| `link` \| `typed` \| `follow`, first join per `room`): which "Add a TV" path actually attaches screens, i.e. was demoting the raw URL right and is scan-and-cast carrying the load? `tv_link_shared` vs `screen_joined[via=link]` is the sent-vs-opened gap of the link path | `screen_joined`, `tv_link_shared` |
| **Front-door conversion** (M1/M4) | Funnel landing `$pageview → party_choice → game_created` — did the one-CTA landing raise entry into the game? `party_choice.choice` mix is the leading indicator of Mode Adoption; `front_door_join` counts joiners using the unified code entry instead of a deep link | `party_choice`, `front_door_join`, `game_created` |
| **Rounds per game** | Average of `game_completed.rounds` (finished games) or count of `round_started` per `room` | `game_completed`, `round_started` |
| **Teams per game** | Average of `game_completed.team_count`; `team_joined.team_count` shows the h2h lobby fill curve | `game_completed`, `team_joined` |
| **Average session length** | PostHog's built-in session duration (Web analytics / Sessions) — no custom event needed | `$pageview` / autocapture |
| **Return sessions** | PostHog Retention insight on any event (e.g. `game_created`), keyed on the anonymous device id — same-device return play, no accounts | any |
| **Home-screen adoption** (S5) | The install KPI: `pwa_launch` unique devices per week is home-screen reach; PostHog Retention on `pwa_launch` (or `pwa_launch` → `game_created`/`daily_challenge_started` funnels) shows whether installed users actually return and play more than tab users. There is no reliable install event on iOS, so launches — not installs — are the measure | `pwa_launch` |
| **Consent rate** | `consent_given` count vs. total unique visitors is *not* measurable (declined visitors send nothing — that's the point). `consent_denied` counts revocations only | `consent_given`, `consent_denied` |
| **Remote-play adoption** | `invite_shared` count (and `method` split) shows the no-screen recruitment path being used; the share of h2h `game_completed` rooms with no matching `screen_joined` (join on `room`) is the fraction of games played with no TV at all | `invite_shared`, `team_joined`, `screen_joined`, `game_completed` |
| **Couch without a TV** (S7) | The roadmap KPI is couch `game_created → round_started` conversion — the gate removal should lift it. `round_started.screen_attached` (couch) splits the funnel by TV presence: the `false` share is no-TV couch adoption, and comparing completion (`round_started → game_completed`) across the split shows whether phone-as-screen games actually hold the room | `game_created`, `round_started`, `game_completed` |
| **SUPER SURE deployment** (M6) | Share of completed games where a bet was spent: `guess_submitted` with `super_sure` + `super_sure_resolved` counts vs `game_completed`. Judges whether the stakes mechanic gets used at all | `guess_submitted`, `super_sure_resolved`, `game_completed` |
| **SUPER SURE discoverability** (de-clutter §6.1) | The regression guard on demoting the pill to a chip: `super_sure_sheet_opened` unique rooms per `game_created`, and the ratio `super_sure_resolved ÷ super_sure_sheet_opened` (does the sheet actually convert curiosity into a bet, or does it teach better than the pill and produce *fewer, better* bets?). The ship-blocking number is the deployment KPI above: it must not drop | `super_sure_sheet_opened`, `super_sure_resolved`, `game_created` |
| **SUPER SURE win rate & EV** (M6) | `super_sure_resolved.outcome` mix (`won` share ≈ does it reward knowledge or just gambling?); mean signed swing = `round_total` for `won`, −`round_total` for `lost`, 0 for `burned` | `super_sure_resolved` |
| **SUPER SURE timing** (M6) | Distribution of `round_number ÷ rounds` — early confidence plays vs late hail-marys | `super_sure_resolved` |
| **Between-round tempo** (S6) | The dead-air KPI: time between `reveal_shown` and the next `round_started` in the same `room` (both host-phone events with matching cardinality — a PostHog funnel with time-to-convert, or HogQL on the event pair). S6 should pull the tail in. `round_started.advance` splits the mix: `auto` share = the timer is doing the advancing; `auto_advance_hold` count and its `seconds_left` distribution tune the 15s default | `reveal_shown`, `round_started`, `auto_advance_hold` |
| **Share → new rooms** (S1) | The card KPI: **new-room creations from shared links**. Every card link carries `utm_source=share` + `utm_campaign` (`couch` \| `h2h` \| `daily`); PostHog's defaults capture `utm_*` on `$pageview` and as session/person *entry* properties automatically, so no code reads them. Insight: `game_created` (and `daily_challenge_started`) filtered by session entry `utm_source = share`, broken down by `utm_campaign`. `result_shared` counts the top of that funnel (cards sent) | `result_shared`, `game_created`, `$pageview` |
| **Difficulty tiers** (S3) | The tier KPI: `guess_submitted.distance_km` spread broken down by the room's `game_created.difficulty` (HogQL join on `room`). Tiers should compress the spread within a chosen difficulty — Casual rooms tight and near, Expert rooms far — and round-1 distances should sit in Casual territory in **every** difficulty (the easy-first-round guard). `game_created` broken down by `difficulty` is the adoption mix (does anyone pick Expert?) | `game_created`, `guess_submitted` |
| **Sound opt-in/opt-out** (S4) | `sound_toggled` broken down by `surface` + `enabled`: phone `enabled=true` share is demand for sound where the default mutes it; TV `enabled=false` share is rejection of the default-on sting/ticks. S4's headline KPIs (session length, `game_completed` rate) are trend comparisons before/after the pass | `sound_toggled`, `game_completed` |
| **Daily actives & retention** (S2) | The ritual KPI: `daily_challenge_started` unique users per day (daily actives); PostHog Retention on `daily_challenge_started` (does the ritual bring people back?) and on `game_created` (does the daily feed the party game?). Completion rate = `daily_challenge_completed ÷ daily_challenge_started`; `score` / `best_distance_km` distributions calibrate difficulty day over day | `daily_challenge_started`, `daily_challenge_completed`, `game_created` |

### Field-reliability KPIs

| KPI | Definition | Events |
|---|---|---|
| **Imagery success rate** | Share of `imagery_load` with `ok=true`, excluding `error_class=cancelled` (a superseded `moveTo` is expected churn, not a failure). Trend + `surface` breakdown. Alerts at <97% (warn) and <90% (critical) | `imagery_load` |
| **Anchor load speed** | P50/P95 `imagery_load.duration_ms` where `purpose=anchor, ok=true`, by `net_type`/`$browser`/`$os`. The Stage-1 learning-mode exit report turns these into per-segment alert thresholds instead of guesses | `imagery_load` |
| **First playable pano rate** | "Round 1 just worked": share of anchor loads with `ok=true, skips=0, duration_ms<10000`. The single number that says whether the product's first impression survives | `imagery_load` |
| **Dead-entry tax** | Average `imagery_load.skips` per anchor and the share of rounds with `skips>0` — background pool decay. Feeds the weekly pool-health quarantine proposals | `imagery_load` |
| **Failure taxonomy mix** | `imagery_load` `ok=false` by `error_class`, and failure rate by `$browser`/`$os`/`net_type`: is this the world being flaky, or one browser being broken? | `imagery_load`, `$exception` |
| **Navigation health** | Share of `pano_session` with `nav_failures>0` or `nav_available=false` where movement is enabled; `nav_moves` is how often players actually walk. `reanchors>0` is the movement-bounce regression canary that complements `guess_submitted.moved` | `pano_session` |
| **Session health mix** | Share of sessions classified healthy / degraded / failed by `imagery.js#classifySessionHealth` (failed > degraded > healthy), trended by `release` and `surface`. A skip that still landed a pano is *degraded*, never failed — "failed" is reserved for a player who saw a broken game | all of the above |
| **Health-class comparison** | Healthy vs degraded vs failed side by side on load speed, skip rate, navigation use and round completion: do slow loads and skips actually bleed players, or do they play on? | all of the above, `reveal_shown` |
| **Release regression** | `$exception` count by `release`. A spike right after a deploy names its own culprit | `$exception` |
| **Reports** | `imagery_report` volume, and `ref_code` as the support lookup key: search the code → the event → its session → replay + issues + full event trail | `imagery_report` |

Dashboard: **Field reliability** (PostHog EU project 252836, dashboard
`905962`).

## Adding a new event

1. Add it to `EVENT_SCHEMA` in `js/analytics.js` — the schema is the
   allowlist; untyped or unlisted properties are stripped. Aggregates only:
   no coordinates, no user-entered text, nothing identifying.
2. Call `track("event_name", {...})` at the feature's decision point.
3. Add a schema/sanitizer test in `tests/analytics.test.js` and document the
   event + the KPI it feeds in the tables above.

(This is mandatory for every new feature — see `CLAUDE.md`.)
