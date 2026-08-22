# The guess modifier — one class, one moment, one sheet

> **STATUS: BUILT at `fd166cc` (807 tests green, live) — AMENDED A2
> (2026-08-22, owner corrections: round 1 reachable + co-equal options +
> arm-is-commit), BUILT-with-A2, live.** Precedence: **§A2 > §A1 > original**. Passages
> superseded by A2 are tagged **⚠A2** in place; by A1, **⚠A1** — the
> original rationale stays legible either way. A1 (single entry point,
> chip removed) otherwise stands in full. Original design authored by the
> architect (Fable) 2026-08-21 against the clean tree at `a9558cc`
> (v0.5.0, 784 tests green). Supersedes the earlier SUPER-only pin-drop
> callout design (backed out; that doc no longer exists). Nothing here —
> including A1 and A2 — changes the *mechanics* of SUPER SURE or the
> Decoy — `js/supersure.js` and `js/decoy.js` resolution, settlement and
> reveal behavior are untouched.

## A2. Amendment — round 1 reachable, co-equal options, arm = commit (2026-08-22)

Owner corrections (binding), after reviewing the A1 amendment:

1. *"Round 1 should absolutely be reachable. This is too much magic."* —
   the A1/§2.4 calm-first-round rule is **revoked**. With the chip gone it
   had made modifiers unreachable in round 1; the door opens from round 1.
2. *"While you have the ability to either [use] the super sure or the
   decoy it should just give you the option. This is being too cute."* —
   the **priority tease** (SUPER first, decoy only once SUPER is spent)
   is **revoked**. When both are available, the player is shown both,
   plainly and co-equally — the decoy is not tucked behind a cross-action.

The principle both corrections share, applied throughout A2: **nothing
about a modifier's discoverability may hide behind a state that isn't
obvious to the player** — not a round gate, not a priority sequence, not
an armed-only handle. One door, always open while there's something
behind it, showing everything that's behind it.

### A2.1 The gate fires from round 1

`shouldCalloutModifier` keeps the A1.2 stateless signature; two changes:
the round gate goes, and the return value is the **full ordered
`available` array** (feeding §A2.2), not `available[0]`.

| Condition | Result |
|---|---|
| `mode` not `"h2h"` \| `"couch"` | `null` (never on the Daily) |
| `roundNumber` not a number ≥ 1 | `null` (defensive only — no calm gate) |
| `!firstPinOfRound` | `null` (only the tap that CREATED the real pin) |
| `hasResult` | `null` (already locked in) |
| `available` empty | `null` (spent / mode-gated — self-extinguishes) |
| otherwise | `available` (ordered, non-empty) — every qualifying round |

Round-1 overlap, handled by an existing rule: the round-1 guess-map
one-shot hint card may already be open at the first pin drop. The A1.2
suppression rule (suppress while a sheet/hint is open, do NOT latch)
covers it — the callout simply fires on round 2's first pin instead. No
new mechanism.

Everything else in §A1.2 stands: stateless recurrence every round while
unspent, `markCalloutShown`/`calloutShown` deleted, pin moves do not
dismiss the pill, dismissal set = tap-to-convert / lock-in / round or
phase change / 8 s timeout.

### A2.2 Both options, presented together

**The tease.** `calloutSpec` now takes the ordered available array and
covers the both-case with a class-level hook:

```js
export function calloutSpec(available)
  // ["super","decoy"] → { title: "Raise the stakes?",
  //                       line:  "🔥 Double or nothing · 🎭 Decoy pin" }
  // ["super"]         → { title: "Are you SUPER SURE?",
  //                       line:  "Tap for double or nothing 🔥" }
  // ["decoy"]         → { title: "Feeling sneaky?",
  //                       line:  "Tap to plant a decoy pin 🎭" }
```

**The sheet.** The callout tap opens ONE sheet presenting every available
modifier as a **co-equal section** — its `MODIFIER_SHEETS` rule lines and
its own primary action, stacked in registry order (display order only,
not priority):

```
🔥 SUPER SURE      — rule lines —   [ Arm the bet ]
🎭 Decoy           — rule lines —   [ Plant the decoy ]
                                    [ Not now ]
```

One available modifier → its section alone, exactly the A1 single sheet.
The **cross-offer rows die** — there is nothing to cross to when
everything available is already on the sheet as a first-class option.
`sheetActions` reshapes accordingly:

