# The guess modifier — one class, one moment, one sheet

> **STATUS: DESIGN — ready to build (not implemented).** Authored by the
> architect (Fable) 2026-08-21 against the clean tree at `a9558cc`
> (v0.5.0, 784 tests green). Executor: build in **one change**, per the
> file-by-file plan in §8, with the tests in §6 and the analytics in §5.
> Supersedes the earlier SUPER-only pin-drop callout design (backed out;
> that doc no longer exists). Nothing here changes the *mechanics* of
> SUPER SURE or the Decoy — `js/supersure.js` and `js/decoy.js` resolution,
> settlement and reveal behavior are untouched.

## 1. Why (the problem, in numbers)

The product has a **class** of thing — the *location guess modifier*: an
attachment a team puts on its pin BEFORE locking in, once per game, hidden
from rivals until the reveal. Two instances exist:

| | SUPER SURE 🔥 | Decoy 🎭 |
|---|---|---|
| Modes | h2h + couch | h2h only |
| Effect | Double-or-nothing on being closest | Rivals' live view shows a fake pin |
| Economy | `teams/<tid>/superSureUsed` | `teams/<tid>/decoyUsed` (sibling) |
| Spend moment | lock-in | plant (first armed tap) |
| Resolution | reveal (`super_sure_resolved`) | reveal 🎭 beat (no win/lose) |

PostHog, last 14 days: SUPER SURE armed on **5/129** guesses (3.9%);
decoy planted on **1/129** (0.8%). Both are invisible at the moment that
matters — aiming. The current affordances (a mute 🔥 chip in the action
bar, plus a passive one-shot "Tap 🔥" hint card from round 2) are not
landing. There is also no decoy-specific analytics event, so the decoy
funnel can't even be measured.

Owner's reframe (binding intent): treat the class **coherently — one way
technologically and one UX treatment** — and make the pin-drop moment
*do something*: *"when you put a pin, it should do a good screen
interaction and say something like 'Are you SUPER SURE? Click this to
make it double or nothing!' — but good."*

This design gives the class: one pure module (§3), one discoverability
moment (§4), one instrumentation scheme (§5). It deliberately does NOT
touch reveal mechanics, the live-feed protocol, or hidden-until-reveal.

## 2. Design decisions and trade-offs (read first)

The choices below are the architect's calls; the builder should implement
them as written, not re-litigate them.

1. **The callout is a context pill, not a sheet.** §4.1 of
   `docs/ui-ux-design-review.md` defines a Context-pill layer (z 600)
   that is currently *empty* on the guess screen — "a slot, not a
   stack." The pin-drop callout occupies that slot, transiently. It must
   NOT be a sheet: the sheet layer is where the rule lives, at most one
   sheet at a time, and an auto-appearing sheet at pin drop would be an
   interruption every game. A pill teases; a tap converts it to the sheet.
2. **The callout tap opens the sheet; it does not arm directly.** The
   owner's verbatim ("Click this to make it double or nothing") could be
   read as one-tap arming. Rejected: a player who has never seen the rule
   would spend a hidden double-or-nothing without knowing the
   closest-pin condition. Tap → sheet (rule + "Arm the bet" primary) is
   one extra tap and keeps "each rule explained in exactly one place"
   intact. The callout carries the *stakes headline* as the hook — that
   is the owner's explicit ask and it stays a tease, not a rule.
3. **One callout per game per team — for whichever modifier is live.**
   One strong moment beats two. Priority: SUPER SURE first (the
   owner-endorsed hero), decoy tease only when SUPER is already spent.
   The spent-second modifier never gets its own second callout; it is
   reachable from the chip and as the cross-action on the sheet.
4. **Round 1 stays calm.** The callout fires from round 2 on (same
   deliberate rule as the old hint, §4.1 calm-state philosophy). Round 1
   is for learning the core loop.
5. **The old `SUPER_SURE_HINT` card is deleted, not kept alongside.**
   One treatment for the class. Two teaching surfaces for the same thing
   is exactly the clutter §6.1 removed.
6. **`super_sure_sheet_opened` is replaced by a generic
   `modifier_sheet_opened`.** Trade-off: we lose event-name continuity
   with 14 days of tiny baseline (a handful of events) and gain a
   parallel, per-modifier funnel forever. The old event's history remains
   queryable in PostHog; `docs/analytics.md` records the supersession.
