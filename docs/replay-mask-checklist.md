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
- `#teamNames` — the setup textarea; also masks the per-input type-ahead
  suggestion buttons rendered into it (`host-ui.js#renderSuggestionsFor`),
  which surface this device's remembered team names
- `#teamNameHelpers` — the 🎲 Surprise-me control. The Recent-teams
  disclosure that used to live here was removed (owner: "not worth the
  screen real estate") — `#teamNames` above is now the only place a
  remembered name renders
- `#leaderboardList` — stored team names + dates
- `#revealPlace` — **the round's answer, as a place name** (now the reveal
  headline rather than a stat card — same element id, same mask)
- `#revealBoard` — the merged reveal board (round delta → running total),
  which replaced `#revealTotals`; carries team names
- `#finalTotals`, `#hostCrown` — scoreboard, winner line
- `#hChampion`, `#hNightTally`, `#hNightHook` — G3 Crown Night champion /
  tally / "Game N?" hook carry team names
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
- `#pTeamSuggestions` — team-roster brief, extended to the h2h joiner:
  inline type-ahead suggestion buttons (`player-ui.js#renderTeamSuggestions`)
  that surface this device's remembered team name plus pun-bank matches
  while typing. No permanent roster UI on this page (owner: "not worth the
  screen real estate") — pre-fill, 🎲 pun and this transient dropdown are
  the whole feature
- `#pLobbyTeams`, `#pLockedList`, `#pRevealBoard`, `#pFinalTotals`,
  `#pLockedRank`, `#pHandoffNote` — team names. `#pRevealBoard` is the
  merged board that replaced `#pRoundResults` + `#pRevealTotals`
- `#pChampion`, `#pNightTally`, `#pNightHook` — G3 Crown Night champion /
  tally / "Game N?" hook carry team names
- `#pGameOverTitle` — the win celebration's headline: a non-champion win
  renders `fx.js#winLine`, which interpolates the winning team's name
  (`player-ui.js#renderGameOver`)
- `#pWinStat` — the win screen's own brag line (`share.js#winBragText`);
  aggregates only (distance, place name from the pool), but masked anyway
  for consistency with the rest of this game-over screen
- `#pConfetti`, `.win-bloom` — unmasked, deliberately: decorative only, the
  confetti strips and radial bloom render inline colors/geometry, never
  text or a coordinate
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
- `#tvNightTally`, `#tvLobbyNight`, `#tvChampion` — G3 Crown Night tally /
  champion carry team names
- `#h2hLobbyNote` — the h2h lobby status line now folds in the Crown Night
  tally (team names) in game ≥ 2 (spec §3.3, C5)
- `#tvPlace`, `#h2hPlace` — the round's answer
- `#tvShowdown`, the guess-screen team caption — injected at runtime;
  masked in `screen-ui.js`

### daily.html
- `#dRevealPlace` — the round's answer (now the reveal headline)
- `#dRevealResult` — unmasked, deliberately: aggregates only (see above)
- `#dRevealDuel`, `#dRevealTotal` — unmasked, deliberately: the ghost duel's
  per-round and running scores are aggregates; the ghost is anonymous by design
  (the chat context, not the link, names the sender), so there is **nothing to
  mask here — keep it that way** (G5, spec §3.5.6)
- `#dDoneDuel`, `#dDoneStreak`, `#dDonePB`, `#dIntroRecords` — unmasked,
  deliberately: streaks, personal bests, and duel margins are non-identifying
  scores/counts. No name or user-entered text ever reaches these nodes
- `#dDoneRecap` — the "Your five places" recap: masked wholesale, because the
  per-round carousel captions carry city names (`recap.recapCaption`). The two
  maps inside it (the overview mini-map `#dRecapOverview` and each carousel
  card map, both built in `daily-ui.js#renderRecap`) are `.leaflet-container`,
  already blocked by `blockSelector` — see §3
- `#dChallengeEyebrow` — unmasked: it shows the public Daily number only. The
  ghost payload is stripped from the URL (`history.replaceState`) before any
  capture and never renders (G5)
- `#toast` — masked wholesale for parity with the host/player toasts. The
  Daily is solo (no team names), but masking here keeps the rule uniform and
  future-proof
- `#dConfetti`, `.win-bloom`, `#dDoneTitle` — unmasked, deliberately:
  `#dConfetti`/`.win-bloom` are decorative only (inline colors/geometry,
  same as the party win screen above); `#dDoneTitle` carries no team name
  either — the Daily win celebration has no `winLine` (solo, no team name
  to interpolate), so its headline is only ever the existing static
  done-title copy

### Cross-page
- `.leaflet-tooltip` — Leaflet pin labels carry team names on reveal maps
- `.pano-nav-hint` — the "Finding your way…" nav-arrows-loading pill (issue
  #3 follow-up): static, hardcoded copy only, no name/place/coordinate ever
  renders into it. No mask needed.
- `.mod-callout` — the pin-drop guess-modifier callout (guess-modifier design
  §5.3, amended A2 §2.5): its title + line come from `modifier.calloutSpec` —
  static, hardcoded tease copy ("Are you SUPER SURE?" / "Feeling sneaky?" / the
  co-equal both-tease "Raise the stakes?"), no team name, room code, place name
  or coordinate. Audited no-mask; the guess map beneath it is
  already blocked by `blockSelector`. No mask needed.

## 3. Blocked outright (`blockSelector`)

Every Leaflet map (`.leaflet-container`): `#guessMap`, `#hostRevealMap`,
`#playerGuessMap`, `#pRevealMap`, `#dailyGuessMap`, the daily reveal map,
`#guessLiveMap`, `#revealMap`, `#h2hRevealMap`, and the h2h TV panel maps.

Two more daily-done map surfaces come from the "Your five places" recap
(`daily-ui.js#renderRecap`): the numbered **overview** mini-map
(`#dRecapOverview`) and each **carousel card** map (built in JS, no id). Both
are rendered by `js/revealmap-ui.js` and are `.leaflet-container`, so they fall
under `blockSelector` with no per-id entry — a tile there is still a
coordinate. The recap's city-name captions sit *outside* the maps and are
covered by the wholesale `#dDoneRecap` mask (§2).

The reveal maps changed size (36 vh → 52 vh) and gained a `touch-action`
rule in the de-clutter pass, neither of which affects `blockSelector`: the
selector matches `.leaflet-container`, which every one of them still is.

The four reveal maps (`#dRevealMap`, `#pRevealMap`, `#revealMap`,
`#h2hRevealMap`) are now rendered by a single shared module,
`js/revealmap-ui.js` (from the `js/revealmap.js` scene), instead of four
per-surface copies. This changes nothing about masking — the containers are
still `.leaflet-container` and still fall under `blockSelector`, and the
module adds no DOM outside them. But it means **any new reveal label** (a new
pin tooltip, chip, or badge) must be added as a scene op in `js/revealmap.js`,
and any such addition still renders inside `.leaflet-container` (blocked). Any
new reveal *container* would need its own `blockSelector`/mask entry here.
Re-run the §5 verify-on-a-real-recording step after any reveal-scene change.

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
console method into replays — `console.log`, `console.info`, `console.debug`,
`console.warn` **and** `console.error`, all five — so no production log line
may carry a raw SDK error, whichever method emits it. A Mapillary rejection
message embeds the image id (`"Image 1263588815098567 does not exist"`) and
its URLs embed the access token (review P1-1). Two rules, both enforced by
`tests/console-scrub.test.js`:

- **Wrapper logs use the opaque diag id.** `js/viewer-ui.js` logs skipped /
  failed pool entries by their **opaque diag id** only
  (`Pool entry k3x9q0ar failed to load (image_dead), skipping`) — never the
  raw Mapillary image id.
- **Every caught error is scrubbed before logging.** Each viewer-failure
  console site (`host-ui.js` resume, `player-ui.js` re-anchor,
  `screen-ui.js` follow, `screen-h2h.js` seed/follow) and every other
  caught-error `console.log`/`console.info`/`console.debug`/`console.warn`/
  `console.error` in the page controllers logs
  `scrubErrorMessage(e)` (from `js/imagery.js`) — never the raw `Error`.
  `scrubErrorMessage` strips query strings (tokens) and 10+ digit runs
  (image ids). `chrome-ui.js` (the listener-failure log) and
  `analytics.js` (the PostHog-load-failure log) route through it too.

**What the static scan actually proves (and what it does not).**
`tests/console-scrub.test.js` lexes **every** `js/*.js` file (auto-discovered,
not a hand-picked list) with a small JS tokenizer — comments, string and
template literals, `${…}` interpolations and regex literals are all parsed,
so an apostrophe in a comment can no longer blind it (the old bug behind
review RF-1). For **each of the five captured console methods** — `log`,
`info`, `debug`, `warn`, `error` (RF-A) — it asserts no un-scrubbed error
alias (`…, e)`, `${e}`, `e.message`, `e.stack`, `String(e)`, and
`err`/`error`/`ex` aliases) reaches the console. A per-file **raw-vs-scanned
count parity** check plus a total-sites floor make the scan non-vacuous: if a
real call is ever silently dropped from the parse (or a guarded file
disappears), the suite fails. Production has **zero** `log`/`info`/`debug`
sites today, so the floor is a single TOTAL count (dominated by the ~30
warn/error sites) rather than a per-method minimum that would fabricate
usage; method coverage for `log`/`info`/`debug` is proven by explicit leak
fixtures instead.

This is a **lexical, single-file** guarantee: it proves each `console.*` call
*as written* does not name a bare caught-error value, and that the check
itself cannot be silently blinded. It is **not** a whole-program data-flow
proof — it cannot follow an error copied into an intermediate variable first
(`const m = e.message; console.warn(m)`), and it deliberately does **not**
touch third-party SDK console output (see §4.1). Those residuals are called
out honestly rather than papered over.

### 4.1 Residual: third-party SDK console output (advisory, review A2)
Console capture is left **on** (`enable_recording_console_log: true`) because
our own skip-loop warnings are the story of a failing round. The trade-off:
the Firebase and Mapillary SDKs' *own* `console.*` lines ride into replay
unscrubbed, and a Firebase warning can embed a database path containing a
room code. This is pre-existing, consent-gated, and room codes are
24-hour-lived; monkey-patching SDK console output is explicitly out of scope
for the RF-1 guardrail work. Options if ever scheduled: scrub console entries
in a replay `before_send`, or accept and document (current stance).

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