```js
// Co-equal action rows for every available modifier, registry order,
// then one cancel. No cross rows, no disarm rows (§A2.3).
export function sheetActions({ available, deployState })
  // both → [ { kind: "arm", id: "super", label: "Arm the bet" },
  //          { kind: "arm", id: "decoy", label: "Plant the decoy" },
  //          { kind: "cancel", label: "Not now" } ]
```

"Each rule explained in exactly one place" holds: both sections render
from the unchanged `MODIFIER_SHEETS` copy — showing two rules on one
sheet is composition, not duplication. A planted-this-round decoy is
excluded by `availableModifiers` as before.

### A2.3 Disarm resolved: arming commits — no pill, no second element ★ DECISION FOR OWNER

The §A1.3 armed pill is **dropped before ever being built**. Chosen
mechanism: **"Arm the bet" is a commitment — there is no disarm path at
all.** `{type:"disarm"}` leaves `modifierFold`, Disarm/Keep rows leave
`sheetActions`, `armedPillSpec` and the `sticky` callout option are never
created, `via:"armed"` never joins the schema.

Why this is the option consistent with the owner's principle:

- The armed state is already standing and unmissable in the one right
  place: the **lock-button stakes flip** ("🔥 Lock in — double or
  nothing", `lockButtonLabel`'s armed branch). That is the confirmation
  surface — on the primary action, where the money changes hands.
- The path into arming is deliberate: pill → sheet → read the rule → tap
  the primary. An accidental arm is implausible; a two-tap accident
  deserves a two-tap cost, not a standing UI element for everyone.
- The blast radius is one round: `newRound` clears the armed state, and
  the actual spend (`superSureUsed`) still lands only at lock-in.

**The trade-off, named plainly:** a player who arms and changes their
mind must ride the bet for that round — locking in means the
once-per-game SUPER is consumed as a double-or-nothing they no longer
want. There is no undo. Rejected alternatives: the persistent armed pill
(a second standing element — the exact thing the owner killed); making
the armed lock-tap open a Disarm/Keep sheet first (adds a friction step
to every *intended* lock-in — cute); a long-press or similar hidden
affordance (hidden state, worse than either).

**Copy consequence (one line):** the SUPER sheet's `lines` gain one
appended line so the commitment is stated in the one place rules live:

> `"Once armed, the bet is on — no backing out this round."`

The §6 byte-equality test amends to: original `SUPER_SURE_SHEET.lines`
preserved verbatim, plus exactly this line appended. The Decoy sheet is
unchanged — it was already no-disarm, spend-at-plant (§3.7).

This is the one A2 decision flagged for explicit owner sign-off; if he
wants an undo instead, the fallback is the §A1.3 armed pill as specced.

### A2.4 Analytics deltas (on top of §A1.4)

- **`modifier_callout_shown.modifier`** gains the live value `"both"`
  (schema shape unchanged — it's a string). Cadence: per round **from
  round 1**, self-extinguishing when spent.
- **`modifier_sheet_opened`**: `modifier` likewise gains `"both"`; the
  `via` live set collapses to `{"callout"}` — `"chip"`, `"cross"` and
  `"armed"` are all dead (single door, no cross rows, no armed pill).
  Keep the property for schema stability; note the single live value in
  `docs/analytics.md`.
- Which co-equal option got picked needs no new event — the pick is
  already the deployment (`guess_submitted.super_sure` /
  `decoy_planted`). The A1 "armed-review share" KPI dies with disarm.
- No new property keys; nothing new can match `BANNED_KEY_RE` (still no
  "pin" in any name).
- `docs/analytics.md`: funnel rows now read from round 1;
  `round_number` may be 1.

### A2.5 Replay masking

Unchanged verdict: the callout (all three teases) and the combined sheet
render static registry copy only — no team name, room code or place name
→ no `data-ph-mask`. The `.mod-callout` row in
`docs/replay-mask-checklist.md` covers the tease only (drop A1.5's
armed-state wording); the sheet renders through the existing
already-reviewed sheet surface.

### A2.6 Test deltas (replaces §A1.6 where they touch)

- **`shouldCalloutModifier`**: fires on round **1** (assert rounds 1, 2
  and 5 all fire — no memory, no calm gate); returns the full ordered
  array (both available → `["super","decoy"]`, SUPER spent →
  `["decoy"]`); non-numeric round / `!firstPinOfRound` / `hasResult` /
  daily-or-unknown mode / empty `available` → null; couch: both teams'
  turns fire in the same round, including round 1.
- **`calloutSpec`**: all three variants' exact strings, including the
  both-tease; no rule phrases in any tease (§4.5 sweep now covers the
  both-tease too).
- **`sheetActions`**: both available → exactly two co-equal `arm` rows in
  registry order + one cancel; single → one `arm` row + cancel; **no
  cross rows and no disarm rows in any configuration**.
- **`modifierFold`**: disarm cases deleted; a stray `{type:"disarm"}`
  falls under the unknown-action row (state unchanged, `place` null).
- **SUPER sheet copy**: original lines byte-preserved + the exact §A2.3
  commitment line appended, and nothing else.
- **No `armedPillSpec` tests** — the function never exists.
- Unchanged from A1.6: the html-contract retired-ids assertion
  (`btnModifier`, `btnSuperSure` in no page HTML), the chipState /
  markCalloutShown test deletions, and green untouched
  `supersure` / `decoy` / `hints` / analytics-sweep suites.

### A2.7 Build order (one change, replaces §A1.7)

1. `js/modifier.js` — A1.1 deletions (`modifierChipState`, `anyArmed`,
   `markCalloutShown`, registry `ariaLabel`); `shouldCalloutModifier`
   per §A2.1 (array return, round 1); `calloutSpec(available)` with the
   both-tease; `sheetActions` co-equal, no cross/disarm; `disarm` action
   removed from `modifierFold`; SUPER sheet commitment line appended.
2. `tests/modifier.test.js` — the §A2.6 matrix, written alongside 1.
3. `js/modifier-ui.js` — delete `pulseModifierChip`; no `sticky` option,
   no `armed` class (never built).
4. `js/player-ui.js` / `js/host-ui.js` — delete all chip glue and the
   `calloutShown` Sets; stop dismissing the callout on map taps;
   `openModifierSheet` renders the available list as co-equal sections;
   `via: "callout"` only.
5. `player.html` / `host.html` — remove `btnModifier` + comments;
   `tests/html-contract.test.js` retired-ids assertion.
6. `css/style.css` — chip CSS out, caret out, reduced-motion block
   updated; no `.mod-callout.armed` (never built); combined sheet reuses
   the existing sheet styles.
7. `js/analytics.js` schema comments; `docs/analytics.md` (§A2.4);
   `docs/replay-mask-checklist.md` (§A2.5).
8. `npm test` all green, `npm run check` clean; flip this doc's STATUS
   banner to BUILT-with-A2.

### A2.8 Unchanged, reaffirmed

Everything in §A1.8, plus: the chip stays dead (A1.1), the callout stays
the single door with stateless per-round recurrence (A1.2 minus the
round gate), hidden-until-reveal, both mechanics modules, the
lock-button stakes flip, `screen-*.js` / TV / Daily untouched, no
Firebase schema changes, consent gating and the `track()`-only rule.

## A1. Amendment — one door only (2026-08-22)

Owner direction (binding, after playing the shipped build): *"The flame
button still exists on the bottom left. I want the only way to do double
or nothing or a decoy pin to be through the main 'putting a pin down'
action. It should not have multiple entry points. That crowds and
clutters conceptually and visually."*

So: the chip dies; the pin-drop callout becomes the **single, recurring**
door to the whole modifier class. The lock-button stakes flip stays (a
confirmation on the primary action, not an entry point) ~~and the sheet
cross-offers stay (inside the one door, not a second one)~~ **⚠A2: the
cross-offers die too — when both modifiers are available the one sheet
shows both co-equally, so there is nothing to cross to (§A2.2).**

### A1.1 Remove the chip — everywhere, with no replacement

Exact removal inventory:

- **`player.html` / `host.html`**: the `btnModifier` button and the
  action-bar comment blocks that describe it. No replacement element.
- **`js/player-ui.js`**: `renderModifierChip`, `onModifierChipTap`, the
  `$("btnModifier")` listener, every `renderModifierChip()` call site,
  and the `calloutShown` module local + its game-start reset (§A1.2).
- **`js/host-ui.js`**: the same set — including the render at the
  lock-restore path ("armed state is local; a refresh disarms").
- **`js/modifier-ui.js`**: `pulseModifierChip` (and its import in both
  UIs). The pill-to-chip pulse choreography (§4.3) has no home to point
  at anymore.
- **`js/modifier.js`**: `modifierChipState`, the private `anyArmed`
  helper, `markCalloutShown` (§A1.2), and the registry's `ariaLabel`
  field (it existed only for the chip; the callout builds its own a11y
  name from `calloutSpec`). **Keep**: `MODIFIERS`, `availableModifiers`,
  `modifierInitialState` / `modifierFold`, `calloutSpec`,
  `MODIFIER_SHEETS`, `sheetActions`.
- **`css/style.css`**: the `.mod-chip` block (+ `.armed`),
  `mod-chip-pulse` keyframes + `.mod-pulse`, the 48 px chip width rule,
  the chip lines in the reduced-motion block, and the callout's caret
  `::after` — it pointed down at the chip; the pill is now
  self-contained, so the caret goes too.

"Spent = gone" (§2.6) was communicated by chip absence; now it is
communicated by the callout simply never firing again (§A1.2's gate
self-extinguishes when `available` is empty). No replacement indicator.

The html-contract reference scan already fails any leftover
`$("btnModifier")` in JS once the HTML id is gone; §A1.6 adds an explicit
retired-id assertion on top so the owner's decision is regression-locked.

### A1.2 The callout recurs — every round's first pin, while unspent

> **⚠A2:** two pieces of this section are revoked — the `roundNumber < 2`
> row / "round 1 stays calm" decision (owner: round 1 must be reachable,
> §A2.1) and the `available[0]` priority return (owner: present both,
> §A2.2). The stateless recurrence, the deletions, and the dismissal-set
> decision below all stand.

Old rule (⚠ §2.3, §3.4): once per game per team, with the chip as the
standing second-chance door. With the chip gone, once-per-game would mean
a player who lets one pill time out can never bet again. New rule — the
gate is **stateless**:

```js
// Which modifier to tease at this pin drop, or null. Priority = registry
// order. Fires on EVERY round's first real-pin drop while at least one
// modifier is still available — no per-game memory. calloutShown/teamId
// parameters are DELETED.
export function shouldCalloutModifier({
  mode, roundNumber, available, firstPinOfRound, hasResult,
})
```

| Condition | Result |
|---|---|
| `mode` not `"h2h"` \| `"couch"` | `null` (never on the Daily) |
| `roundNumber < 2` (or not a number) | `null` (round 1 calm — decision below) |
| `!firstPinOfRound` | `null` (only the tap that CREATED the real pin) |
| `hasResult` | `null` (already locked in) |
| `available` empty | `null` (spent / mode-gated — self-extinguishes) |
| otherwise | `available[0]` — every qualifying round |

`firstPinOfRound` is itself the once-per-round latch: the pin-creation
tap happens exactly once per round (h2h) / per team turn (couch). So the
per-game memory goes entirely: **`markCalloutShown` is deleted** from
`modifier.js` and the `calloutShown` Set + reset is deleted from both
UIs. The sheet-open suppression rule keeps its behavior (suppress, don't
latch) and loses its caveat — the callout simply fires again on the next
round's first pin by construction.

**⚠A2 (VETOED — the owner exercised exactly this veto; §A2.1 flips the
gate to `roundNumber >= 1`.)** ~~**Decision — round 1 stays calm (owner
may veto).**~~ The §2.4 calm rule is
retained: no callout in round 1 — and with the chip gone that now means
**modifiers are unreachable in round 1**, a capability the chip used to
provide. Architect's call: round 1 is for learning the core loop, and a
hidden double-or-nothing before a player has calibrated distance and
scoring is a trap, not agency. If the owner wants round-1 access, the
change is one row of this truth table (`roundNumber >= 1`) — say so at
approval and the builder flips it.

**Decision — pin moves no longer dismiss the pill.** The old rule
dismissed the callout on any map tap; that was fine while the chip
remained as the standing door. Now the pill IS the only door, and a
player's first instinct after dropping a pin is to drag and adjust it —
killing the door for that is hostile. New dismissal set: tap-to-convert,
lock-in, round/phase change, or the 8 s timeout. (The pill sits above the
action bar, not over the map — leaving it up during adjustment occludes
nothing.) The 8 s timeout stays as the calm ceiling; per-round recurrence
makes each round a fresh window, and the §A1.4 per-round funnel will show
if that window is too short.

### A1.3 The armed pill — the way back into a bet in flight

> **⚠A2 (this whole section):** the armed pill is dropped before ever
> being built. §A2.3 resolves disarm the other way — arming commits, no
> disarm path, no second standing element. `armedPillSpec`, the `sticky`
> option, `.mod-callout.armed` and `via:"armed"` are never created.

Removing the chip orphans **disarm**: today an armed SUPER's Disarm/Keep
sheet is reachable only by tapping the chip. Deleting disarm outright
would make "Arm the bet" an irrevocable round commitment — a regression
in player agency the owner didn't ask for. The amendment keeps disarm
reachable without adding a second entry point:

After "Arm the bet", the **same pill element** returns in a persistent
**armed** state — "🔥 Double or nothing — armed / Tap to review or
disarm" — in the same context-pill slot, until lock-in, disarm, or a
round/phase change (no 8 s timeout). Tapping it reopens the SUPER sheet
(`via: "armed"`) with the existing Disarm / Keep rows — and the decoy
cross-offer when both are live (`sheetActions` unchanged), so the decoy
also stays reachable after arming.

Why this is not a second entry point: it can only exist *after* the
player entered through the one door and placed a bet. It is the handle on
a bet in flight — the state the lock-button flip already shows, made
tappable — not a discovery path. One element, one slot, two states
(tease ↔ armed), never both at once.

Scope: **SUPER only.** A decoy's armed phase is momentary (the next tap
plants it — the existing procedural toast covers it) and a planted decoy
is spent with no disarm (§3.7). No pill for decoy states.

Accepted edge: disarming closes the pill, and re-arming that same round
has no door until the next round's tease. (The chip allowed infinite
same-round toggling; one deliberate arm + one deliberate disarm per round
is agency enough.)

