# Party game-over locations recap — implementation spec

Owner request (2026-08-24): the party game-over screens should have the
"where were the places" recap the Daily done screen already has — a
horizontally swipeable carousel of per-round mini-maps, each showing the
round's truth and the guess pins. The owner expected it to exist; it doesn't,
because the party flow keeps only the CURRENT `room.round` and every earlier
round's truth/guesses are overwritten in place (`rooms/{code}/round` is
replaced wholesale at `host-ui.js:700` / `player-ui.js:896`; there is no
history node anywhere in the RTDB schema — `docs/architecture.md` §data
model).

This spec is implementation-ready: data model, module seams, reuse plan,
per-surface behavior, masking, tests, instrumentation. Positions are taken,
not offered as menus. Status: **approved design, unimplemented.**

---

## 0. Decisions up front

| # | Decision | Position |
|---|---|---|
| D1 | Where the history lives | **Memory-only per-device accumulator**, folded at each reveal. No RTDB persistence. (§2.5 has the why and the upgrade path.) |
| D2 | Pure logic home | **New pure module `js/partyrecap.js`** (fold + cards + caption + scene). `js/recap.js` stays Daily-only; `recapEagerCount` is shared from it. |
| D3 | Reuse seam | **Extract the carousel DOM glue into a new `js/recap-ui.js`** (`createRecapCarousel`) and **refactor `daily-ui.js#renderRecap` onto it**. This is the owner's "real reuse" — not a copy of the glue. |
| D4 | Card content | All teams' pins in their team colors + the gold truth pin, per round. Couch solo rounds naturally show one pin (the active team's). **No SUPER SURE halos, no decoy chips, no pin tooltips** on recap cards (§2.4). |
| D5 | Surfaces | **All three.** Host phone + player phone get the swipeable carousel (identical to Daily). The TV gets a **single auto-cycling card** — it has no touch/pointer input (`screen.html` sets `pointer-events:none`), so a swipe carousel is dead UI there. TV is a severable second slice. |
| D6 | Companion refactor | **Converge `host-ui.js#renderHostRevealMap` (hand-rolled Leaflet, `host-ui.js:1417-1466`) onto `phoneRevealScene` + `renderRevealScene`** while we're forced to import the shared renderer into host-ui anyway. Severable if it surprises (§6.4). |
| D7 | Instrumentation | **New event `party_recap_engaged`**, mirroring `daily_recap_engaged` (latched once per game-over, fired on first carousel scroll). No TV event (§8). |

---

## 1. What exists and what's reused verbatim

The Daily recap stack, all of it kept:

- `js/recap.js` — Daily card derivation (`recapCards`, skew guard,
  `recapEagerCount`, `recapCardScene`, `recapCaption`). Only
  `recapEagerCount` is shared with the party; the rest stays Daily-only.
  Note `recapCaption` hardcodes `"Round N of 5"` (`recap.js:104`) — we do
  NOT parameterize it; the party gets its own caption (§2.3), and the Daily
  string stays byte-identical.
- `js/revealmap.js` — pure scene builders. `phoneRevealScene` (multi-pin,
  team colors) and `dailyRevealScene` (single/no pin) are exactly the two
  scenes party cards need. **No new scene builder required.**
- `js/revealmap-ui.js` — `renderRevealScene(containerIdOrEl, scene, hooks)`
  already accepts an element (the Daily passes card `mapEl`s,
  `daily-ui.js:956`) and returns `{destroy()}`. Untouched.
- CSS `.recap` / `.recap-title` / `.recap-carousel` / `.recap-card` /
  `.recap-card-map` / `.recap-caption` (`css/style.css:1514-1552`) — fully
  generic, reused as-is on the phones. A small TV-sizing block is added
  (§7.3).

Both modes already have a pure pin normalizer with an identical output
shape `{id, lat, lng, distanceKm, superSure, superSureOutcome}`:
`revealPins(round)` for h2h (`h2h.js:155-163`, farthest-first) and
`couchRevealPins(round, activeTeam)` for couch solo AND showdown
(`couchscreen.js:89-105`, which delegates showdowns to `revealPins`). The
accumulator builds on these — no new normalization logic.

---

## 2. Pure module: `js/partyrecap.js`

