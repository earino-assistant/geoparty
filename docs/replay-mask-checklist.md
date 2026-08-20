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
- `#teamNames` — the setup textarea
- `#leaderboardList` — stored team names + dates
- `#revealPlace` — **the round's answer, as a place name**
- `#revealTotals`, `#finalTotals`, `#hostCrown` — scoreboards, winner line
- `#hostShowdownResults` — injected at runtime; masked in `host-ui.js`

### player.html
- `#pResumeCode`, `#pRoomCodeHuge` — room codes
- `#pJoinUrl`, `#pTvType` — invite/TV links carrying the room code
- `#myTeamName` — the team-name input
- `#pLobbyTeams`, `#pLockedList`, `#pRoundResults`, `#pRevealTotals`,
  `#pFinalTotals`, `#pLockedRank`, `#pHandoffNote` — team names
- `#pRevealPlace` — the round's answer

### screen.html (TV)
- `#roomInput`, `#h2hLobbyCode`, `#h2hLobbyUrl` — room codes/links
- `#lobbyTeams`, `#tvActiveTeam`, `#tvBoard`, `#podium`, `#tvNextHost`,
  `#h2hLobbyTeams`, `#h2hGrid`, `#h2hRoundBoard`, `#h2hTotals` — team names
- `#tvPlace`, `#h2hPlace` — the round's answer
- `#tvShowdown`, the guess-screen team caption — injected at runtime;
  masked in `screen-ui.js`

### daily.html
- `#dRevealPlace` — the round's answer

### Cross-page
- `.leaflet-tooltip` — Leaflet pin labels carry team names on reveal maps

## 3. Blocked outright (`blockSelector`)

Every Leaflet map (`.leaflet-container`): `#guessMap`, `#hostRevealMap`,
`#playerGuessMap`, `#pRevealMap`, `#dailyGuessMap`, the daily reveal map,
`#guessLiveMap`, `#revealMap`, `#h2hRevealMap`, and the h2h TV panel maps.

**Why blocked and not masked:** Leaflet renders OSM tiles as
`<img src="…/{z}/{x}/{y}.png">`. A tile path *is* a coordinate. Masking the
text would leave the tile URLs — and therefore the round's answer and the
player's aim — sitting in the recording. Blocking is the only correct
treatment, and it matches `captureCanvas: false` for the panorama.

Map tile hosts are also **absent from `NETWORK_HOST_ALLOWLIST`**, so tile
requests are dropped from the replay network waterfall entirely
(`tests/analytics.test.js` asserts this).

## 4. Console output

`js/viewer-ui.js` logs skipped pool entries by their **opaque diag id**
(`Pool entry k3x9q0ar failed to load (image_dead), skipping`) — never the
raw Mapillary image id. Console capture is on, so this line ends up inside
replays; it must stay id-free.

## 5. Verify on a real recording (do this, don't assume)

With consent accepted, on a real phone, play one round and then open the
recording in PostHog and confirm:

- [ ] Team names in the lobby list, HUD and scoreboard are asterisks.
- [ ] The room code (lobby, resume banner, TV line) is asterisks.
- [ ] The reveal place name is asterisks.
- [ ] The panorama area is a blank/black box, not street imagery.
- [ ] The guess map and reveal map are placeholder boxes, not tiles.
- [ ] The network tab shows `graph.mapillary.com/<id>`-shaped entries with
      **no** `?access_token=…`, and **no** `tile.openstreetmap.org` rows.
- [ ] No request/response headers or bodies are present.
- [ ] The console shows `Pool entry <8 chars> failed…`, not a 16-digit id.

Then flip the `replay-imagery-debug` flag (PostHog flag id **255025**) off
and confirm a second session records **nothing**.
