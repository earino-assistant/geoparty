# GeoParty architecture

A working map for the next engineer. The README covers *how to run and
deploy*; this covers *how the system holds together* — the data model, who
writes what, and the concurrency rules that keep N phones and a TV coherent
with no server code.

## Module layout

```
config.js          Public client credentials (Firebase, Mapillary)
js/game.js         Pure couch-mode logic: scoring, phases, turn schedule   ← tested
js/h2h.js          Pure head-to-head logic: slots, submissions, winner     ← tested
js/supersure.js    Pure SUPER SURE bet logic: resolution + settlement      ← tested
js/frontdoor.js    Pure front-door logic: join routing, chooser targets    ← tested
js/hints.js        Pure education logic: one-shot flags, lock-now estimate ← tested
js/pool.js         Location pool: seeded shuffle + cursor sampler          ← tested
js/qr.js           Self-contained QR encoder (join/screen URLs)            ← tested
js/firebase.js     Firebase init + thin typed helpers (the only SDK import)
js/landing-ui.js   The one front door: hero pano, chooser, code routing
js/hints-ui.js     One-shot hint overlay renderer (shared by both phones)
js/host-ui.js      Couch-mode operator phone (DOM + viewer + writes)
js/player-ui.js    Head-to-head team phone (DOM + viewer + writes)
js/screen-ui.js    TV renderer, couch mode + shared entry/follow logic
js/screen-h2h.js   TV renderer, head-to-head split panels + reveal
```

The split is deliberate: everything above `firebase.js` is dependency-free
and runs in Node — that's what the test suite exercises. The `*-ui.js`
files are DOM/Firebase glue and are kept logic-light; when you add a rule
("who wins?", "is the round over?"), put it in `game.js`/`h2h.js` and call
it from the UI file, so it stays testable.

## RTDB data model

Everything lives under `rooms/{CODE}` (6 letters, no I/O). Couch mode:

```
rooms/KWPF
  createdAt        ms epoch (rules validate ≤ server now + 5 min skew)
  phase            lobby | roundActive | guessing | reveal | gameOver
  settings         { roundCount, roundSeconds (0 = no limit), moveAllowed }
  teams/t1..t4     { name, total }
  activeTeam       whose turn (couch multi-team)
  poolCursor       sampler position, for host resume
  round
    number, imageId, startedAt, turnStartedAt, endsAt
    pose           { bearing, center, zoom }   ≤4 writes/s while exploring
    liveGuess      { lat, lng }                ≤4/s while aiming (preview only)
    liveView       { lat, lng, zoom }          ≤4/s guess-map framing
    truth          { lat, lng, name }          written ONLY at reveal
    guess, score   written ONLY at confirm
    showdown, order, results/tN                final-round all-play
  screenHeartbeat  ms epoch, TV presence (the only thing the TV writes)
  nextRoom         pointer written into a FINISHED room → subscribers follow
```

Head-to-head differs: `mode: "h2h"`, `hostTeam` (rotates to the winner),
`teams/tN` gains `{ deviceId, joinedAt }`, and the round is below. The TV
is optional in this mode: every phone renders its own reveal map and shows
rivals' live pins, so two people can play over the internet with no shared
screen (the phones adapt copy via `screenAttached` on `screenHeartbeat`).

```
round
  number, imageId, startedAt, endsAt
  truth            { lat, lng, name } — embedded at round START (each phone
                   scores itself; devtools-peeking is not a threat we carry)
  live/tN          { stage, imageId, pose, view, pin }  ≤4/s per team
  results/tN       { guess, distanceKm, points, distancePoints, timeBonus,
                     elapsedMs, submittedAt, forfeited,
                     superSure, superSureOutcome }
  revealAt         countdown target stamped by whoever closes the round
```

### SUPER SURE (both modes)

The once-per-game double-or-nothing bet (design review §1.6, `supersure.js`).
Arming is **local phone state** until lock-in — nothing rides on the live
feed, so rivals can't see it coming (the DB row is technically readable
pre-reveal, same accepted posture as the embedded truth). Spending writes
`teams/tN/superSureUsed = round number` (survives refresh; `carryTeams`
resets it for the next game). `points` in a result row is always the RAW
round total; the ×2/0 is applied at *settlement*: the same atomic patch
that flips `phase: reveal` also writes `superSureOutcome` markers and
corrected absolute `teams/tN/total` values, so no subscriber ever renders
an unsettled reveal. Couch solo rounds carry the bet on `round/score`
(same fields); the host settles at confirm.

## Write ownership — the one rule that matters

Writers never contend on the same path:

| Path | Couch writer | H2H writer |
|---|---|---|
| everything under the room | host phone (sole authority) | — |
| `teams/tN`, `round/live/tN`, `round/results/tN` | — | team tN's phone only |
| `phase`, `round` (start/advance) | host phone | current `hostTeam`'s phone |
| `phase: reveal` + `revealAt` | host phone | **any** phone that sees the set complete |
| `screenHeartbeat` | TV | TV |
| `teams/tN` slot claim | — | transaction (`claimTeamSlot`) — the only transactional write |

