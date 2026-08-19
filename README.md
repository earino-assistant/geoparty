# GeoParty

A Jackbox-style geoguessing party game. One person (the operator) drives
street-level imagery from their phone. Everyone else watches a TV showing a
clean spectator view of the same imagery and shouts suggestions. The operator
drops a guess on a map, the TV reveals the true location, and points are
awarded by distance.

The entire system is static JavaScript synced through Firebase Realtime
Database. No server code, no build step, no cost.

There are two modes. **Couch mode** (the original): one operator phone
drives, the couch watches the TV. **Head-to-head**: every team plays on its
own phone — the same location drops for everyone at once, each team roams
and guesses at its own pace, the TV splits into one live panel per team,
and when the last team locks in, a countdown fires and every pin lands on
one full-screen reveal map. The winning team's phone inherits host duties
for the next game.

## How it works

- **`player.html`** — the head-to-head team phone. The first phone creates
  the room (its team is the host); up to three more join via QR/room code
  and claim team slots. Each phone writes only its own team's paths
  (`round/live/<team>`, `round/results/<team>`, `teams/<team>`), scores
  itself from the truth embedded in the round, and whichever phone submits
  last flips the room to reveal. When a game ends, host authority rotates
  to the winner (`hostTeam`), whose phone spawns the next room; everyone
  else — and the TV — follows the `nextRoom` pointer automatically.
- **`host.html`** — the operator's phone controller. Creates a room, drives
  the MapillaryJS street imagery, places the guess pin on a Leaflet map,
  computes the score, and writes all game state to
  `rooms/{roomCode}` in Firebase. The host is the single source of truth.
- **`screen.html`** — the TV spectator display. A pure subscriber that renders
  whatever state it receives. It writes nothing except its own
  `screenHeartbeat` every 10 seconds. Reach the TV via Chrome tab casting, a
  smart TV browser, or a Fire Stick — it's just a URL.
- **`index.html`** — the one front door: a hero landing with a single
  "Start a party" CTA (the host picks *"Everyone on their own phone"* or
  *"One phone + the TV"*) and one code-entry join path that reads the
  room's mode and routes to the right page automatically. The TV is an
  in-lobby / footer "Add a TV" affordance, not a top-level choice.

Scoring is GeoGuessr-style exponential decay: `round(5000 * exp(-d / 1492))`
with `d` the haversine great-circle distance in km. Perfect pin is 5000;
~1500 km is roughly 1800; antipodal is effectively 0.

## Running a game

1. Open `host.html` on your phone. Pick rounds (3/5/10), the round timer
   (60/120/180s or no limit), movement mode ("no moving" locks navigation but
   allows look-around), and 1–4 teams. Tap **New Game**.
2. Open `screen.html` on the TV (or cast a laptop tab showing it). Enter the
   6-letter room code — or scan the QR from the host's phone, which encodes
   `screen.html?room=CODE` so no typing is needed.
3. When the host shows "Screen connected", start the round. Pan (and move, if
   allowed) around the pano; the TV mirrors you with a slight lag.
4. Tap **Make Guess**, drop a pin on the world map, confirm. The TV plays the
   reveal: the line draws from guess to answer, the score counts up.
5. After the last round: podium, confetti, and **Save to leaderboard**.

## Local development

Serve the directory with any static file server (ES modules don't run from
`file://`):

```sh
python3 -m http.server 8000
# then http://localhost:8000/host.html and http://localhost:8000/screen.html
```

There is no build step. Libraries (MapillaryJS 4.1.2, Leaflet 1.9.4, Firebase
JS SDK 10.12.2) load from pinned CDN URLs; the Leaflet and MapillaryJS tags
carry SRI integrity hashes, so bumping a version means updating the hash in
all three HTML pages (`openssl dgst -sha384 -binary | openssl base64 -A`
over the new file).

## Tests & CI

The pure logic layer (`js/game.js`, `js/h2h.js`, `js/pool.js`, `js/qr.js`)
is covered by a dependency-free test suite using Node's built-in runner —
scoring, the time bonus, phase machines, turn rotation, reveal ordering,
winner tie-breaks, the seeded shuffle/resume contract, QR encoding, and an
integrity check over `data/location_pool.json`:

```sh
npm test        # node --test tests/*.test.js — no install needed
npm run check   # node --check every module (catches syntax errors in the UI files)
```

Both run in CI on every push and pull request
(`.github/workflows/ci.yml`). There is still no build step and no runtime
dependency — `package.json` exists only to name the test scripts and mark
the repo as ESM for Node.