7. **Modifier copy consolidates into the pure module.**
   `SUPER_SURE_SHEET` moves out of `hints.js`, the inline decoy sheet
   copy moves out of `player-ui.js`, both into `js/modifier.js` — the
   registry is the single home for every modifier's tease AND sheet copy,
   test-enforceable.
8. **Chip identity follows the class.** The chip's icon shows the
   highest-priority *available* modifier (🔥, else 🎭) instead of always
   🔥. The DOM id renames `btnSuperSure` → `btnModifier`, class
   `.ss-chip` → `.mod-chip`. Mechanical churn accepted once, now, while
   the class is being named.
9. **Callout-shown state is in-memory only.** A refresh mid-game may
   re-show the callout once. Accepted: persisting a per-team-per-game
   flag to Firebase or LS buys nothing worth the plumbing, and the
   callout is cheap to see twice.

## 3. The shared abstraction: `js/modifier.js` (pure, tested)

New pure module — no DOM, no network, same discipline as `game.js`.
`supersure.js` and `decoy.js` keep ALL mechanics (availability primitives,
resolution, settlement, reveal exposure, labels). `modifier.js` owns the
**class-level** decisions: what's available, what the chip shows, when the
callout fires, what every surface says, and the per-round deploy state.

### 3.1 The registry

```js
import { superSureAvailable } from "./supersure.js";
import { decoyAvailable } from "./decoy.js";

// Priority order IS array order: SUPER SURE is the hero tease; the decoy
// teases only when SUPER is spent. A third modifier slots in by adding an
// entry — no UI code changes.
export const MODIFIERS = Object.freeze([
  Object.freeze({
    id: "super",
    icon: "🔥",
    modes: Object.freeze(["h2h", "couch"]),
    // (teams, teamId, twistId) → bool. Delegates to the mechanic module.
    isAvailable: (teams, teamId, _twistId) => superSureAvailable(teams, teamId),
  }),
  Object.freeze({
    id: "decoy",
    icon: "🎭",
    modes: Object.freeze(["h2h"]),
    isAvailable: (teams, teamId, twistId) => decoyAvailable(teams, teamId, twistId),
  }),
]);
```

### 3.2 Availability + chip state

```js
// Ordered ids of modifiers this team can still play this round.
// deployState folds in round-local facts the team rows can't know:
// a planted decoy is no longer offerable this round even though
// decoyUsed was already written at plant time (belt and braces).
export function availableModifiers({ mode, teams, teamId, twistId, deployState })
  // → e.g. ["super", "decoy"] | ["decoy"] | []

// What the one chip renders. icon is the FIRST available modifier's icon;
// armed is true when ANY modifier is armed (super armed, or decoy armed /
// awaiting its plant tap). visible=false ⇒ chip hidden (spent = gone, §2.6).
export function modifierChipState({ available, deployState })
  // → { visible, icon, armed, ariaLabel }
```

`ariaLabel` comes from the registry ("SUPER SURE — once-per-game plays" /
"Decoy — once-per-game plays") so the a11y name tracks the icon.

### 3.3 The per-round deploy state (one fold, not two ad-hoc locals)

Replaces the `superSureArmed` boolean + `decoyState` pair each UI keeps
today with ONE state object and ONE fold, so both screens run the same
tested machine:

```js
export function modifierInitialState()
  // → { superArmed: false, decoy: decoyInitialState() }

// Actions:
//   { type: "arm",    id: "super" | "decoy" }
//   { type: "disarm", id: "super" }            // decoy has no disarm (spec §3.7)
//   { type: "tap" }                            // a guess-map tap
//   { type: "newRound" }                       // reset everything round-local
// Returns { state, place } where place is "decoy" | "pin" | null —
// the "tap" action delegates to decoyDeployFold and passes its verdict
// through untouched, so decoy.js remains the single owner of plant logic.
export function modifierFold(state, action)
```

`superArmed` survives `{type:"tap"}` (arming is per-pin but taps just move
the pin); `newRound` resets both (`superArmed` false, decoy state fresh —
exactly what both UIs do by hand today).

