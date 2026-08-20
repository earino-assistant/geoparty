# Privacy

GeoParty is a static party game: no accounts, no logins, no server of ours.
This page explains the two places any data goes and how to opt out.

## Analytics (opt-in only)

We use [PostHog](https://posthog.com) to understand how the game is played —
which mode people pick, how many rounds get finished, how close and how fast
guesses are — so we can make better product decisions.

**Nothing is collected unless you explicitly accept the consent banner.**
Until you tap "Sounds good", the PostHog script is not even loaded. (The
banner waits for a calm moment on the game pages — it never lands on top of
a join form or a running round — but that is only about *when* you are
asked. Nothing loads, fires or records before your accept either way.) If you
decline, the only thing stored is your "no" (a `localStorage` flag on your
device), and no analytics code ever runs.

What we collect after opt-in, per event, is a short allowlist of aggregate
numbers enforced in code (`js/analytics.js`):

- game setup: mode (couch / head-to-head), team count, round count, seconds
  per round;
- outcomes: guess distance in km, points, time bonus, seconds taken, winner
  slot and score;
- the random 6-letter room code (ephemeral — rooms are deleted within 24
  hours) and standard web analytics (page views, button clicks);
- **technical diagnostics** so we can fix broken street imagery: whether a
  panorama loaded, how many milliseconds it took, an error category (e.g.
  "timed out", "image no longer exists"), your connection type
  (`4g`/`3g`/…), whether WebGL works, counts of how often you looked
  around / zoomed / moved down the street, and the version of GeoParty you
  were running. Locations are referenced only by an **opaque 8-character
  code** derived from the pool entry (e.g. `k3x9q0ar`) — never a
  coordinate, never the Mapillary image id;
- **crash and error reports**: unhandled JavaScript errors, with URLs and
  long numeric ids stripped out of the message and stack before sending;
- **page speed** (Web Vitals: LCP, CLS, INP, FCP).

### Session replay

After you opt in — and **only** after you opt in — we also record an
anonymised replay of the GeoParty screens you see, so that when imagery
breaks we can watch what actually happened instead of guessing. What that
recording does and does not contain is fixed in code (`js/analytics.js`):

- **Everything you type is masked**, always — team names, room codes typed
  into a join box, anything else. Elements that render a team name, a room
  code or a place name are explicitly masked too.
- **The street imagery is never recorded.** The panorama is a WebGL canvas
  and canvas recording is off, so it appears as a blank box.
- **The maps are never recorded.** Map tiles are blocked outright, because
  a map tile's address *is* a coordinate — recording them would leak both
  the round's answer and where you were aiming.
- **Network activity is timing only**: request path, status and duration,
  for a short allowlist of hosts. No headers, no request or response
  bodies, no query strings (which is where access tokens live), and map
  tile requests are dropped entirely.
- Browser console messages are captured, because that is where the imagery
  errors show up; our own log lines reference the opaque pool code, never a
  real image id.

Recording is governed by a remote switch we can turn off at any time, and
it stops the moment you revoke consent. If you never accepted, **no replay
of any kind is ever made** — there is no sampled, partial or
failure-triggered exception to that.

### One-time diagnostic reports (if you declined)

If you declined analytics and then hit an image problem, GeoParty may offer
a **Report** action. Tapping it opens a dialog that explains exactly what
would be sent and asks you again. Nothing is sent unless you tap *Send one
report* in that dialog.

That path sends **exactly one** report — the same technical diagnostics
listed above, plus a reference code you can quote to us — and then stops.
It uses in-memory storage only (no cookies, nothing written to your
device), it never records a replay, and **it does not change your stored
"no"**: you remain opted out afterwards. It is the only way any data
leaves a declining user's device, and it takes two deliberate taps.

### Which version you were running

Events carry the short commit hash of the deployed build, so we can tell
"this broke in the release we shipped on Tuesday" from "this is always
broken". That is a fact about our code, not about you.

What we **never** collect:

- your map guesses or any coordinates — only the computed distance leaves
  your device, and coordinate-shaped properties are actively stripped;
- the Mapillary image id of any location you were shown (only the opaque
  pool code), the street imagery itself, or map tiles;
- team names or anything you type;
- HTTP headers, request/response bodies, URL query strings, or access
  tokens;
- your identity: there are no accounts, and PostHog runs with
  `person_profiles: 'identified_only'`, so anonymous visitors get no person
  profile. "Return play" is recognized only by PostHog's anonymous
  device-local id.

**Data residency:** our PostHog project is hosted on PostHog Cloud EU
(`eu.i.posthog.com`), so analytics data stays in the EU. The PostHog
project setting *"Discard client IP data"* is **enabled**, so IP addresses
are not stored with events — posthog-js has no client-side `mask_ip`
option; this lives in the project settings.

**Changing your mind:** tap the 🍪 button in the corner of any GeoParty page
to reopen the banner and accept or decline at any time. Revoking stops all
collection — including session replay — immediately (a single final
`consent_denied` event records the opt-out itself, with no other data
attached). That same panel is where you can report an image problem.

**Cookies/storage:** the consent flag lives in `localStorage`. PostHog sets
its own device-local storage/cookie *only after you accept*. Nothing else.

## Pool health checks (no users involved)

Once a week, an automated job asks Mapillary whether some of the locations
in our question pool still exist, and proposes removing the dead ones. It
measures our own game content, not people: no user data is read, sent or
involved, and it runs whether or not anyone has opted in to anything.

## Game sync (not analytics)

Live rooms are synced through Firebase Realtime Database (EU region,
`europe-west1`): room code, game phase, team names you enter, guesses and
scores — the shared game state the TV and phones need. Rooms are deleted
within 24 hours. Street-level imagery is served by Mapillary and map tiles
by OpenStreetMap; your browser talks to them directly, subject to their own
privacy policies.