Pure support (`js/modifier.js`, tested):

```js
// The armed pill's copy, or null when no pill should show. Only an armed
// SUPER qualifies; decoy states never produce a pill. Copy discipline
// (§4.5) applies: status only, no rule phrases.
export function armedPillSpec(deployState)
  // superArmed → { id: "super", title: "🔥 Double or nothing — armed",
  //                line: "Tap to review or disarm" }
  // otherwise  → null
```

DOM glue (`modifier-ui.js`): `showModifierCallout(spec, onTap,
{ sticky: true })` — sticky skips the 8 s timer and adds an `armed`
class. Callers: `armModifier("super", true)` shows it,
`armModifier("super", false)` dismisses it; lock-in and round/phase
transitions already call `dismissModifierCallout()`.

CSS: `.mod-callout.armed` — same pill geometry, armed tint (reuse the old
`.mod-chip.armed` accent), same entry animation, no loop or pulse.

### A1.4 Analytics — same schema shapes, new cadence, one new `via`

> **⚠A2:** `via:"armed"` never joins (no armed pill) and the armed-pill
> bullets below are void; `modifier` gains the live value `"both"` and
> the cadence starts at round 1 — see §A2.4. The rest stands.

No `EVENT_SCHEMA` shape changes. Deltas:

- **`modifier_callout_shown`** cadence: now up to once per **round** per
  team (self-extinguishing when spent). Update the schema comment and the
  `docs/analytics.md` row ("at most one per game per team" → per round).
  Funnel math changes: read conversion per-round (`modifier_callout_shown
  → modifier_sheet_opened (via="callout")` within the same
  `round_number`), not per-game.
