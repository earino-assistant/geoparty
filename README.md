# GeoParty

A Jackbox-style geoguessing party game. One person (the operator) drives
street-level imagery from their phone. Everyone else watches a TV showing a
clean spectator view of the same imagery and shouts suggestions. The operator
drops a guess on a map, the TV reveals the true location, and points are
awarded by distance.

The entire system is static JavaScript synced through Firebase Realtime
Database. No server code, no build step, no cost.

> **Open source (MIT).** GeoParty is owned by Eduardo Ariño
> de la Rubia and is licensed under the [MIT License](LICENSE).
> Use, copy, modify, distribute, and even commercialize it freely, provided
> you retain the copyright notice and this permission notice.

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
- **`daily.html`** — the solo Daily Challenge: one date-seeded run of the
  same five locations for everyone that day, played on a single device with
  no room or Firebase. Scores build streaks and personal bests locally, and
  a finished run can be shared as an emoji grid or a Ghost Duel challenge
  link (below).

Scoring is GeoGuessr-style exponential decay: `round(5000 * exp(-d / 1492))`
with `d` the haversine great-circle distance in km. Perfect pin is 5000;
~1500 km is roughly 1800; antipodal is effectively 0.

## The Daily ritual & party twists

Beyond the two live modes, GeoParty has a solo daily loop and a set of
party rule-benders (the "G1–G8" gameplay expansion):

- **Streaks & personal bests** — a Daily run keeps a streak going day to
  day (with a grace window so one missed day doesn't reset it), and your
  best Daily score is tracked and celebrated when you beat it. Both live
  only in `localStorage` on the device that played.
- **Hard Mode** — an opt-in no-movement Daily variant for purists.
- **ACE** — land close enough to the answer and the game says so, loudly.
- **Ghost Duel challenge links** — after finishing your Daily you can send
  a friend a link to play the same five locations against the "ghost" of
  your run. The link carries **only your own guesses and timings**, in the
  URL *fragment* — it is never sent to any server, never reaches analytics
  or session replay, and contains no names, answer locations, or image
  ids. See [`PRIVACY.md`](PRIVACY.md) and CLAUDE.md for the exact boundary.
- **Twist rounds** — a seeded deck of rule-benders (e.g. Blitz scoring)
  that hits every party the same way.
- **Crown Night** — a full-evening tally across games with a champion
  ceremony on the TV, in couch and head-to-head alike.
- **Decoy Pin** (head-to-head) — drop one fake pin to mislead rivals
  watching your live panel; exposed at the reveal.

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

The pure logic layer is covered by a dependency-free test suite using Node's
built-in runner. It spans the original game core (`js/game.js`, `js/h2h.js`,
`js/pool.js`, `js/qr.js`, `js/imagery.js`, `js/analytics.js`) and the
G1–G8 gameplay-expansion modules (`js/records.js`, `js/ghost.js`,
`js/twist.js`, `js/night.js`, `js/decoy.js`, `js/daily.js`, `js/share.js`,
`js/supersure.js`, `js/frontdoor.js`, `js/tvlink.js`, `js/hints.js`,
`js/chrome.js`, `js/autoadvance.js`, `js/couchscreen.js`, `js/fx.js`) —
scoring, the time bonus, phase machines, turn rotation, reveal ordering,
winner tie-breaks, the seeded shuffle/resume contract, QR encoding, Daily
streaks and personal bests, the Ghost Duel fragment codec, twist decks,
Crown Night tallies, an integrity check over `data/location_pool.json`, and
the field-observability layer (error taxonomy, privacy scrubbers, the
collision-free pool diag id, session-health classification, and the 16-row
failure-injection matrix in `tests/viewer-ui.test.js`, catalogued in
[`docs/failure-injection.md`](docs/failure-injection.md)):

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
`tests/analytics.test.js`.

The same gate covers **field observability** (imagery/viewer diagnostics,
error tracking and session replay): nothing is loaded or recorded before an
explicit accept, the panorama canvas and every map are excluded from
recordings (a map tile URL is a coordinate), everything typed is masked,
and locations travel only as an opaque 8-character pool code — never a
coordinate or a Mapillary image id. A user who declined can still send
**one** diagnostic report, after a second explicit ask, without their "no"
ever changing.

See [`PRIVACY.md`](PRIVACY.md) for the policy,
[`docs/analytics.md`](docs/analytics.md) for the event/KPI catalog,
[`docs/field-observability-plan.md`](docs/field-observability-plan.md) for
the design, [`docs/replay-mask-checklist.md`](docs/replay-mask-checklist.md)
for the masking audit, and
[`docs/failure-injection.md`](docs/failure-injection.md) for the chaos
runbook.

## Deployment (GitHub Pages)

1. These steps document how the **owner** publishes GeoParty; under the MIT
   license anyone is free to fork and host their own copy. The
   owner pushes this directory to the `main` branch of the `geoparty`
   repository (the code is open source; fork, use, and host freely).
2. Repo Settings → Pages → Source = **GitHub Actions**
   (`.github/workflows/pages.yml` runs the checks, stamps `release.json`
   with the deployed commit, and deploys — nothing is committed per
   deploy).
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

`rooms/` is the one and only room namespace; `js/firebase.js#roomRef()`
composes every Firebase path under it. (An earlier revision also allowlisted a
`rooms-beta/` subtree for a beta deployment lane; that lane was removed — see
`docs/beta-delivery-architecture-audit.md` and `docs/beta-removal-plan.md`.
This ruleset is the canonical copy, and `rooms-beta/` is denied by the
top-level `false` defaults like any other unlisted path.)

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
360° pano locations, currently **5,312 entries across 134 countries**. The
pool is shuffled once per game (Fisher–Yates seeded from the room code, so a
resumed host sees the same order) and sampled without replacement. If an image
has been deleted from Mapillary since generation, the host skips to the next
entry silently.

The pool is produced by a three-stage pipeline (full runbook and rationale in
[`docs/pool-scale-plan.md`](docs/pool-scale-plan.md)):

1. **Build** — `tools/scale_location_pool.py` gathers panoramic imagery from
   the Mapillary Graph API and dedupes on a grid. (The original single-bbox
   sampler `tools/build_location_pool.py` is kept for reference but
   superseded.)
2. **Tier** — `tools/score_location_pool.py` assigns each entry a difficulty
   tier (Casual / World tour / Expert) used by the Daily and the tier picker.
3. **Verify** — `tools/validate_location_pool.py` checks structural integrity
   before the pool is committed.

Separately, a weekly GitHub Actions job (`.github/workflows/pool-health.yml`)
asks Mapillary whether pooled images still exist and proposes removing dead
ones via a `data/pool_quarantine.json` PR that is never auto-merged.

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