For a map of the data model, write-ownership rules, and concurrency
invariants, see [`docs/architecture.md`](docs/architecture.md).

## Privacy & analytics

Product analytics run on PostHog Cloud EU behind **GDPR opt-in consent**:
the PostHog script is not even loaded until a visitor accepts the banner,
only aggregate metrics are sent (distances, scores, times, mode, team
counts — never coordinates, names, or identities), and the choice can be
changed anytime via the 🍪 control on every page. The event schema is a
hard allowlist in `js/analytics.js`, unit-tested in
`tests/analytics.test.js`. See [`PRIVACY.md`](PRIVACY.md) for the policy
and [`docs/analytics.md`](docs/analytics.md) for the event/KPI catalog.
One manual dashboard step: enable *"Discard client IP data"* in the
PostHog project settings.

## Deployment (GitHub Pages)

1. Create a public GitHub repo `geoparty` and push this directory to `main`.
2. Repo Settings → Pages → deploy from branch `main`, root.
3. The site serves at `https://<owner>.github.io/geoparty/`. All asset paths
   in the repo are relative, so subpath serving works as-is.

## Firebase security rules (manual step — do this once)

Paste these into the Firebase console (Realtime Database → Rules tab) and
publish:

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
    }
  }
}
```

These rules scope the otherwise-open database to room paths, validate the
room-code shape, and let anyone clean up rooms older than 24 hours. They are
**deliberately permissive within `rooms/`**: this is a party game with public
client credentials, and the threat model is drive-by vandalism, not
adversaries. Anyone who knows (or guesses) a room code can read or overwrite
that room while it is under 24 hours old. We accept that residual risk — worst
case, someone griefs a party game round.

The `+ 300000` on `createdAt` allows 5 minutes of client clock skew:
clients stamp `createdAt` with `Date.now()`, and without the tolerance a
phone whose clock runs ahead of Firebase's would have every room-creation
write silently rejected (the write is fire-and-forget, so the host would
play on locally while nobody could ever join). If you published the
earlier, stricter rule, paste this version over it and publish again.

The Firebase and Mapillary credentials committed in `config.js` are
client-side identifiers designed to be embedded and public.

## Location pool

Rounds draw from `data/location_pool.json` — pregenerated, verified Mapillary
360° pano locations. The pool is shuffled once per game (Fisher–Yates seeded
from the room code, so a resumed host sees the same order) and sampled without
replacement. If an image has been deleted from Mapillary since generation, the
host skips to the next entry silently.

To regenerate the pool:

```sh
pip install requests
cd data
python3 ../tools/build_location_pool.py --count 200 --mode weighted
# or --mode wild for fully random globe sampling (slower, more exotic)
```

The generator queries the Mapillary Graph API for recent (2018+) panoramic
imagery, dedupes on ~10 km grid cells, and in `weighted` mode favors regions
with dense coverage.

Each pool entry also carries a human-readable `name` ("Yakutsk, Russia") that
the reveal shows on screen and host. Names are reverse-geocoded **once, at
pool-build time** via Nominatim (never at reveal time — gameplay makes no
geocoding calls). After regenerating or hand-editing the pool, fill in names
for the new entries with:

```sh
python3 tools/name_location_pool.py   # from the repo root; ~1 req/sec, idempotent
```

`tools/topup_location_pool.py` runs this step automatically. Entries without a
`name` still work — the reveal simply shows no place name (host shows "—").

## Persistent leaderboard

The all-time top 10 lives in `localStorage` on the **host device** (key
`geoparty_leaderboard`), appended when the operator taps "Save to leaderboard"
at game over. There's no sync and no accounts — and note that **clearing the
browser's site data clears the leaderboard history**.

## Edge cases handled

- **Host refresh / phone sleep** — the host page offers Resume for a room
  under 24h old and reattaches as authority.
- **Screen refresh** — stateless; re-enter via the URL param and rendering
  resumes from current state (the URL is kept in sync with the room the
  screen is currently watching).
- **Next game** — when the host starts a new game after game over, the new
  room's code is written as a `nextRoom` pointer into the finished room; the
  still-subscribed screen follows into the new game automatically. The
  game-over screen also has a "New game — enter a room code" button back to
  the room-code entry state as a fallback.
- **Firebase unreachable** — both views show a "reconnecting" pill; the host
  can keep playing in degraded single-screen mode (viewer + guess map on the
  phone).
- **Stale rooms** — the host setup screen best-effort deletes rooms this
  device created that are older than 24h.
