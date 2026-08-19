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
  (head-to-head), and `js/screen-ui.js` (TV).

PostHog init (owner-provided, verbatim): key
`phc_Au8ogwiWbfcWqhbP6iE8ayyT5JSQtambPHFSffykdvkE`, `api_host:
https://eu.i.posthog.com` (EU data residency), `defaults: '2026-05-30'`,
`person_profiles: 'identified_only'` (anonymous visitors get no person
profile). Autocapture is restricted to button/link clicks so user-entered
team names never ride along in `$el_text`.

## Events

`mode` is `"couch"` or `"h2h"`. `room` is the random 6-letter room code
(ephemeral, deleted within 24h — useful for stitching one game's events
together, identifies nobody). `team_id` is the slot id (`t1`–`t4`), never
the user-entered team name.

| Event | Properties | Fired from | When |
|---|---|---|---|
| `game_created` | `mode, num_teams, num_rounds, round_seconds` | host phone | Room created (couch setup, h2h create, h2h next-game) |
| `team_joined` | `mode, team_count` | joining phone | h2h only: a phone claims a team slot (creator counts as team 1). Couch teams are configured on one phone — see `game_created.num_teams` |
| `screen_joined` | `room, mode` | TV | The screen page attaches to a room |
| `round_started` | `room, mode, round_number` | host phone | Round pushed live (once per round per game) |
| `guess_submitted` | `room, mode, team_id, distance_km, time_bonus, total_score, time_seconds, super_sure` | guessing phone | A pin is confirmed/locked in. One event per team per round. `super_sure` is true when the pin carries the once-per-game SUPER SURE bet (`total_score` stays the **raw** round total — the ×2/0 lands in `super_sure_resolved`). Forfeits (h2h timeout with no pin) are **not** guesses and are not sent |
| `reveal_shown` | `room, mode, round_number` | host phone | Reveal reached (once per round, host-only, so cardinality matches `round_started`) |
| `super_sure_resolved` | `mode, round_number, rounds, outcome, round_total` | host phone | One event per SUPER SURE bet, at the reveal (same once-per-round discipline as `reveal_shown`). `outcome` is `won` \| `lost` \| `burned`; `round_total` is the raw round total at stake (0 when burned). Exists because a burned bet has no `guess_submitted` (a forfeit is not a guess) and win/lose is only known at reveal |
| `game_completed` | `room, mode, rounds, winner_team, winning_score, team_count` | host phone | Final round finished (incl. pool-exhaustion end) |
| `game_abandoned` | `room, mode, rounds_played` | host phone | Host explicitly abandons the room |
| `invite_shared` | `mode, method` | lobby phone | h2h lobby "Send invite link" used; `method` is `share` (Web Share sheet opened without error) or `copy` (clipboard fallback). The remote-play (no shared TV) recruitment path |
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
| **Rounds per game** | Average of `game_completed.rounds` (finished games) or count of `round_started` per `room` | `game_completed`, `round_started` |
| **Teams per game** | Average of `game_completed.team_count`; `team_joined.team_count` shows the h2h lobby fill curve | `game_completed`, `team_joined` |
| **Average session length** | PostHog's built-in session duration (Web analytics / Sessions) — no custom event needed | `$pageview` / autocapture |
| **Return sessions** | PostHog Retention insight on any event (e.g. `game_created`), keyed on the anonymous device id — same-device return play, no accounts | any |
| **Consent rate** | `consent_given` count vs. total unique visitors is *not* measurable (declined visitors send nothing — that's the point). `consent_denied` counts revocations only | `consent_given`, `consent_denied` |
| **Remote-play adoption** | `invite_shared` count (and `method` split) shows the no-screen recruitment path being used; the share of h2h `game_completed` rooms with no matching `screen_joined` (join on `room`) is the fraction of games played with no TV at all | `invite_shared`, `team_joined`, `screen_joined`, `game_completed` |
| **SUPER SURE deployment** (M6) | Share of completed games where a bet was spent: `guess_submitted` with `super_sure` + `super_sure_resolved` counts vs `game_completed`. Judges whether the stakes mechanic gets used at all | `guess_submitted`, `super_sure_resolved`, `game_completed` |
| **SUPER SURE win rate & EV** (M6) | `super_sure_resolved.outcome` mix (`won` share ≈ does it reward knowledge or just gambling?); mean signed swing = `round_total` for `won`, −`round_total` for `lost`, 0 for `burned` | `super_sure_resolved` |
| **SUPER SURE timing** (M6) | Distribution of `round_number ÷ rounds` — early confidence plays vs late hail-marys | `super_sure_resolved` |

## Adding a new event

1. Add it to `EVENT_SCHEMA` in `js/analytics.js` — the schema is the
   allowlist; untyped or unlisted properties are stripped. Aggregates only:
   no coordinates, no user-entered text, nothing identifying.
2. Call `track("event_name", {...})` at the feature's decision point.
3. Add a schema/sanitizer test in `tests/analytics.test.js` and document the
   event + the KPI it feeds in the tables above.

(This is mandatory for every new feature — see `CLAUDE.md`.)