- **`modifier_sheet_opened.via`**: `"chip"` retires with the chip;
  `"armed"` joins. Live values: `"callout" | "cross" | "armed"`. The
  "does anyone still find the chip unprompted?" KPI question dies; its
  replacement: the `via="armed"` share shows how often armed bets get
  reviewed or disarmed.
- The armed pill emits **nothing at render** — it appears as a
  deterministic side-effect of arming (already visible in the funnel as
  the sheet-open → arm step), so a shown-event would be redundant signal.
  Its tap-through is captured by `via: "armed"`.
- `decoy_planted`, `super_sure_resolved`, the `guess_submitted` flags:
  unchanged. No new property keys; nothing new can match
  `BANNED_KEY_RE` (no "pin" in any name — `via`, `round_number` safe).

### A1.5 Replay masking

> **⚠A2:** no armed state exists; the checklist row covers the tease (all
> three variants) only — see §A2.5.

The armed pill, like the tease, renders static hardcoded copy only
(`armedPillSpec`) — no team name, room code, or place name → no
`data-ph-mask`. Extend the existing `.mod-callout` row in
`docs/replay-mask-checklist.md` to cover both states (tease + armed), and
drop any stale chip mention, in the same change. The chip's removal
deletes a surface; deletions need no new row.

### A1.6 Test deltas (`tests/modifier.test.js` + touched suites)