Everything else is `update()` with last-write-wins, which is safe precisely
because paths are disjoint. The two deliberate exceptions where concurrent
writers CAN collide both write identical shapes, so the collision is
harmless:

- **Reveal flip**: the last phones to lock in may race the
  `phase: reveal` + `revealAt` write; values differ by milliseconds.
- **Forfeit sweep**: the host's sweep and the any-phone fallback sweep
  (`FORFEIT_GRACE_MS`, ×3 for the fallback) write the same forfeit rows.

The SUPER SURE settlement (h2h) extends the reveal-flip exception: every
flip writer computes the settlement from the complete result set its
atomic snapshot carries, so racing writers produce identical outcome
markers and identical *absolute* totals. (A lock-in delayed past the
forfeit grace window could in principle race a sweep's settlement with a
different "closest" — the same >6 s dying-phone corner the forfeit sweep
already accepts.)

### The lock-in deadlock (fixed — keep the guard)

`lockIn()` decides "am I the last one in?" from the local snapshot. When
the last two phones lock simultaneously — which the timeout auto-submit
makes the *common* case, since every un-submitted phone fires within one
250 ms tick of `endsAt` — each snapshot predates the other's write, so
neither flips the room, the sweep no-ops (nothing is pending), and the
round would hang forever. The guard in `player-ui.js onState()` closes it:
any phone that observes `phase === roundActive` with a complete result set
pushes the reveal flip (once per round, duplicates harmless). The
regression test is `tests/h2h.test.js` ("deadlock regression").

## Phase machines

Couch (host-enforced via `canTransition`):
`lobby → roundActive → guessing → reveal → (roundActive | gameOver) → lobby`

Head-to-head (no global guessing phase — each phone flips pano/map locally):
`lobby → roundActive → reveal → (roundActive | gameOver)`; `gameOver` is
terminal because the next game is a **new room**, reached via the
`nextRoom` pointer (written into the old room *after* the new room's write
is queued on the same connection, so followers never dangle). The TV keeps
a `followedCodes` set to break pointer cycles.

## Clocks and timers

All countdowns render from `endsAt − Date.now()` on the local clock; time
is never ticked through Firebase. Elapsed time for the speed bonus is
measured on the guessing phone's own clock (the same clock its countdown
trusts) and clamped ≥ 0. Cross-device clock skew therefore shifts *when* a
phone auto-submits by the skew amount but never corrupts scores. The
Firebase rules allow 5 minutes of client-ahead skew on `createdAt` — a
client further ahead than that cannot create rooms (see README rules).

## Throttling discipline

Every live mirror (pose, live guess, live view, per-team h2h feed) goes
through the same pattern: dirty-flag + 250 ms timer = **≤4 writes/s per
writer**, canceled on phase change so a trailing write can't leak into the
next phase. Worst case on the TV is 4 phones × 4/s = 16 small messages/s,
which `onValue` coalesces. Renderers only touch the DOM/maps when a
change-key differs (`poseKey`/`viewKey`/`pinKey`), so re-renders from
unrelated state changes are cheap.

## Security model (read this before "fixing" the rules)

The database is world-readable/writable **within `rooms/`** by design:
client credentials are public, and the threat model is drive-by vandalism
of a party game, not adversaries. The rules (README) only (1) confine
writes to well-formed room codes, (2) sanity-check `createdAt`, and
(3) let anyone delete rooms so the client-side janitors can work. Anyone
holding a room code can grief that room for 24 h; we accept that. What we
*do* defend:

- **XSS**: team names are attacker-controlled cross-device input. Every
  render path uses `textContent`; the only HTML sinks are Leaflet tooltips,
  which go through `escapeHtml`. Keep it that way.
- **CDN tampering**: Leaflet/MapillaryJS tags carry SRI hashes (verified
  against two CDNs). The Firebase SDK is an ES-module import from gstatic
  and cannot carry SRI — accepted (Google-operated origin).
- **URL/room-code inputs** are validated with `isValidRoomCode` before any
  use (subscription, `history.replaceState`, follow pointers).

Known residual risks, accepted: no size cap on room payloads; no rate
limiting; `nextRoom` in a griefed room could yank a TV to an attacker's
room (they'd need the code, which is on the party's TV).

## Performance notes

- The TV's h2h view runs up to **4 MapillaryJS WebGL viewers at once**.
  Fine on a laptop/Chromecast tab; marginal on low-end TV sticks. If that
  ever bites, the cheap lever is capping panel resolution, not rearchitecting.
- The 3.4 MB pool JSON is fetched once per page load (`loadPool` caches);
  only host phones fetch it in h2h mode.
- Reveal maps are rebuilt per reveal and torn down; panels are rebuilt only
  when the team grid fingerprint changes.

## Testing & CI

`npm test` → Node's built-in runner over `tests/*.test.js` (no deps, no
build). Coverage is the pure logic layer plus a pool-integrity suite that
guards `data/location_pool.json` (shape, coordinate ranges, unique ids).
CI (`.github/workflows/ci.yml`) syntax-checks every module and runs the
suite on push/PR. UI files are exercised by syntax check only — by design
they should stay thin enough that this is acceptable; grow `game.js`/
`h2h.js` instead of them.