### 3.4 The callout decision

```js
// Which modifier to tease at this pin drop, or null. Fires only:
//   - mode "h2h" | "couch"
//   - roundNumber >= 2                    (round 1 calm)
//   - firstPinOfRound === true            (the moment: the tap that CREATED
//                                          the real pin, not moves/decoy taps)
//   - no result locked in yet
//   - at least one modifier available
//   - this team hasn't had a callout this game (calloutShown set)
// Priority = registry order.
export function shouldCalloutModifier({
  mode, roundNumber, available, firstPinOfRound, hasResult, calloutShown, teamId,
})
  // → "super" | "decoy" | null

// The per-game memory. Pure Set-in/Set-out so couch (per active team) and
// h2h (single team) share one shape. UIs keep it in a module-local,
// reset on game start.
export function markCalloutShown(calloutShown, teamId)  // → new Set
```

### 3.5 Copy — every modifier surface, one home

```js
// The tease (context pill). ≤ 2 short lines, stakes-headline hook only —
// the full rule lives in the sheet and nowhere else.
export function calloutSpec(id)
  // "super" → { title: "Are you SUPER SURE?",
  //             line:  "Tap for double or nothing 🔥" }
  // "decoy" → { title: "Feeling sneaky?",
  //             line:  "Tap to plant a decoy pin 🎭" }

// The sheet (the ONE place each rule is explained — review §6.1).
export const MODIFIER_SHEETS = Object.freeze({
  super: { title: "SUPER SURE",
           lines: [ /* verbatim current SUPER_SURE_SHEET.lines */ ],
           armLabel: "Arm the bet", cancelLabel: "Not now" },
  decoy: { title: "🎭 Decoy",
           lines: ["Plant a fake pin for rivals to see. Your real pin goes dark.",
                   "Once per game."],
           armLabel: "Plant the decoy", cancelLabel: "Not now" },
});

// The sheet's action rows, including the symmetric cross-offer: when BOTH
// are available, each sheet ends with a secondary action opening the other
// ("🎭 Plant a decoy instead" / "🔥 Arm SUPER SURE instead" — today only
// the SUPER sheet cross-offers; this makes it symmetric).
export function sheetActions({ id, available, deployState })
  // → [{ kind: "arm"|"disarm"|"keep"|"cancel"|"cross", label, target? }, ...]
```

`SUPER_SURE_SHEET`, `SUPER_SURE_HINT`, `SUPER_SURE_HINT_ID` and
`shouldHintSuperSure` are **deleted from `hints.js`** (and their UI call
sites removed). The sheet copy moves here verbatim; the hint dies (§2.5).

### 3.6 What stays instance-specific (do not move)

- `supersure.js`: `resolveSuperSure`, `superSureSettlement`,
  `adjustedPoints`, `superSureLabel` — and the hidden-until-reveal rule.
- `decoy.js`: `decoyDeployFold` internals, `canLockWithDecoy`,
  `plantedDecoy` / `revealDecoys` / `teamPlantedDecoy`, write-at-plant.
- `hints.js`: `lockButtonLabel`'s `superSureArmed` branch (the armed
  stakes on the primary button) — presentation of an armed SUPER bet,
  unchanged.
- All reveal rendering (×2 badge, 🎭 beat, halos) in the UIs.

## 4. The one discoverability treatment: the pin-drop callout

### 4.1 The moment and the element

The tap that **creates the team's first real pin of the round** (h2h:
`ensureGuessMap`'s click handler when `fold.place === "pin"` and no
`guessMarker` existed; couch: the same spot in `host-ui.js`) asks
`shouldCalloutModifier(...)`. On a non-null answer the UI shows the
**modifier callout**: a compact pill anchored in the context-pill slot
(z 600), horizontally centered above the action bar, never covering the
primary button (§4.4). New shared DOM glue in `js/modifier-ui.js`
(pattern: `hints-ui.js` — thin, unit-untested, all decisions upstream):

```
┌──────────────────────────────┐
│  Are you SUPER SURE?         │   ← title, 800 weight
│  Tap for double or nothing 🔥 │  ← line, body weight
└──────────────△────────────────┘  ← caret pointing down at the 🔥 chip
```