> **⚠A2:** superseded where it touches the round gate, the priority
> return, and `armedPillSpec` — build against the §A2.6 matrix instead.
> The deletions and the retired-ids assertion stand.

- **`shouldCalloutModifier` truth table rewritten** to the stateless
  signature: round 1 → null in every configuration; round ≥ 2 first pin +
  available → `available[0]` on EVERY qualifying round (assert rounds 2
  AND 5 both fire, no memory between); SUPER spent mid-game → later
  rounds tease `"decoy"` (h2h); both spent → null; `!firstPinOfRound` /
  `hasResult` / daily-or-unknown mode → null; couch: two teams' turns
  both fire in the same round (no cross-team state).
- **Delete**: all `modifierChipState` tests, all `markCalloutShown`
  tests.
- **Add `armedPillSpec`**: initial state → null; `superArmed` → the exact
  `{ id, title, line }` (and assert no rule phrases — the §4.5
  exactly-one-place rule applies to the armed pill too); decoy
  armed/planted without `superArmed` → null.
- `modifierFold`, `sheetActions`, sheet-copy byte-equality tests:
  **untouched and green** (the fold, the sheet, and both mechanics are
  unchanged — the proof, again).
- **`tests/html-contract.test.js`**: add a retired-ids assertion —
  `btnModifier` and `btnSuperSure` appear in NO page HTML. (The existing
  reference scan already fails any leftover `$("btnModifier")` in JS.)
