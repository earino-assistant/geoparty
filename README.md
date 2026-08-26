# GeoParty

A Jackbox-style geoguessing party game for families and friends. Drop a pin on
a world map from a street-level view, score points by how close you land, and
the person who guesses best wins. **No downloads, no accounts, no build — you
just open a URL and play.**

👉 **Play it now:** [**geoparty.social**](https://geoparty.social)

---

## Play it in two minutes

1. **Open the URL** on your TV ([geoparty.social/screen](https://geoparty.social/screen))
   using Chrome tab-casting, a smart-TV browser, or an HDMI laptop — and open
   it on your phone too.
2. **Pick a mode.** Couch: one person drives the phone, everyone watches the TV
   and shouts where to guess. Or every team plays on its own phone, head-to-head.
3. **Guess.** You get a street-level view — drop a pin on the world map where
   you think it is. The closer, the more points. A "perfect pin" is 5000.

That's it. No app store, no account, no QR-code-and-password dance. This game
exists so your family can start playing **in ten seconds**, not ten minutes.

## The two ways to play

- **Couch mode** — one operator drives the street imagery from their phone
  while everyone watches the TV. *One phone, one TV, several extremely confident
  people.*
- **Head-to-head** — up to four teams play at once, each on their own phone.
  Everyone gets the same location; each team roams and guesses at its own pace;
  the TV splits into one live panel per team; and when the last team locks in,
  every pin lands on one full-screen reveal map. **The winning team hosts the
  next game.**

You can also play entirely on phones without a TV — though couch mode is much
better with one.

There's also a solo **Daily Challenge** (one date-seeded run for everyone that
day), and a set of party twists — Hard Mode, streak bonuses, ACE callouts,
Crown Night tallies, and decoy pins.

## How it works (the short version)

It's static JavaScript synced through **Firebase Realtime Database** — **no
server code, no build step, no cost to run.** The operator's phone is the single
source of truth; the TV is a pure subscriber that renders whatever state it
receives; and the host's duties rotate to each game's winner. It's a genuinely
interesting architecture (contended writes, a passive renderer, host rotation)
if you like that sort of thing — more below.

---

## Open source (MIT)

GeoParty is owned by **Eduardo Ariño de la Rubia** and released under the
[MIT License](LICENSE). Use, copy, modify, distribute, and even commercialize it
freely — just retain the copyright and permission notice. It's also used as a
**reference project with Eduardo's students** (real production code and real,
GDPR-opt-in usage data, not a toy dataset).

---

## The full technical tour

Everything from here is the deep dive for builders, contributors, and the
curious.

### How the pieces fit

- **`player.html`** — the head-to-head team phone. The first phone creates the
  room (its team is the host); up to three more join via QR/room code and claim
  team slots. Each phone writes only its own team's paths
  (`round/live/<team>`, `round/results/<team>`, `teams/<team>`), scores itself
  from the truth embedded in the round, and whichever phone submits last flips
  the room to reveal. When a game ends, host authority rotates to the winner
  (`hostTeam`), whose phone spawns the next room; everyone else — and the TV —
  follows the `nextRoom` pointer automatically.
- **`host.html`** — the operator's phone controller. Creates a room, drives the
  MapillaryJS street imagery, places the guess pin on a Leaflet map, computes
  the score, and writes all game state to `rooms/{roomCode}` in Firebase. The
  host is the single source of truth.
- **`screen.html`** — the TV spectator display. A pure subscriber that renders
  whatever state it receives. It writes nothing except its own
  `screenHeartbeat` every 10 seconds. Reach the TV via Chrome tab casting, a
  smart TV browser, or a Fire Stick — it's just a URL.
- **`index.html`** — the one front door: a hero landing with a single "Start a
  party" CTA and one code-entry join path that reads the room's mode and routes
  to the right page automatically.
- **`daily.html`** — the solo Daily Challenge: one date-seeded run of the same
  five locations for everyone that day, played on a single device with no room
  or Firebase. Scores build streaks and personal bests locally, and a finished
  run can be shared as an emoji grid or a Ghost Duel challenge link.

Scoring is GeoGuessr-style exponential decay: `round(5000 * exp(-d / 1492))`
with `d` the haversine great-circle distance in km. A perfect pin is 5000;
~1500 km is roughly 1800; antipodal is effectively 0.

### The Daily ritual & party twists

Beyond the two live modes, GeoParty has a solo daily loop and a set of party
rule-benders (the "G1–G8" gameplay expansion):

- **Streaks & personal bests** — a Daily run keeps a streak going day to day
  (with a grace window so one missed day doesn't reset it), and your best Daily
  score is tracked and celebrated when you beat it. Both live only in
  `localStorage` on the device that played.
- **Hard Mode** — an opt-in no-movement Daily variant for purists.
- **ACE** — land close enough to the answer and the game says so, loudly.
- **Ghost Duel challenge links** — after finishing your Daily you can send a
  friend a link to play the same five locations against the "ghost" of your
  run. The link carries **only your own guesses and timings**, in the URL
  *fragment* — it is never sent to any server, never reaches analytics or
  session replay, and contains no names, answer locations, or image ids. See
  [`PRIVACY.md`](PRIVACY.md) and CLAUDE.md for the exact boundary.
- **Twist rounds** — a seeded deck of rule-benders (e.g. Blitz scoring) that
  hits every party the same way.
- **Crown Night** — a full-evening tally across games with a champion ceremony
  on the TV, in couch and head-to-head alike.
- **Decoy Pin** (head-to-head) — drop one fake pin to mislead rivals watching
  your live panel; exposed at the reveal.

### Running a game

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

### Local development

Serve the directory with any static file server (ES modules don't run from
`file://`):

```sh
python3 -m http.server 8000
# then http://localhost:8000/host.html and http://localhost:8000/screen.html
```

There is no build step. Libraries (MapillaryJS 4.1.2, Leaflet 1.9.4, Firebase
JS SDK 10.12.2) load from pinned CDN URLs; the Leaflet and MapillaryJS tags
carry SRI integrity hashes, so bumping a version means updating the hash in all
three HTML pages (`openssl dgst -sha384 -binary | openssl base64 -A` over the
new file).

### Tests & CI

The pure logic layer is covered by a dependency-free test suite using Node's
built-in runner. It spans the original game core and the G1–G8 gameplay
expansion modules — scoring, the time bonus, phase machines, turn rotation,
reveal ordering, winner tie-breaks, the seeded shuffle/resume contract, QR
encoding, Daily streaks and personal bests, the Ghost Duel fragment codec,
twist decks, Crown Night tallies, an integrity check over
`data/location_pool.json`, and the field-observability layer (error taxonomy,
privacy scrubbers, the collision-free pool diag id, session-health
classification, and the 16-row failure-injection matrix — catalogued in
[`docs/failure-injection.md`](docs/failure-injection.md)):

```sh
npm test        # node --test tests/*.test.js — no install needed
npm run check   # node --check every module (catches syntax errors in the UI files)
```

Both run in CI on every push and pull request (`.github/workflows/ci.yml`).
There is still no build step and no runtime dependency — `package.json` exists
only to name the test scripts and mark the repo as ESM for Node.

For a map of the data model, write-ownership rules, and concurrency invariants,
see [`docs/architecture.md`](docs/architecture.md).

### Privacy & analytics

Product analytics run on PostHog Cloud EU behind **GDPR opt-in consent**: the
PostHog script is not even loaded until a visitor accepts the banner, only
aggregate metrics are sent (distances, scores, times, mode, team counts — never
coordinates, names, or identities), and the choice can be changed anytime via
the 🍪 control on every page. The event schema is a hard allowlist in
`js/analytics.js`, unit-tested in `tests/analytics.test.js`.

The same gate covers **field observability** (imagery/viewer diagnostics, error
tracking and session replay): nothing is loaded or recorded before an explicit
accept, the panorama canvas and every map are excluded from recordings (a map
tile URL is a coordinate), everything typed is masked, and locations travel only
as an opaque 8-character pool code — never a coordinate or a Mapillary image id.
A user who declined can still send **one** diagnostic report, after a second
explicit ask, without their "no" ever changing.

See [`PRIVACY.md`](PRIVACY.md) for the policy, [`docs/analytics.md`](docs/analytics.md)
for the event/KPI catalog, [`docs/field-observability-plan.md`](docs/field-observability-plan.md)
for the design, and [`docs/replay-mask-checklist.md`](docs/replay-mask-checklist.md)
for the masking audit.

### Deployment (GitHub Pages)

1. The owner pushes this directory to the `main` branch of the `geoparty`
   repository (the code is MIT — fork, use, and host freely).
2. Repo Settings → Pages → Source = **GitHub Actions** (`.github/workflows/pages.yml`
   runs the checks, stamps `release.json` with the deployed commit, and deploys —
   nothing is committed per deploy).
3. The site serves at `https://<owner>.github.io/geoparty/`. All asset paths in
   the repo are relative, so subpath serving works as-is.

### Firebase security rules (manual step — do this once)

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

`rooms/` is the one and only room namespace; `js/firebase.js#roomRef()` composes
every Firebase path under it. These rules scope the otherwise-open database to
room paths, validate the room-code shape, and let anyone clean up rooms older
than 24 hours. They are **deliberately permissive within `rooms/`**: this is a
party game with public client credentials, and the threat model is drive-by
vandalism, not adversaries. Anyone who knows (or guesses) a room code can read
or overwrite that room while it is under 24 hours old — worst case, someone
griefs a party game round. The `+ 300000` on `createdAt` allows 5 minutes of
client clock skew.

### Location pool

Rounds draw from `data/location_pool.json` — pregenerated, verified Mapillary
360° pano locations, currently **5,312 entries across 134 countries**. The pool
is shuffled once per game (Fisher–Yates seeded from the room code) and sampled
without replacement; deleted images are skipped silently. It's produced by a
three-stage pipeline (build / tier / verify) documented in
[`docs/pool-scale-plan.md`](docs/pool-scale-plan.md), with a weekly
`pool-health.yml` job that proposes quarantining dead images via a never-auto-merged PR.

### Persistent leaderboard

The all-time top 10 lives in `localStorage` on the **host device** (key
`geoparty_leaderboard`). There's no sync and no accounts — clearing the
browser's site data clears the leaderboard history.

### Edge cases handled

- **Host refresh / phone sleep** — the host page offers Resume for a room under
  24h old and reattaches as authority.
- **Screen refresh** — stateless; re-enter via the URL param and rendering
  resumes from current state.
- **Next game** — the new room's code is written as a `nextRoom` pointer into
  the finished room; the still-subscribed screen follows automatically.
- **Firebase unreachable** — both views show a "reconnecting" pill; the host
  can keep playing in degraded single-screen mode.
- **Stale rooms** — the host setup screen best-effort deletes rooms this device
  created that are older than 24h.