- **Tap the callout** → dismiss it, open the modifier's sheet
  (`via: "callout"`). This is the conversion path.
- **Anything else** — tapping the map (moving the pin), locking in,
  round/phase change, or an 8 s timeout — dismisses it silently. No ✕
  button; the whole pill is one 44 px+ tap target (§4.3).
- Shown **at most once per game per team** (§3.4). In couch mode "team"
  is the active team, so each team gets its one moment on its own turn;
  in h2h each phone is its team.
- While a sheet/hint card is open (§4.1: one sheet at a time), the
  callout is suppressed for that pin drop and NOT marked shown — it may
  fire on a later round's first pin instead. (In practice the guess-map
  one-shot only overlaps on round 1, where the callout never fires.)

### 4.2 States

| State | Callout | Chip |
|---|---|---|
| SUPER + decoy available (h2h) | SUPER tease | 🔥; sheet cross-offers 🎭 |
| SUPER only | SUPER tease | 🔥 |
| Decoy only (SUPER spent, h2h, not Blind) | Decoy tease | 🎭; its sheet cross-offers nothing |
| Blind Duel round, SUPER spent | none (decoy meaningless — `decoyAvailable` says no) | hidden |
| Both spent / couch with SUPER spent | none | hidden (spent = gone) |
| Round 1 | none, ever | chip present as normal |
| Already shown this game (this team) | none | chip carries on |

### 4.3 Feel ("good" — celebratory, not noisy)

