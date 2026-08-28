# Session-replay masking checklist

The P1 ship-blocker from `docs/field-observability-plan.md` §9.4. Node tests
cannot see the DOM, so this is the enumerated list of every element that
renders user-entered text or location data, and how it is kept out of a
recording. It is a review artifact: **re-run the "verify on a real
recording" section after any change to a screen listed here.**

Two mechanisms, both configured in `js/analytics.js`:

- `maskTextSelector: "[data-ph-mask], .leaflet-tooltip"` — text inside a
  matching element (and its descendants) is replaced with asterisks.
- `blockSelector: "[data-ph-block]"` — the element is not recorded at all,
  just a placeholder box. **No element carries this attribute today.**

Plus `maskAllInputs: true`, which covers every `<input>` unconditionally, and
`captureCanvas: { recordCanvas: true, ... }`, which now RECORDS the WebGL
panorama rather than leaving it a blank box (§3).

> **Owner decision, 2026-08-28 — gameplay is no longer masked.**
> `docs/decisions/2026-08-28-replay-privacy.md` (GeoParty only;
> Flag Party is unchanged). A guess, and where a player navigated, are
> gameplay — not personal information — and blanking them made imagery bugs
> undebuggable. So the guess map, the reveal map and the street-view pano are
> deliberately **visible** in recordings now. This checklist is therefore
> about **identity**: team names, room codes and place names. Everything in
> §1, §2 and the `.leaflet-tooltip` rule below is unchanged and still a
> ship-blocker. See §3 for what changed and what did not.

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
- `#hRecap` — the party game-over "Where were the places" recap: masked
  wholesale, because the per-round carousel captions carry place names
  (`partyrecap.partyRecapCaption`). The carousel card maps inside it (built
  in `js/recap-ui.js`) are `.leaflet-container` and are now VISIBLE in
  recordings — see §3. The wholesale mask here still covers the captions,
  which is where the place names are
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
- `#pRecap` — the party game-over "Where were the places" recap: masked
  wholesale, because the per-round carousel captions carry place names
  (`partyrecap.partyRecapCaption`). The carousel card maps inside it (built
  in `js/recap-ui.js`) are `.leaflet-container` and are now VISIBLE in
  recordings — see §3. The wholesale mask here still covers the captions,
  which is where the place names are
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
- `#tvRecap` — the party game-over "Where were the places" recap: masked
  wholesale, because the auto-cycling card's caption carries a place name
  (`partyrecap.partyRecapCaption`). Its card map `#tvRecapMap` is a
  `.leaflet-container` and is now VISIBLE in recordings — see §3. The
  wholesale mask here still covers the caption, which carries the place name
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
  per-round carousel captions carry city names (`recap.recapCaption`). The
  carousel card maps inside it (built in `daily-ui.js#renderRecap`) are
  `.leaflet-container` and are now VISIBLE in recordings — see §3. The
  wholesale mask here still covers the captions, which carry the city names
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
- Daily resume intro (mid-run persistence, `docs/daily-persistence-spec.md`
  §7): **nothing to mask, no selector change**. The resume affordance is only
  a round index (`#btnDailyStart` relabelled "Resume — round N of 5") and a
  score (`#dIntroRecords`, already unmasked above); `#btnDStartOver` is static
  copy. No team name, room code, place name, or map renders on this surface