New pure module (no DOM, no Firebase, no network — the `game.js` /
`recap.js` discipline). Imports: `revealPins` from `./h2h.js`,
`couchRevealPins` from `./couchscreen.js`, `formatDistance` from
`./game.js`, `phoneRevealScene` and `dailyRevealScene` from
`./revealmap.js`. Tested in `tests/partyrecap.test.js` (§9.1).

### 2.1 History entry shape

```js
// One entry per revealed round, captured verbatim at reveal time:
{
  number: 3,                       // round.number, 1-based
  name: "Kyoto, Japan" | null,     // round.truth.name (null-safe)
  truth: { lat, lng },
  pins: [                          // revealPins/couchRevealPins output, verbatim
    { id: "t2", lat, lng, distanceKm, superSure, superSureOutcome },
    ...
  ],
}
```

Pins carry team SLOT ids (`t1`–`t4`) only — never a team name. The
accumulator is faithful (superSure fate rides along even though the card
scene drops it, §2.4) so a future surface can price it without a new fold.

### 2.2 The fold: `recordPartyRound(history, round, { mode, activeTeam })`

```js
export function recordPartyRound(history, round, { mode, activeTeam } = {}) 
```

Semantics, each unit-tested:

- **Pure**: never mutates `history`; on append it returns a NEW array.
- **Returns `history` unchanged (same reference)** when there is nothing
  valid to record, so glue can cheaply detect no-ops:
  - `round` nullish, or `round.number` not a finite positive number;
  - `round.truth` missing, or `truth.lat`/`truth.lng` non-finite (this
    covers the couch pool-exhaustion path that fakes `phase = "reveal"`
    with no final reveal, `host-ui.js:675-678`);
  - an entry with the same `number` already exists (**idempotence** — the
    fold is called from render paths that re-run on every Firebase echo).
- Pins: `mode === "h2h"` → `revealPins(round)`; otherwise →
  `couchRevealPins(round, activeTeam)`. `mode` is passed explicitly by the
  glue (each call site knows its mode statically); no shape-sniffing.
- A round where nobody pinned still records (entry with `pins: []`) — the
  truth is the thing being recalled.
- Appends `{number, name: round.truth.name || null, truth: {lat, lng},
  pins}`.

### 2.3 Cards and caption

```js
export function partyRecapCards(history)
// → [{ round, totalRounds, name, truth, pins }], sorted by round ascending.
//   totalRounds = highest round number present (rounds actually played —
//   honest when pool exhaustion ended the game early, and tolerant of a
//   gap from a device that missed a reveal snapshot). Malformed entries
//   are dropped. Empty/nullish in → [].

export function partyRecapCaption(card)
// "Round 2 of 7 · Kyoto, Japan · closest 12.4 km"
//   - name falls back to "Somewhere mysterious" (recapCaption's fallback);
//   - distance = min finite pins[].distanceKm via formatDistance;
//     prefixed "closest " only when pins.length > 1 (a couch solo card
//     reads "Round 2 of 7 · Kyoto, Japan · 12.4 km");
//   - zero pins → trailing part is "no pins";
//   - NO points and NO team names: points are multi-team here (the final
//     board sits right above the recap), and a name in the caption adds
//     no recall value the pin colors don't already carry.
```

### 2.4 Card scene: `partyRecapCardScene(card, teams)`

```js
export function partyRecapCardScene(card, teams) {
  if (card.pins.length === 0) {
    // Pinless round: dailyRevealScene's no-guess framing (zoom-4 view +
    // truth pin). phoneRevealScene would fitBounds a single point into a
    // meaningless close-up.
    return dailyRevealScene({ truth: card.truth, guess: null, ghost: null,
                              reducedMotion: false });
  }
  return phoneRevealScene({
    truth: card.truth,
    pins: card.pins.map((p) => ({ id: p.id, lat: p.lat, lng: p.lng })),
    decoys: [],
    teams,
  });
}
```

