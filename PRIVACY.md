# Privacy

GeoParty is a static party game: no accounts, no logins, no server of ours.
This page explains the two places any data goes and how to opt out.

## Analytics (opt-in only)

We use [PostHog](https://posthog.com) to understand how the game is played —
which mode people pick, how many rounds get finished, how close and how fast
guesses are — so we can make better product decisions.

**Nothing is collected unless you explicitly accept the consent banner.**
Until you tap "Sounds good", the PostHog script is not even loaded. If you
decline, the only thing stored is your "no" (a `localStorage` flag on your
device), and no analytics code ever runs.

What we collect after opt-in, per event, is a short allowlist of aggregate
numbers enforced in code (`js/analytics.js`):

- game setup: mode (couch / head-to-head), team count, round count, seconds
  per round;
- outcomes: guess distance in km, points, time bonus, seconds taken, winner
  slot and score;
- the random 6-letter room code (ephemeral — rooms are deleted within 24
  hours) and standard web analytics (page views, button clicks).

What we **never** collect:

- your map guesses or any coordinates — only the computed distance leaves
  your device, and coordinate-shaped properties are actively stripped;
- team names or anything you type;
- your identity: there are no accounts, and PostHog runs with
  `person_profiles: 'identified_only'`, so anonymous visitors get no person
  profile. "Return play" is recognized only by PostHog's anonymous
  device-local id.

**Data residency:** our PostHog project is hosted on PostHog Cloud EU
(`eu.i.posthog.com`), so analytics data stays in the EU. We additionally
recommend (and intend to keep) the PostHog project setting *"Discard client
IP data"* enabled, so IP addresses are not stored with events — posthog-js
has no client-side `mask_ip` option; this lives in the project settings.

**Changing your mind:** tap the 🍪 button in the corner of any GeoParty page
to reopen the banner and accept or decline at any time. Revoking stops all
collection immediately (a single final `consent_denied` event records the
opt-out itself, with no other data attached).

**Cookies/storage:** the consent flag lives in `localStorage`. PostHog sets
its own device-local storage/cookie *only after you accept*. Nothing else.

## Game sync (not analytics)

Live rooms are synced through Firebase Realtime Database (EU region,
`europe-west1`): room code, game phase, team names you enter, guesses and
scores — the shared game state the TV and phones need. Rooms are deleted
within 24 hours. Street-level imagery is served by Mapillary and map tiles
by OpenStreetMap; your browser talks to them directly, subject to their own
privacy policies.