### Cross-page
- `.leaflet-tooltip` — Leaflet pin labels carry team names on reveal maps
- `.pano-nav-hint` — the "Finding your way…" nav-arrows-loading pill (issue
  #3 follow-up): static, hardcoded copy only, no name/place/coordinate ever
  renders into it. No mask needed.
- `.mod-callout` — the pin-drop guess-modifier callout (guess-modifier design
  §5.3, amended A2 §2.5): its title + line come from `modifier.calloutSpec` —
  static, hardcoded tease copy ("Are you SUPER SURE?" / "Feeling sneaky?" / the
  co-equal both-tease "Raise the stakes?"), no team name, room code, place name
  or coordinate. Audited no-mask. (The guess map beneath it is no longer
  blocked — see §3 — which changes nothing here: the callout itself carries
  no identity.) No mask needed.
- **Render-death probe (§18, `docs/ios-blackout-review.md`) — no maskable
  surface added.** The probe's two GPU/2D scratch canvases — the `drawImage`
  sample canvas and the persistent 1×1 GPU canary — are created detached and
  **never enter the DOM** (`document.createElement` with no append), so there
  is nothing for `maskTextSelector`/`blockSelector` to match and nothing rrweb
  can record. The SDK's own on-page WebGL canvas IS captured now
  (`captureCanvas`, §3) — that is the point of the §18 work — but these two
  scratch canvases are not in the DOM, so they are not. The probe reads only
  our own viewer's
  context state (`gl.isContextLost()`) and a uniform-vs-content classification;
  no pixel, image id, coordinate, or user input is captured, logged, or sent —
  only the aggregate `render_probe`/`render_recovery` events (§5 of the spec).
  Audited no-mask. No mask needed.

## 3. Maps and pano: visible gameplay (was "blocked outright")

**Changed 2026-08-28 by owner decision.** `.leaflet-container` was removed
from `blockSelector`, so every Leaflet map now records normally: `#guessMap`,
`#hostRevealMap`, `#playerGuessMap`, `#pRevealMap`, `#dailyGuessMap`, the
daily reveal map, `#guessLiveMap`, `#revealMap`, `#h2hRevealMap`, the h2h TV
panel maps, the Daily "Your five places" carousel card maps
(`daily-ui.js#renderRecap`), and the party game-over recap maps (the phone
carousel cards built in `js/recap-ui.js` and the TV's `#tvRecapMap`). None of
them needs a per-id entry any more, in either direction.

**The old rationale, and why it was overridden.** Leaflet renders OSM tiles as
`<img src="…/{z}/{x}/{y}.png">`, so a tile path is literally a coordinate, and
this document previously argued that blocking was the only correct treatment.
The owner has ruled that a player's guess and the round's location are
*gameplay content*, not personal information, and that being able to watch
what the player actually saw outweighs keeping tile paths out of a recording.
That ruling is scoped to GeoParty and to session replay only.

**The pano (`captureCanvas`).** The Mapillary WebGL canvas is recorded too,
at `{ recordCanvas: true, canvasFps: 2, canvasQuality: "0.5" }`. Two things
about that config are load-bearing and were measured on 2026-08-28, not
assumed:

- **The object form is required.** posthog-js reads
  `session_recording.captureCanvas.recordCanvas`; a bare `captureCanvas: true`
  has no `.recordCanvas`, falls through to the project-side dial (off), and
  silently records nothing. A spike with the boolean form produced zero canvas
  frames while DOM mutations recorded normally.
- **posthog-js must initialise before the viewer is constructed.** WebGL
  canvases only read back if their context was created with
  `preserveDrawingBuffer: true`; posthog-js patches `getContext` to force that,
  but only for contexts created after `posthog.init`. A viewer built before
  opt-in keeps a non-preserving context and contributes no frames until it is
  rebuilt. This is why `js/viewer-ui.js` needs no change — and why a mid-game
  consent accept will not retroactively make the pano visible.

2 fps at quality 0.5 is the debuggability/bandwidth trade: enough to see "the
pano never painted", roughly 40 KB per frame at desktop canvas size.

**What did NOT change, and is still a ship-blocker:**

- `.leaflet-tooltip` stays in `maskTextSelector` (§2, Cross-page). Pin labels
  on the reveal maps carry **team names** — those are identity, and they are
  masked *inside* the now-visible map.
- Place-name captions outside the maps stay under their wholesale
  `#dDoneRecap` / `#hRecap` / `#pRecap` / `#tvRecap` masks (§2).
- **Any new reveal label** must still be added as a scene op in
  `js/revealmap.js` (the four reveal maps share `js/revealmap-ui.js`), and if
  such a label can ever render a team name or room code it needs a mask entry
  here — the map being visible is exactly why that now matters more, not less.
- Map tile hosts remain **absent from `NETWORK_HOST_ALLOWLIST`**, so tile
  requests are still dropped from the replay network waterfall
  (`tests/analytics.test.js` asserts this). Only the rendered pixels became
  visible; the network log did not.
- The analytics **event schema is unchanged**: no coordinate, no guess and no
  raw image id may ever become an event property. This decision touched replay
  masking only.

`[data-ph-block]` remains available for anything that must genuinely not be
recorded. Nothing in the app uses it today; adding it is the deliberate way to
opt a future surface out.

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
- [ ] The panorama area shows street imagery (owner decision 2026-08-28:
      gameplay is recorded), and it is NOT a blank/black box.
- [ ] The guess map and reveal map render real tiles and the player's pin;
      the pin tooltips (team names) are asterisks.
- [ ] The network tab shows `graph.mapillary.com/<id>`-shaped entries with
      **no** `?access_token=…`, and **no** `tile.openstreetmap.org` rows.
- [ ] No request/response headers or bodies are present.
- [ ] The console shows `Pool entry <8 chars> failed…`, not a 16-digit id.

Then flip the `replay-imagery-debug` flag (PostHog flag id **255025**) off
and confirm a second session records **nothing**.
