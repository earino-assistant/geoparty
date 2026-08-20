# Session-replay masking checklist

The P1 ship-blocker from `docs/field-observability-plan.md` §9.4. Node tests
cannot see the DOM, so this is the enumerated list of every element that
renders user-entered text or location data, and how it is kept out of a
recording. It is a review artifact: **re-run the "verify on a real
recording" section after any change to a screen listed here.**

Two mechanisms, both configured in `js/analytics.js`:

- `maskTextSelector: "[data-ph-mask], .leaflet-tooltip"` — text inside a
  matching element (and its descendants) is replaced with asterisks.
- `blockSelector: ".leaflet-container, [data-ph-block]"` — the element is
  not recorded at all, just a placeholder box.

Plus `maskAllInputs: true`, which covers every `<input>` unconditionally,
and `captureCanvas: false`, which covers the WebGL panorama.

## 1. Inputs (covered by `maskAllInputs`, listed for completeness)

| Element | Page | Contains |
|---|---|---|
| `#teamNames` (textarea) | host.html | team names |
| `#myTeamName` | player.html | this player's team name |
| `#joinCode` | player.html | room code |
| `#ldCode` | index.html | room code |
| `#roomInput` | screen.html | room code |

## 2. Masked containers (`data-ph-mask`)

Containers, not rows: masking the container also masks everything rendered
into it, so a future scoreboard row cannot slip through unmasked.

### host.html
- `#resumeCode` — room code in the resume banner
- `#roomCodeHuge` — the big lobby room code
- `#tvType` — typeable TV address + room code
- `#hudTeam` — active team name in the round HUD
- `#hGuessHint` — the guess-screen whose-turn banner interpolates the active
  team's name (`host-ui.updateGuessHint`)
- `#toast` — masked wholesale: team-name toasts flow through it (e.g. "Pass
  the phone — Blue is up!", `host-ui.js`). The Report inline action still
  works on the live DOM; masking is replay-only
- `#teamNames` — the setup textarea
- `#leaderboardList` — stored team names + dates
- `#revealPlace` — **the round's answer, as a place name** (now the reveal
  headline rather than a stat card — same element id, same mask)
- `#revealBoard` — the merged reveal board (round delta → running total),
  which replaced `#revealTotals`; carries team names
- `#finalTotals`, `#hostCrown` — scoreboard, winner line
- `#hostShowdownResults` — injected at runtime; masked in `host-ui.js`

`#revealResult` is deliberately **not** masked: it is the same aggregate
numbers (points, distance in km, speed bonus) the old `#revealDistance` /
`#revealPoints` cards carried unmasked. It contains no name, no place and
no coordinate — `tests/game.test.js` asserts `revealResultLine` never emits
one.

### player.html
- `#pResumeCode`, `#pRoomCodeHuge` — room codes
- `#pJoinUrl`, `#pTvType` — invite/TV links carrying the room code
- `#myTeamName` — the team-name input
- `#pLobbyTeams`, `#pLockedList`, `#pRevealBoard`, `#pFinalTotals`,
  `#pLockedRank`, `#pHandoffNote` — team names. `#pRevealBoard` is the
  merged board that replaced `#pRoundResults` + `#pRevealTotals`