- **Entry**: spring-pop riding the pin-drop energy — scale 0.6 → 1.06 → 1
  with ~8 px upward settle, ≈ 320 ms, `cubic-bezier(.34,1.56,.64,1)`
  (the existing `pin-drop` keyframe family's character). Simultaneously
  the 🔥/🎭 chip does ONE soft pulse (~250 ms scale beat) tying the pill
  to its permanent home, so the player learns where the power lives after
  the pill is gone. Total choreography < 350 ms (§4.5 cascade budget).
- **Exit**: 150 ms fade + 4 px downward drift.
- **Reduced motion**: `prefers-reduced-motion` collapses entry/exit to
  plain show/hide (the existing CSS media-query pattern; JS paths gate on
  `prefersReducedMotion()` from `fx-ui.js` where needed).
- **No sound, no vibration, no loop.** §4.5: sound only on state changes
  the player caused *and must notice*; the pin drop already has its own
  feedback. The callout is punctuation, not a jingle.
- CSS: `.mod-callout` (+ `.mod-callout .title`, caret pseudo-element),
  `@keyframes mod-callout-in`, in `style.css` next to the hint-card block.

### 4.4 Chip + sheet become modifier-generic

- `player.html` / `host.html`: `btnSuperSure` → `btnModifier`, class
  `.mod-chip`; icon text set from `modifierChipState().icon` at render
  (no hardcoded 🔥 in markup); `aria-label` from the same call.
- `renderSuperSureChip()` (both UIs) → `renderModifierChip()`: one call
  into `modifierChipState`, no inline availability logic, and the old
  one-shot-hint branch is deleted.
- `openSuperSureSheet` / `openDecoySheet` (both UIs) → one
  `openModifierSheet(id, via)` driven by `MODIFIER_SHEETS[id]` +
  `sheetActions(...)`, rendered through the existing `showHintCard`
  (sheet layer, one at a time — unchanged). Chip tap opens the first
  available modifier's sheet (`via: "chip"`); cross-action opens the
  other (`via: "cross"`).
- Arm/disarm/plant handlers keep their exact current effects (arming is
  local-only until lock-in; decoy plant writes `decoyUsed` at plant;
  `updateLockButton` still flips the ×2 stakes label) — they just route
  through `modifierFold`.

### 4.5 Copy discipline

The callout carries a stakes *hook* only ("double or nothing" / "plant a
decoy pin"); the closest-pin condition, the ×2/0 outcomes, the
once-per-game economy, and the decoy's real-pin-goes-dark rule appear in
exactly one place each — the modifier's sheet. No toasts gain rule copy;
the existing decoy plant-instruction toast ("Your next tap plants the
decoy…") stays, as it is procedural status, not a rule.

## 5. Analytics (schema + call sites + docs, one change)

All capture via `track()` from `js/consent.js`. Aggregates only — no
coordinates, no names, no image ids. ⚠ Property-naming trap: the
sanitizer's `BANNED_KEY_RE` (`/lat|lng|lon|coord|pin|guess$|name|email|device|user/i`)
would strip a key like `pin_drop` — never put "pin" in a property name.
`modifier`, `via`, `round_number` are all safe.

### 5.1 Events (`EVENT_SCHEMA` in `js/analytics.js`)

```js
// The pin-drop callout rendered. modifier: "super" | "decoy" (which tease).
// Top of the discovery funnel; at most one per game per team by design.
modifier_callout_shown: { mode: "string", modifier: "string", round_number: "int" },

// A modifier's sheet opened. via: "chip" | "callout" | "cross".
// REPLACES super_sure_sheet_opened (delete that entry): same funnel role,
// now per-modifier and per-path.
modifier_sheet_opened: { mode: "string", modifier: "string", via: "string" },

// A decoy was planted — the decoy's deployment moment (its analogue of
// super_sure_resolved; a decoy has no won/lost, so plant time IS its
// resolution). Fired on the planter's phone at plant. rounds mirrors
// super_sure_resolved for the timing KPI. mode is always "h2h" today;
// carried for uniformity.
decoy_planted: { mode: "string", round_number: "int", rounds: "int" },
```

`super_sure_resolved` and the `super_sure` / `decoy` flags on
`guess_submitted` are unchanged. `super_sure_sheet_opened` is removed
from the schema (supersession noted in `docs/analytics.md`; historical
data stays queryable in PostHog).

Call sites: callout render (both UIs) → `modifier_callout_shown`;
`openModifierSheet` → `modifier_sheet_opened` with its `via`; the
`fold.place === "decoy"` branch (next to the existing `decoyUsed` write)
→ `decoy_planted`.

### 5.2 KPIs (`docs/analytics.md` additions)

- **Modifier deployment rate** (the ship-judging number): share of
  guesses carrying each modifier — `guess_submitted.super_sure` vs
  baseline **5/129 = 3.9 %**; `guess_submitted.decoy` (+ `decoy_planted`
  for burned-pin rounds) vs baseline **1/129 = 0.8 %**. The callout
  exists to move these; if they don't move in 14 days, the callout copy
  (not the machinery) is the first suspect.
- **Discovery funnel, per modifier**: `modifier_callout_shown` →
  `modifier_sheet_opened (via="callout")` → deployed
  (`guess_submitted.super_sure=true` / `decoy_planted`), sliced by
  `modifier`. Plus the `via` mix on sheet opens — does anyone still find
  the chip unprompted?
- **SUPER SURE win/EV** — unchanged (`super_sure_resolved`). Decoy
  efficacy stays the existing rival-behavior join on
  `room + round_number` (deliberately no new event — §7).

### 5.3 Replay masking

The callout renders **static copy only** — no team name, room code, or
place name — so no `data-ph-mask` is required; the guess map beneath it
is already under `blockSelector`. Record exactly that verdict as a new
row in `docs/replay-mask-checklist.md` in the same change (the checklist
also records reviewed-and-clean surfaces).

## 6. Test matrix (`tests/modifier.test.js` + touched suites)

The pure surface the builder must cover (Node runner, `npm test`):

**availableModifiers / modifierChipState**
- h2h, nothing spent → `["super","decoy"]`; chip 🔥 visible.
- couch → `["super"]` always (decoy mode-gated); chip 🔥.
- h2h, SUPER spent → `["decoy"]`; chip icon 🎭.
- h2h, SUPER spent + Blind twist → `[]`; chip hidden.
- h2h, decoy planted this round (deployState) → decoy excluded.
- both spent → `[]`; chip hidden. Armed flag: superArmed OR decoy
  armed/awaiting-plant → `armed: true`.

**modifierFold**
- arm/disarm super toggles `superArmed`; `tap` with super armed →
  `place:"pin"`, `superArmed` survives.
- arm decoy → first `tap` → `place:"decoy"`, planted; second `tap` →
  `place:"pin"` (byte-for-byte `decoyDeployFold` passthrough).
- `newRound` resets both. Unknown action → state unchanged, `place` null.

**shouldCalloutModifier**
- round 1 → null in every configuration.
- round ≥ 2, first pin, both available → `"super"`; SUPER spent →
  `"decoy"`; none available → null.
- not `firstPinOfRound` / `hasResult` / teamId already in `calloutShown`
  → null. `markCalloutShown` is non-mutating and idempotent.
- couch: two teams, one shown → the other still fires.
- daily / unknown mode → null.

**Copy (the exactly-one-place rule, enforced)**
- `calloutSpec` lines never contain the sheet's rule phrases ("Closest
  pin", "once per game" — assert exact tease strings).
- `MODIFIER_SHEETS.super.lines` byte-equal to the previous
  `SUPER_SURE_SHEET.lines` (the rule text must not drift in the move).
- `sheetActions`: both available → each sheet ends with the cross-offer
  for the other; single → no cross row; armed super → Disarm/Keep pair.

**Analytics (`tests/analytics.test.js` / `track-schema.test.js`)**
- The three new/changed schema entries exist; `super_sure_sheet_opened`
  is gone; no new schema key matches `BANNED_KEY_RE` (existing sweep
  covers this — it must stay green).
- Sanitizer drops a smuggled `lat`/`decoy_lat` on the new events.

**Regression edits**
- `tests/hints.test.js`: drop the `SUPER_SURE_HINT` / `shouldHintSuperSure`
  cases (moved/deleted); `guessMapHintLines` unchanged.
- `tests/html-contract.test.js`: `btnModifier` present on both pages with
  a non-empty `aria-label`; `btnSuperSure` absent.
- `tests/supersure.test.js` / `tests/decoy.test.js`: untouched and green
  (mechanics unchanged — this is the proof).

## 7. Out of scope / deliberate deferrals

- **No mechanics changes**: resolution, settlement, ×2 badge, 🎭 reveal
  beat, live-feed shape, hidden-until-reveal, write-at-plant — all as-is.
- **No decoy-efficacy event** (e.g. nearest-rival-to-decoy distance).
  Answerable later via the existing `room + round_number` join; adding a
  derived-from-coordinates aggregate now is privacy-review surface with
  no decision riding on it yet.
- **No third modifier, no Daily/TV surface.** The registry makes a third
  instance cheap; none is being invented here. `screen-*.js`,
  `couchscreen.js`, `daily*.js` are untouched.
- **No persistence of callout-shown across refresh** (§2.9) and **no
  Firebase schema changes** — `superSureUsed`/`decoyUsed` stay the only
  durable economy fields.
- **No sound/haptic on the callout** (§4.3, §4.5).
- **Decoy disarm** (un-arming before the plant tap) stays unsupported,
  as today (spec §3.7).

## 8. Build order (one change, file by file)

1. `js/modifier.js` — new pure module (§3): registry, availability, chip
   state, fold, callout decision, copy, sheet actions.
2. `tests/modifier.test.js` — the §6 matrix (write alongside 1).
3. `js/hints.js` — delete `SUPER_SURE_SHEET`, `SUPER_SURE_HINT`,
   `SUPER_SURE_HINT_ID`, `shouldHintSuperSure`; `tests/hints.test.js`
   updated.
4. `js/modifier-ui.js` — new DOM glue: callout element build/teardown,
   entry/exit animation classes, tap-to-sheet wiring hook.
5. `js/player-ui.js` / `js/host-ui.js` — replace `superSureArmed` +
   `decoyState` with the fold; `renderModifierChip`;
   `openModifierSheet(id, via)`; callout trigger in the map-click
   handler's pin-creation branch; `track()` call sites (§5.1).
6. `player.html` / `host.html` — `btnModifier` (§4.4);
   `tests/html-contract.test.js` updated.
7. `style.css` — `.mod-chip` rename, `.mod-callout` + keyframes +
   reduced-motion collapse.
8. `js/analytics.js` — schema changes; `tests/analytics.test.js` cases.
9. `docs/analytics.md` (events + KPIs + supersession note),
   `docs/replay-mask-checklist.md` (callout row).
10. `npm test` all green, `npm run check` clean.
