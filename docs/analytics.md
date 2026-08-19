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
  door), `js/daily-ui.js` (the Daily Challenge), and `js/share-ui.js` (the
  shared result-card glue).

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
| `game_created` | `mode, num_teams, num_rounds, round_seconds` | host phone | Room created (couch setup, h2h create, h2h next-game) |
| `team_joined` | `mode, team_count` | joining phone | h2h only: a phone claims a team slot (creator counts as team 1). Couch teams are configured on one phone — see `game_created.num_teams` |
| `screen_joined` | `room, mode, via` | TV | The screen page attaches to a room. `via` is how it got there: `qr` (lobby QR scanned — that device is usually then cast/AirPlayed to the TV) \| `link` (a shared TV link was opened) \| `typed` (code entered by hand: TV browser, front door, or direct visit) \| `follow` (auto-rejoined the host's next game) |
| `round_started` | `room, mode, round_number` | host phone | Round pushed live (once per round per game) |
| `guess_submitted` | `room, mode, team_id, distance_km, time_bonus, total_score, time_seconds, super_sure` | guessing phone | A pin is confirmed/locked in. One event per team per round. `super_sure` is true when the pin carries the once-per-game SUPER SURE bet (`total_score` stays the **raw** round total — the ×2/0 lands in `super_sure_resolved`). Forfeits (h2h timeout with no pin) are **not** guesses and are not sent |
| `reveal_shown` | `room, mode, round_number` | host phone | Reveal reached (once per round, host-only, so cardinality matches `round_started`) |
| `super_sure_resolved` | `mode, round_number, rounds, outcome, round_total` | host phone | One event per SUPER SURE bet, at the reveal (same once-per-round discipline as `reveal_shown`). `outcome` is `won` \| `lost` \| `burned`; `round_total` is the raw round total at stake (0 when burned). Exists because a burned bet has no `guess_submitted` (a forfeit is not a guess) and win/lose is only known at reveal |
| `game_completed` | `room, mode, rounds, winner_team, winning_score, team_count` | host phone | Final round finished (incl. pool-exhaustion end) |
| `game_abandoned` | `room, mode, rounds_played` | host phone | Host explicitly abandons the room |
| `invite_shared` | `mode, method` | lobby phone | h2h lobby "Send invite link" used; `method` is `share` (Web Share sheet opened without error) or `copy` (clipboard fallback). The remote-play (no shared TV) recruitment path |
| `tv_link_shared` | `mode, method` | lobby phone | The lobby "Send the TV link" affordance was used (both modes); `method` mirrors `invite_shared`. Top of the link path of TV Attach; the bottom is `screen_joined` with `via=link` |
| `result_shared` | `mode, method` | game-over screen / daily done screen | S1: a post-game result card left the app. `mode` is `couch` \| `h2h` \| `daily`; `method` mirrors `invite_shared`. The card's **text** (score, closest distance, place name) and link never ride on the event — inbound attribution uses the link's UTM tags instead (see KPIs) |
| `daily_challenge_started` | `day_number` | daily page | S2: "Play Today's Daily" pressed and the seeded run began. `day_number` is the public puzzle index ("Daily #37") — a calendar fact, not an identity |
| `daily_challenge_completed` | `day_number, score, rounds_played, best_distance_km` | daily page | All five rounds resolved (forfeits included). `rounds_played` counts rounds that landed a pin (0–5); `best_distance_km` is the run's closest guess, absent when every round forfeited. The started→completed gap is mid-run bail-out |
| `consent_given` | — | consent module | Banner accepted (first event after PostHog init) |
| `consent_denied` | — | consent module | A previously-consented user revokes. A **first-time** decline sends nothing — PostHog was never loaded, by design |
| `next_game` | `mode` | host phone | "New game" chosen from the game-over screen |

Plus PostHog defaults: `$pageview` and (button/link-only) autocapture.

## KPIs and where they come from

| KPI | Definition | Events |
|---|---|---|
| **Game Completion Rate** | `game_completed` ÷ `game_created` (trend: insight with both series; per-mode breakdown on `mode`) | `game_created`, `game_completed` |
| **Abandonment funnel** | Funnel `game_created → round_started → reveal_shown → game_completed`; the drop-off step shows *where* games die. `game_abandoned` (explicit) and its `rounds_played` show deliberate bail-outs; silent abandons (closed tab) appear as funnel drop-off, not as an event | `game_created`, `round_started`, `reveal_shown`, `game_completed`, `game_abandoned` |
| **Average Guess Distance** (accuracy) | Mean/median of `guess_submitted.distance_km`; break down by `mode` or `round_number`-joined data to see learning curves | `guess_submitted` |
| **Average Time-to-Guess** (speed) | Mean/median of `guess_submitted.time_seconds` (round start → pin locked); `time_bonus` shows how often speed actually pays | `guess_submitted` |
| **Mode Adoption** | `game_created` broken down by `mode` (couch vs head-to-head); `screen_joined` by `mode` shows how often a TV is attached | `game_created`, `screen_joined` |
| **TV Attach path** | `screen_joined` broken down by `via` (`qr` \| `link` \| `typed` \| `follow`, first join per `room`): which "Add a TV" path actually attaches screens, i.e. was demoting the raw URL right and is scan-and-cast carrying the load? `tv_link_shared` vs `screen_joined[via=link]` is the sent-vs-opened gap of the link path | `screen_joined`, `tv_link_shared` |
| **Front-door conversion** (M1/M4) | Funnel landing `$pageview → party_choice → game_created` — did the one-CTA landing raise entry into the game? `party_choice.choice` mix is the leading indicator of Mode Adoption; `front_door_join` counts joiners using the unified code entry instead of a deep link | `party_choice`, `front_door_join`, `game_created` |
| **Rounds per game** | Average of `game_completed.rounds` (finished games) or count of `round_started` per `room` | `game_completed`, `round_started` |
| **Teams per game** | Average of `game_completed.team_count`; `team_joined.team_count` shows the h2h lobby fill curve | `game_completed`, `team_joined` |
| **Average session length** | PostHog's built-in session duration (Web analytics / Sessions) — no custom event needed | `$pageview` / autocapture |
| **Return sessions** | PostHog Retention insight on any event (e.g. `game_created`), keyed on the anonymous device id — same-device return play, no accounts | any |
| **Consent rate** | `consent_given` count vs. total unique visitors is *not* measurable (declined visitors send nothing — that's the point). `consent_denied` counts revocations only | `consent_given`, `consent_denied` |
| **Remote-play adoption** | `invite_shared` count (and `method` split) shows the no-screen recruitment path being used; the share of h2h `game_completed` rooms with no matching `screen_joined` (join on `room`) is the fraction of games played with no TV at all | `invite_shared`, `team_joined`, `screen_joined`, `game_completed` |
| **SUPER SURE deployment** (M6) | Share of completed games where a bet was spent: `guess_submitted` with `super_sure` + `super_sure_resolved` counts vs `game_completed`. Judges whether the stakes mechanic gets used at all | `guess_submitted`, `super_sure_resolved`, `game_completed` |
| **SUPER SURE win rate & EV** (M6) | `super_sure_resolved.outcome` mix (`won` share ≈ does it reward knowledge or just gambling?); mean signed swing = `round_total` for `won`, −`round_total` for `lost`, 0 for `burned` | `super_sure_resolved` |
| **SUPER SURE timing** (M6) | Distribution of `round_number ÷ rounds` — early confidence plays vs late hail-marys | `super_sure_resolved` |
| **Share → new rooms** (S1) | The card KPI: **new-room creations from shared links**. Every card link carries `utm_source=share` + `utm_campaign` (`couch` \| `h2h` \| `daily`); PostHog's defaults capture `utm_*` on `$pageview` and as session/person *entry* properties automatically, so no code reads them. Insight: `game_created` (and `daily_challenge_started`) filtered by session entry `utm_source = share`, broken down by `utm_campaign`. `result_shared` counts the top of that funnel (cards sent) | `result_shared`, `game_created`, `$pageview` |
| **Daily actives & retention** (S2) | The ritual KPI: `daily_challenge_started` unique users per day (daily actives); PostHog Retention on `daily_challenge_started` (does the ritual bring people back?) and on `game_created` (does the daily feed the party game?). Completion rate = `daily_challenge_completed ÷ daily_challenge_started`; `score` / `best_distance_km` distributions calibrate difficulty day over day | `daily_challenge_started`, `daily_challenge_completed`, `game_created` |

## Adding a new event

1. Add it to `EVENT_SCHEMA` in `js/analytics.js` — the schema is the
   allowlist; untyped or unlisted properties are stripped. Aggregates only:
   no coordinates, no user-entered text, nothing identifying.
2. Call `track("event_name", {...})` at the feature's decision point.
3. Add a schema/sanitizer test in `tests/analytics.test.js` and document the
   event + the KPI it feeds in the tables above.

(This is mandatory for every new feature — see `CLAUDE.md`.)