- `#pRevealPlace` — the round's answer (now the reveal headline)
- `#pRevealResult` — unmasked, deliberately: aggregates only (see above)
- `#pLobbyNote` — the lobby status line names the host team ("Waiting for
  Blue to start…", `player-ui.renderLobby`)
- `#pRevealNote` — the auto-advance line names the host team ("Blue starts
  the next round…", `player-ui.renderAdvanceState`)
- `#toast` — masked wholesale: team-name toasts flow through it ("Blue locked
  in!", `player-ui.js`)

### screen.html (TV)
- `#roomInput`, `#h2hLobbyCode`, `#h2hLobbyUrl` — room codes/links
- `#lobbyTeams`, `#tvActiveTeam`, `#tvBoard`, `#podium`, `#tvNextHost`,
  `#h2hLobbyTeams`, `#h2hGrid`, `#h2hRoundBoard`, `#h2hTotals` — team names
- `#tvPlace`, `#h2hPlace` — the round's answer
- `#tvShowdown`, the guess-screen team caption — injected at runtime;
  masked in `screen-ui.js`

### daily.html
- `#dRevealPlace` — the round's answer (now the reveal headline)
- `#dRevealResult` — unmasked, deliberately: aggregates only (see above)
- `#toast` — masked wholesale for parity with the host/player toasts. The
  Daily is solo (no team names), but masking here keeps the rule uniform and
  future-proof

### Cross-page
- `.leaflet-tooltip` — Leaflet pin labels carry team names on reveal maps

## 3. Blocked outright (`blockSelector`)

Every Leaflet map (`.leaflet-container`): `#guessMap`, `#hostRevealMap`,
`#playerGuessMap`, `#pRevealMap`, `#dailyGuessMap`, the daily reveal map,
`#guessLiveMap`, `#revealMap`, `#h2hRevealMap`, and the h2h TV panel maps.

The reveal maps changed size (36 vh → 52 vh) and gained a `touch-action`
rule in the de-clutter pass, neither of which affects `blockSelector`: the
selector matches `.leaflet-container`, which every one of them still is.

**Why blocked and not masked:** Leaflet renders OSM tiles as
`<img src="…/{z}/{x}/{y}.png">`. A tile path *is* a coordinate. Masking the
text would leave the tile URLs — and therefore the round's answer and the
player's aim — sitting in the recording. Blocking is the only correct
treatment, and it matches `captureCanvas: false` for the panorama.

Map tile hosts are also **absent from `NETWORK_HOST_ALLOWLIST`**, so tile
requests are dropped from the replay network waterfall entirely
(`tests/analytics.test.js` asserts this).

## 4. Console output

Console capture (`enable_recording_console_log: true`) syncs **every**
`console.warn`/`console.error` into replays, so no production log line may
carry a raw SDK error — a Mapillary rejection message embeds the image id
(`"Image 1263588815098567 does not exist"`) and its URLs embed the access
token (review P1-1). Two rules, both enforced by
`tests/console-scrub.test.js`:

- **Wrapper logs use the opaque diag id.** `js/viewer-ui.js` logs skipped /
  failed pool entries by their **opaque diag id** only
  (`Pool entry k3x9q0ar failed to load (image_dead), skipping`) — never the
  raw Mapillary image id.
- **Every caught error is scrubbed before logging.** Each viewer-failure
  console site (`host-ui.js` resume, `player-ui.js` re-anchor,
  `screen-ui.js` follow, `screen-h2h.js` seed/follow) and every other
  caught-error `console.warn`/`console.error` in the page controllers logs
  `scrubErrorMessage(e)` (from `js/imagery.js`) — never the raw `Error`.
  `scrubErrorMessage` strips query strings (tokens) and 10+ digit runs
  (image ids). The static scan asserts no controller passes a bare caught
  error to `console.*`.

## 5. Verify on a real recording (do this, don't assume)

With consent accepted, on a real phone, play one round and then open the
recording in PostHog and confirm:

- [ ] Team names in the lobby list, HUD and scoreboard are asterisks.
- [ ] The guess-screen whose-turn banner, the lobby/reveal status notes, and
      any toast that names a team are asterisks.
- [ ] The room code (lobby, resume banner, TV line) is asterisks.
- [ ] The reveal place name (now the big accent headline) is asterisks.
- [ ] The merged reveal board's team names are asterisks; the result line
      beneath the place name shows numbers only.
- [ ] The panorama area is a blank/black box, not street imagery.
- [ ] The guess map and reveal map are placeholder boxes, not tiles.
- [ ] The network tab shows `graph.mapillary.com/<id>`-shaped entries with
      **no** `?access_token=…`, and **no** `tile.openstreetmap.org` rows.
- [ ] No request/response headers or bodies are present.
- [ ] The console shows `Pool entry <8 chars> failed…`, not a 16-digit id.

Then flip the `replay-imagery-debug` flag (PostHog flag id **255025**) off
and confirm a second session records **nothing**.
