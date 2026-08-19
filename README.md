# GeoParty

A Jackbox-style geoguessing party game. One person (the operator) drives
street-level imagery from their phone. Everyone else watches a TV showing a
clean spectator view of the same imagery and shouts suggestions. The operator
drops a guess on a map, the TV reveals the true location, and points are
awarded by distance.

The entire system is static JavaScript synced through Firebase Realtime
Database. No server code, no build step, no cost.

## How it works

- **`host.html`** — the operator's phone controller. Creates a room, drives
  the MapillaryJS street imagery, places the guess pin on a Leaflet map,
  computes the score, and writes all game state to
  `rooms/{roomCode}` in Firebase. The host is the single source of truth.
- **`screen.html`** — the TV spectator display. A pure subscriber that renders
  whatever state it receives. It writes nothing except its own
  `screenHeartbeat` every 10 seconds. Reach the TV via Chrome tab casting, a
  smart TV browser, or a Fire Stick — it's just a URL.
- **`index.html`** — landing page linking both.

Scoring is GeoGuessr-style exponential decay: `round(5000 * exp(-d / 1492))`
with `d` the haversine great-circle distance in km. Perfect pin is 5000;
~1500 km is roughly 1800; antipodal is effectively 0.

## Running a game

1. Open `host.html` on your phone. Pick rounds (3/5/10), the round timer
   (60/120/180s or no limit), movement mode ("no moving" locks navigation but
   allows look-around), and 1–4 teams. Tap **New Game**.
2. Open `screen.html` on the TV (or cast a laptop tab showing it). Enter the
   4-letter room code — or scan the QR from the host's phone, which encodes
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
JS SDK 10.12.2) load from pinned CDN URLs.

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
        ".validate": "$roomCode.matches(/^[A-HJ-NP-Z]{4}$/)",
        "createdAt": { ".validate": "newData.isNumber() && newData.val() <= now" }
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