Deliberate omissions (D4): the SUPER SURE halo is stripped (mapping pins to
`{id, lat, lng}` disables `phoneRevealScene`'s halo branch) because its
permanent tooltip label is clutter on a 180px card and the bet's fate was
its reveal-moment story; decoys are not accumulated or drawn (round
theater, not geography recall); no pin tooltips (team colors are the
legend — they match the reveals the players just watched, and there are at
most 4). `teams` is passed only for `teamHex` color lookup and never
renders as text. No `reducedMotion` parameter: both party scenes are
static (empty cascade), and the Daily's only motion (the ghost beat) can't
occur here.

### 2.5 Why memory-only (D1), and the upgrade path

Memory-only mirrors the Daily (`playedPlaces`, `daily-ui.js:209`) and the
brief's stated preference. What it costs, honestly:

- a phone **refreshed mid-game** (couch resume via `LS_ACTIVE` →
  `host-ui.js:1866`; h2h resume via `LS_H2H_ACTIVE` → `enterRoom`) has
  only the rounds it witnessed after resuming;
- a **TV that joins late** or refreshes shows the same partial view;
- a device that missed a reveal snapshot on flaky network has a gap.

In every case the recap degrades to fewer cards and hides entirely at
zero (`box.classList.add("hidden")`, the Daily's `renderRecap` precedent).
Nothing lies; captions stay honest because `totalRounds` derives from what
was recorded. The normal flow — the couch host phone drives every reveal,
h2h phones join in the lobby and receive every reveal state — gets the
full recap.

Why not persist to `rooms/{code}/history/{n}`? It would buy
refresh-resilience and full late-TV recaps for one extra write per round
by the device that already writes `round.truth` — but it adds a new
multi-writer RTDB surface, a partial-write failure mode, and glue in the
exact layer this repo keeps thin, to serve exception paths. Not worth it
for v1. **Upgrade path**: the entry shape in §2.1 is designed to be
carried verbatim as `rooms/{code}/history/{number}`; if field data (or the
owner) later demands refresh-proof recaps, the writer is the truth-writing
device (couch host phone at `host-ui.js:1235`; in h2h the phone whose
submission flips `phase:"reveal"`), readers fold `history` into the same
accumulator, and `partyRecapCards` is unchanged. No privacy change either
way: these coordinates already transit RTDB in `round` today, and none of
this ever touches analytics (§8).

---

## 3. Shared DOM glue: `js/recap-ui.js` (the refactor, D3)

New thin module — the ONLY carousel builder, used by daily-ui, host-ui and
player-ui. It owns what `daily-ui.js:899-982` does today: card DOM,
lazy-init via IntersectionObserver with the eager-first-N fix, the
scroll-engagement latch, teardown.

```js
// recap-ui.js — thin DOM glue for the recap carousel (Daily done screen +
// party game-over). No decisions: scenes/captions/eager count come from
// the caller's pure functions; maps render via renderRevealScene only.
import { renderRevealScene } from "./revealmap-ui.js";
import { recapEagerCount } from "./recap.js";

export function createRecapCarousel({
  box,          // the .recap container element (shown/hidden here)
  carousel,     // the .recap-carousel element (cards appended here)
  cards,        // pure card objects
  sceneFor,     // (card) => scene        — pure, caller-supplied
  captionFor,   // (card) => string       — pure, caller-supplied
  onEngage,     // () => void | undefined — fired ONCE, on first scroll
}) → { destroy() }   // idempotent; disconnects observer, destroys map
                     // handles, clears carousel DOM, re-hides box
```

Behavior (moved verbatim from `daily-ui.js`, not reinvented):

- `cards.length === 0` → hide `box`, return an inert handle.
- One `div.recap-card` (`dataset.round`) per card, containing
  `div.recap-card-map` + `div.recap-caption` (text = `captionFor(card)`).
- Maps lazy-init on intersection (`root: carousel, threshold: 0.25`),
  with the first `recapEagerCount(cards.length)` cards initialized
  eagerly so a second map peeks in; no-`IntersectionObserver` fallback
  initializes all.
- Scroll listener (`passive: true`) fires `onEngage` exactly once per
  carousel instance (latch inside the handle, not module state).
- Every map goes through `renderRevealScene` — the imagery rule holds.

**`daily-ui.js` is refactored onto this**: `renderRecap` keeps only its
Daily-specific work (resolving `places` via `peekDayPlaces`/`playedPlaces`,
building cards via `recapCards`, the `daily_recap_engaged` call in
`onEngage`, error handling) and delegates the rest; `destroyRecap`
collapses to `handle?.destroy()`. Daily behavior must be observably
unchanged — same DOM classes, same eager count, same single engagement
event (existing `tests/recap.test.js` still passes untouched; the glue
gets its own test, §9.2).

---

## 4. Surface wiring — phones

Both phones follow the same three seams: **fold** at reveal, **reset** at
room entry, **render once** at game-over.

### 4.1 `player-ui.js` (h2h)

- Module state: `let roundHistory = [];` `let recapHandle = null;`
  `let recapBuiltFor = null;` `let recapEngagedTracked = false;`
- **Fold** in `onState` (the subscription callback, ~`player-ui.js:700`),
  NOT inside `renderReveal` — the pre-reveal `revealAt` hold branch
  early-returns and must not skip the fold:
  ```js
  if (room.phase === "reveal") {
    roundHistory = recordPartyRound(roundHistory, room.round, { mode: "h2h" });
  }
  ```
  Idempotence makes the per-echo re-call free.
- **Reset** in `enterRoom()` (`player-ui.js:536-560`, where every other
  per-room latch resets): `roundHistory = []`, `recapBuiltFor = null`,
  `recapEngagedTracked = false`, `recapHandle?.destroy()`.
- **Render** in `renderGameOver()` (`player-ui.js:2003`), latched exactly
  like the confetti (`winCelebrated`) so state echoes and the
  `stompsHandoff` re-render path never rebuild it:
  ```js
  if (recapBuiltFor !== room.createdAt) {
    recapBuiltFor = room.createdAt;
    recapHandle?.destroy();
    const cards = partyRecapCards(roundHistory);
    recapHandle = createRecapCarousel({
      box: $("pRecap"), carousel: $("pRecapCarousel"), cards,
      sceneFor: (c) => partyRecapCardScene(c, room.teams),
      captionFor: partyRecapCaption,
      onEngage: () => trackRecapEngaged("h2h", "player", cards.length),
    });
  }
  ```
- Every phone shows **all teams' pins** (each phone subscribes to the full
  room and folds the full results) — the recap mirrors the reveal map the
  player just watched, not a solipsistic own-pin view.

### 4.2 `host-ui.js` (couch)

- Same module state quartet.
- **Fold** at the end of `enterReveal()` (`host-ui.js:1469-1581`), after
  the truth is written into `room.round` (solo `:1199-1205`, showdown
  `:1300-1305` — both paths run before this point):
  ```js
  roundHistory = recordPartyRound(roundHistory, room.round,
    { mode: "couch", activeTeam: room.activeTeam });
  ```
  Covers solo (one pin) and showdown (all pins) via `couchRevealPins`.
  The pool-exhaustion finish (`host-ui.js:675-678`) fakes a truthless
  reveal — the fold no-ops, by design.
- **Reset** in `newGame()` (`host-ui.js:444-456`) and `newGameFromOver()`
  (`:1753`).
- **Render** inline in `finishGame()` (`host-ui.js:1621-1681`) next to
  `renderTotals`, same latch pattern, `mode: "couch"`, `surface: "host"`.
  The resume-into-gameOver path (`host-ui.js:1866-1882`) renders too —
  with an empty history it hides itself, which is the honest outcome.
- The recap renders regardless of `phoneIsScreen` — unlike the live
  reveal map, the recap is a personal recall aid, not the shared display;
  the host phone at game-over is being looked at either way.

---

## 5. Surface wiring — TV (slice 2, severable)

The TV keeps no round history and has no input, so (D5) it gets the same
accumulator and an **auto-cycling single card** instead of a carousel.

- `screen-ui.js` module state: `let roundHistory = [];`
  `let tvRecapFor = null;` `let tvRecapHandle = null;`
  `let tvRecapTimer = null;`
- **Fold** once in `render(state)` (`screen-ui.js:214`), covering both
  modes before mode dispatch:
  ```js
  if (state.phase === "reveal" && state.round) {
    roundHistory = recordPartyRound(roundHistory, state.round, {
      mode: state.mode === "h2h" ? "h2h" : "couch",
      activeTeam: state.activeTeam,
    });
  }
  ```
  (Couch solo truth exists only during reveal; h2h truth exists earlier
  but the fold's phase gate keeps the two modes uniform. A TV that joined
  mid-game simply accumulates from where it arrived — hide-if-empty.)
- **Reset** wherever the existing latches reset: `followRoom()`
  (`screen-ui.js:157-170`) and `leaveRoom()` (`:172-190`), plus timer/
  handle teardown.
- **Render** in `renderGameOver(state)` (`screen-ui.js:879-912`), latched
  on `tvRecapFor !== state.createdAt` (both modes route through this
  function — h2h game-over falls through to it at `:219-222`, so one call
  site covers everything). Behavior:
  - zero cards → `#tvRecap` stays hidden;
  - render card 1's scene into `#tvRecapMap` via
    `renderRevealScene` + `partyRecapCardScene`, caption into
    `#tvRecapCaption`;
  - if more than one card, a `setInterval` (7000ms) destroys the handle
    and renders the next card, wrapping around. Content swap, not
    animation — no reduced-motion branch needed (the scenes themselves
    are static);
  - the cycle timer and handle are cleared on `followRoom`/`leaveRoom`
    and when `render` shows any non-gameOver screen (couch `gameOver →
    lobby` is a legal transition, `game.js:13`).

---

## 6. Markup, CSS, and the companion refactor

### 6.1 `player.html`

Insert between `#pFinalTotals` (`player.html:195`) and `#pHandoffNote`
(`:196`):

```html
<div id="pRecap" class="recap hidden" data-ph-mask>
  <div class="recap-title">Where were the places</div>
  <div id="pRecapCarousel" class="recap-carousel"></div>
</div>
```

### 6.2 `host.html`

Insert between `#finalTotals` (`host.html:220`) and `#hSavedNote`
(`:223`), same block with ids `hRecap` / `hRecapCarousel`.

### 6.3 `screen.html` + CSS

Insert inside `.tv-center` after `#podium` (`screen.html:134`):

```html
<div id="tvRecap" class="recap tv-recap hidden" data-ph-mask>
  <div id="tvRecapMap" class="recap-card-map"></div>
  <div id="tvRecapCaption" class="recap-caption"></div>
</div>
```

CSS addition (the only CSS in this feature — phone carousel styles are
reused untouched):

```css
/* Party game-over recap, TV variant: no touch input on a TV, so one card
   auto-cycles instead of a swipe carousel. vh-sized like the podium. */
.tv-recap { max-width: 72vh; margin: 2vh auto 0; }
.tv-recap .recap-card-map { height: 28vh; border-radius: 12px; }
.tv-recap .recap-caption { font-size: 2.2vh; text-align: center; }
```

Title copy on the phones: **"Where were the places"** — the owner's own
phrase, in the Daily's `.recap-title` register ("Your five places").

### 6.4 Companion refactor R1 (D6): converge the couch reveal map

`host-ui.js` is the last surface drawing a reveal map with hand-rolled
Leaflet (`renderHostRevealMap`, `host-ui.js:1417-1466`, plus its private
`TEAM_HEX`/`teamHex`/`escapeHtml` copies at `:113-119`) — it predates the
`docs/revealmap-refactor.md` convergence and quietly violates the "only
`revealmap-ui.js` builds reveal maps" rule. The recap forces host-ui to
import `revealmap-ui.js` anyway, so finish the job:

- replace the body of `renderHostRevealMap` with
  `renderRevealScene("hostRevealMap", phoneRevealScene({ truth, pins:
  couchRevealPins(room.round, room.activeTeam), decoys: [], teams:
  room.teams }))`, keeping the existing `hostRevealMapFor` latch and
  `destroyHostRevealMap` teardown (now `handle.destroy()`);
- delete the local `TEAM_HEX`/`teamHex`/`escapeHtml` copies;
- masking is unchanged (`#hostRevealMap` is `.leaflet-container`, already
  blocked — checklist §3 already lists it).

This is ~50 deleted lines with behavior covered by the existing
`revealmap.js`/`revealmap-ui.js` suites. It is **severable**: if it turns
up a visual surprise (e.g. the current hand-rolled map draws something
`phoneRevealScene` doesn't), ship the recap without it and file the gap —
but the default is to land it in the same change.

---

## 7. Masking and privacy

Nothing in this feature touches analytics payloads, Firebase writes, or
URLs. The exposure surface is session replay only, and it follows the
`#dDoneRecap` precedent exactly:

- **Masked wholesale** (`data-ph-mask` in markup, §6): `#pRecap`,
  `#hRecap`, `#tvRecap` — captions carry place names.
- **Maps replay-visible**: every card map is rendered by
  `renderRevealScene` and is therefore a `.leaflet-container`; since the
  2026-08-28 owner decision (gameplay, not identity) these record
  normally, and tile hosts remain absent from `NETWORK_HOST_ALLOWLIST`
  (waterfall shows timing only).
- **Team names never render in the recap**: no pin tooltips (D4), no
  names in captions (§2.3); the accumulator holds slot ids only (§2.1,
  test-enforced §9.1).
- **`docs/replay-mask-checklist.md` updates in the same change**:
  - §2 host.html: `#hRecap` — masked wholesale, recap captions carry
    place names;
  - §2 player.html: `#pRecap` — same;
  - §2 screen.html: `#tvRecap` — same;
  - §3: note that the party recap card maps (phone carousel cards, built
    in `js/recap-ui.js`; TV `#tvRecapMap`) are `.leaflet-container`,
    blocked with no per-id entry — mirroring the existing Daily-recap
    paragraph;
  - re-run the §5 verify-on-a-real-recording pass (captions are
    asterisks; card maps are placeholder boxes).
- `tests/html-contract.test.js` test C then enforces the markup masks
  automatically (it parses checklist §2), and test B validates the new
  ids exist — the checklist entries and markup must land together or CI
  fails, which is the point.

---

## 8. Instrumentation (D7)

Product question: **do party players actually look back at the places?**
The Daily measures this (`daily_recap_engaged ÷ daily_challenge_completed`);
the party should answer the same question, especially since the owner
personally wanted this recall aid.

New event in `EVENT_SCHEMA` (`js/analytics.js`), documented in
`docs/analytics.md` (event table + a KPI row):

```js
// Party game-over "Where were the places" recap (docs/party-recap-spec.md).
// Fired at most ONCE per game-over render, when the recap is actually
// engaged — a carousel card scrolled. surface: "host" | "player" (the TV
// recap is passive — no interaction to measure, no event). Aggregates
// only: no place name, coordinate, or team name rides; rounds_shown is
// how many cards the carousel held (≤ settings.roundCount when a device
// missed rounds). Engagement rate = party_recap_engaged ÷ game_completed.
party_recap_engaged: {
  room: "string", mode: "string", surface: "string",
  rounds_shown: "int", source: "string",
},
```

- Call site: the `onEngage` callback passed to `createRecapCarousel`
  (§4.1/§4.2), latched per game via `recapEngagedTracked` (reset with the
  other per-room latches). `source` is `"swipe"`, matching the Daily.
- `room` matches the existing party events (`reveal_shown`,
  `game_completed`) for per-game joins; all properties are aggregates.
- **TV: no event, deliberately.** The TV recap has no user action to
  measure (auto-cycling), and "was a TV attached at game-over" is already
  answerable via `screen_joined` + `game_completed`. Instrumenting a
  timer would measure our own code.
- Tests: schema/sanitizer coverage in `tests/analytics.test.js` following
  the existing per-event pattern (and `tests/track-schema.test.js` keeps
  call sites honest).

---

## 9. Tests

### 9.1 `tests/partyrecap.test.js` (new — the load-bearing suite)

`recordPartyRound`:
1. couch solo reveal → one entry; pin id = `activeTeam`; truth/name
   carried; `name: null` when truth has no name.
2. couch showdown → all teams' pins, farthest-first (delegation to
   `revealPins` order observable).
3. h2h round → pins from `results`; forfeited teams absent from `pins`;
   an all-forfeit round records with `pins: []`.
4. Idempotence: folding the same `round.number` again returns the SAME
   reference; so do all the rejection paths (no round, no truth,
   non-finite truth coords, bad `number`).
5. Purity: the input array is never mutated; append returns a new array.
6. Privacy shape: every pin has exactly the keys
   `{id, lat, lng, distanceKm, superSure, superSureOutcome}` and `id`
   matches `/^t[1-4]$/` — no team name can enter the accumulator.

`partyRecapCards`: sorted ascending; `totalRounds` = max round number
(gap case: rounds 1 and 3 → two cards, `totalRounds: 3`); empty/nullish →
`[]`; malformed entries dropped.

`partyRecapCaption`: multi-pin → `closest` + `formatDistance` of the min;
single pin → plain distance; no pins → `no pins`; name fallback
"Somewhere mysterious"; round/total interpolation.

`partyRecapCardScene`: pins present → deep-equals
`phoneRevealScene({truth, pins: stripped, decoys: [], teams})` with
halo ops absent even for `superSure` pins; zero pins → deep-equals
`dailyRevealScene({truth, guess: null, ...})` (zoom-4 view). Mirrors the
scene-passthrough tests in `tests/recap.test.js`.

### 9.2 `tests/recap-ui.test.js` (new — the glue, tested anyway)

The repo already tests thin glue with fakes (`tests/revealmap-ui.test.js`
installs a fake `L`; `viewer-ui.test.js` precedent). Reuse that pattern
plus a minimal fake `document`/`IntersectionObserver`:

- N cards → N `.recap-card` elements with captions from `captionFor`;
- exactly `recapEagerCount(N)` maps initialized before any intersection;
- an intersection callback initializes that card's map once;
- `onEngage` fires exactly once across multiple scroll events;
- `destroy()` is idempotent: observer disconnected, every map handle
  destroyed, carousel emptied, box hidden;
- zero cards → box hidden, no observer created.

### 9.3 Existing suites

- `tests/recap.test.js` — untouched and green (Daily derivation
  unchanged; `recapCaption` still says "of 5").
- `tests/html-contract.test.js` — automatically covers the new ids
  (test B) and mask enforcement (test C) once the checklist is updated.
- `tests/analytics.test.js` / `track-schema.test.js` — new-event coverage
  (§8).
- R1 refactor: covered by existing `revealmap.js`/`revealmap-ui.js`
  suites; no new tests needed beyond what already pins
  `phoneRevealScene`.
- Gate: `npm test` all green, `npm run check` clean.

### 9.4 Deliberately untested (stated per repo rule)

The per-surface wiring diffs (fold call sites, reset lines, the TV cycle
timer) are thin glue in `*-ui.js` — syntax-checked, exercised manually.
Every decision they encode lives in `partyrecap.js`/`recap-ui.js` under
test.

---

## 10. Edge cases (all resolved above, collected)

| Case | Behavior |
|---|---|
| Pool exhaustion ends game early | Truthless fake reveal doesn't fold; recap shows the rounds that happened; `totalRounds` stays honest (§2.2, §2.3). |
| Phone refresh / couch resume mid-game | Partial history; recap shows witnessed rounds, hides at zero (§2.5). |
| TV joins late / refreshes | Same partial-or-hidden behavior (§5). |
| All-forfeit round | Card renders truth-only via `dailyRevealScene` framing; caption "no pins" (§2.4, §2.3). |
| Single-team couch (co-op "Everyone") | One pin per card, plain-distance caption — no special case. |
| Firebase echoes / `stompsHandoff` re-renders | Fold idempotent; render latched on `room.createdAt` (§4.1). |
| Crown Night multi-game | History is per room; next game = new room (`nextRoom`) → fresh accumulator via the reset seams. |
| `gameOver → lobby` (couch) / next-game handoff | Handles destroyed on reset/`newGame*`/screen change (§4, §5). |
| Reduced motion | Party scenes are static; the Daily's `reducedMotion` param isn't needed (§2.4). |
| Offline at game-over | Card tiles fail to load exactly like every existing Leaflet surface; no new degradation path. |

---

## 11. Implementation order

1. `js/partyrecap.js` + `tests/partyrecap.test.js`.
2. `js/recap-ui.js` + `tests/recap-ui.test.js`; refactor `daily-ui.js`
   onto it (Daily observably unchanged).
3. Player surface: `player-ui.js` wiring + `player.html` block +
   checklist §2 entry + `party_recap_engaged` schema/call/tests/docs.
4. Host surface: `host-ui.js` wiring + `host.html` block + checklist
   entry + **R1 companion refactor** (severable).
5. TV surface: `screen.html` block + CSS + `screen-ui.js` fold/render/
   cycle + checklist entry.
6. Docs: `docs/analytics.md` (event + KPI), `docs/replay-mask-checklist.md`
   (§2 ×3, §3 note), re-run the checklist §5 real-recording verify.

Steps 1–4 are the owner's ask (the phone screenshot); step 5 is the
"ideally the TV" slice and can trail by a commit without blocking. Rough
size: ~1.5–2 days including the R1 refactor and the recording verify.

**Acceptance:** finish a couch game and an h2h game on real devices —
each phone's game-over shows one card per played round with the correct
colored pins and gold truth; swiping fires exactly one
`party_recap_engaged`; the TV cycles cards at game-over; a PostHog
recording shows asterisk captions and placeholder-box card maps; the
Daily done screen is pixel-identical to before the refactor; `npm test`
and `npm run check` green.