- `tests/supersure.test.js`, `tests/decoy.test.js`, `tests/hints.test.js`
  (incl. `lockButtonLabel`'s armed branch), `tests/analytics.test.js` /
  `track-schema.test.js` sweeps: untouched and green.

### A1.7 Build order (one change)

> **⚠A2:** superseded in full by §A2.7 (same skeleton, minus the armed
> pill / sticky steps, plus the A2 gate, co-equal sheet and commitment
> line).

1. `js/modifier.js` — delete `modifierChipState` / `anyArmed` /
   `markCalloutShown` + the registry `ariaLabel` field; reshape
   `shouldCalloutModifier` (§A1.2); add `armedPillSpec` (§A1.3).
2. `tests/modifier.test.js` — the §A1.6 matrix, written alongside 1.
3. `js/modifier-ui.js` — delete `pulseModifierChip`; add the `sticky`
   option + `armed` class.
4. `js/player-ui.js` / `js/host-ui.js` — delete all chip glue and the
   `calloutShown` Sets; stop dismissing the callout on map taps; wire the
   armed pill from `armModifier`; `via: "armed"`.
5. `player.html` / `host.html` — remove `btnModifier` + comments;
   `tests/html-contract.test.js` retired-ids assertion.
6. `css/style.css` — chip CSS out, caret out, `.mod-callout.armed` in,
   reduced-motion block updated.
7. `js/analytics.js` schema comments; `docs/analytics.md` (§A1.4);
   `docs/replay-mask-checklist.md` (§A1.5).
8. `npm test` all green, `npm run check` clean; flip this doc's STATUS
   banner to BUILT-with-A1.

### A1.8 Unchanged, reaffirmed

Hidden-until-reveal; `supersure.js` / `decoy.js` mechanics; the
lock-button stakes flip (`hints.js` `lockButtonLabel` armed branch) — a
confirmation on the primary action, not an entry point; ~~sheet
cross-offers — inside the one door~~ (**⚠A2:** replaced by co-equal
sections, §A2.2); `screen-*.js` / TV / Daily untouched;
no Firebase schema changes; no sound or haptics; consent gating and the
`track()`-only rule.

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
3. **⚠A1 (superseded — §A1.2: the callout now recurs every round while
   a modifier is unspent; the chip no longer exists as the second-chance
   door.) ⚠A2 (§A2.2: the priority ordering is revoked too — both
   modifiers present co-equally when both are available.)**
   ~~One callout per game per team~~ — for whichever modifier is live.
   One strong moment beats two. Priority: SUPER SURE first (the
   owner-endorsed hero), decoy tease only when SUPER is already spent.
   The spent-second modifier never gets its own second callout; it is
   reachable from the chip and as the cross-action on the sheet.
4. **⚠A2 (REVOKED by the owner — "Round 1 should absolutely be
   reachable. This is too much magic." §A2.1 fires from round 1.)**
   ~~Round 1 stays calm.~~ The callout fires from round 2 on (same
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
8. **⚠A1 (superseded — §A1.1: the chip is REMOVED entirely, by owner
   direction. The callout is the only entry point.)** ~~Chip identity
   follows the class.~~ The chip's icon shows the
   highest-priority *available* modifier (🔥, else 🎭) instead of always
   🔥. The DOM id renames `btnSuperSure` → `btnModifier`, class
   `.ss-chip` → `.mod-chip`. Mechanical churn accepted once, now, while
   the class is being named.
9. **⚠A1 (superseded — §A1.2: there is no callout-shown state at all
   anymore; the gate is stateless.)** ~~Callout-shown state is in-memory
   only.~~ A refresh mid-game may
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

> **⚠A2:** array order is now **display order only** (tease line, sheet
> sections, action rows) — the "SUPER first, decoy when spent" priority
> semantics are revoked (§A2.2). The registry itself is unchanged.

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

> **⚠A1:** `modifierChipState` is deleted with the chip (§A1.1).
> `availableModifiers` stays exactly as below.

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

> **⚠A1:** signature and semantics superseded by §A1.2 — the gate is now
> stateless and fires every qualifying round; `calloutShown` / `teamId` /
> `markCalloutShown` are deleted.

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

> **⚠A2:** `calloutSpec` now takes the ordered available array and adds a
> both-tease; `sheetActions` loses the cross-offer and Disarm/Keep rows
> (co-equal sections replace crossing; arming commits) — §A2.2/§A2.3. The
> SUPER sheet `lines` gain one appended commitment line (§A2.3).
> `MODIFIER_SHEETS` copy is otherwise unchanged and stays the single home.

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

> **⚠A1 (this whole section, where it mentions the chip):** the chip and
> its pulse beat are gone (§A1.1); the callout fires every qualifying
> round, not once per game (§A1.2); map taps no longer dismiss the pill
> (§A1.2); the caret has no chip to point at and is removed; §4.4's
> chip-and-sheet wiring is superseded by §A1.1/§A1.3 (the sheet renderer
> and `openModifierSheet(id, via)` themselves are unchanged). ~~The armed
> pill (§A1.3) is a new second state of the same element.~~
> **⚠A2:** no armed pill (§A2.3); the callout fires from round 1 (§A2.1);
> the §4.2 states table's priority column is void — both available means
> the both-tease and a two-section sheet (§A2.2); `openModifierSheet`
> takes the available list and `via` is always `"callout"`.

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

> **⚠A1:** schema shapes below are unchanged, but the cadence comment on
> `modifier_callout_shown` ("at most one per game per team") and the
> `via` value set (`"chip"` retires, `"armed"` joins) are superseded by
> §A1.4 — **⚠A2:** and §A1.4 in turn by §A2.4 (`via` live set is
> `{"callout"}` only; `modifier` gains `"both"`; cadence from round 1).

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

> **⚠A1:** the `modifierChipState`, `markCalloutShown` and
> once-per-game-callout cases below are superseded — the A1 build follows
> the §A1.6 matrix instead. ~~The fold, copy and `sheetActions` cases stay
> exactly as written.~~ **⚠A2:** and §A1.6 is itself amended by §A2.6 —
> round-1 fires, array return, co-equal `sheetActions` (no cross, no
> disarm), fold loses `disarm`, SUPER sheet byte test gains the appended
> commitment line. Build against §A2.6.

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
