# G1–G8 gameplay expansion — program specification

*Status: implementation-ready specification, approved scope G1–G8 from
`docs/gameplay-design-review.md` §6. Written 2026-08-20 against production
`2e05e5f` (main-only Pages, verify-live gate; the beta lane is removed and
nothing here assumes it). Nothing in this document is implemented by the
change that adds it. Owner review checklist: §11. Implementation phases for
Opus: §8.*

*Amended 2026-08-20, owner-approved: execution order is now
P0 → P2 (Ghost Duels) → P1 → P3 → P4 → P5 → P6 → P7 — Ghost Duels ship
immediately after the shared foundation, ahead of streak/PBs (§8 has the
rationale; phase and feature identifiers are unchanged). The ghost-link
privacy exception is codified in CLAUDE.md ("Daily Ghost Duel links").
All other scope and defaults are approved as written.*

*Constitution (inherited, non-negotiable): static GitHub Pages, no backend,
no accounts, no build step, no new vendor. A URL and six letters remain the
onboarding model. Consent-gated aggregates-only analytics
(`docs/analytics.md`). Hidden information stays hidden until reveal. No
scripted comebacks tied to a round number. SUPER SURE stays exactly what
`js/supersure.js` says it is. Active play screens carry at most two
non-game elements (`docs/ui-ux-design-review.md` §4.1, §9).*

---

## 1. Executive product thesis

Today GeoParty is a great **night**: the reveal gasp, pin-watching
gamesmanship, SUPER SURE detonating at the reveal. What it lacks is a
**week**: the daily has no tomorrow (no streak), winning is amnesiac (no
night tally), every round is the same round (no twists), and the share card
is a screenshot (envy, not play). This program adds the connective tissue —
in both directions at once:

- **The solo ritual gets a memory.** Streak (G1), personal bests (G8), Hard
  Mode (G6), and ACE ceremony (G4) turn "I played today's five" into "I'm
  on 🔥12, my best is 22,110, and I'm one star short of a hard-mode grid."
- **The share becomes a move, not a screenshot.** Ghost Duels (G5): every
  daily share carries the sender's run *in the link itself*. The recipient
  plays the same five, the sender's ghost pin lands on every reveal, and
  the verdict card begs to be sent back. Asynchronous head-to-head with
  zero backend — this is the program's centerpiece and, by owner
  priority, the first thing to ship after the foundation (§8, Phase 2 —
  the program's first shipping phase).
- **The party gets variety and stakes-across-games.** Twist rounds (G2)
  give rounds identities and soften blowouts without scripting comebacks;
  the Decoy Pin (G7) weaponizes the game's best emergent mechanic; Crown
  Night (G3) makes "one more game" a score with an ending.

What changes for a player, in one sentence each:

| Player | Before | After |
|---|---|---|
| Solo, Tuesday lunch | plays the daily, shares a grid, done | defends a streak, chases a PB and the hard-mode star, and trades ghost links with a rival all week |
| A group chat | sees a screenshot | taps a link, plays the same five against a ghost, sends the verdict back |
| A party of four | five identical rounds, blowout by round 3 | a ⚡ BLITZ card flips on the TV, someone plants a 🎭 decoy in rural Argentina, and the night ends 3–2 with a Champion |

---

## 2. Unified feature map — one program, not eight features

The eight features share five primitives. Building them as one ordered
program means each primitive is built once, tested once, and reused —
building them as eight independent features would mean three ad-hoc
localStorage schemas, two share-text forks, and twist/decoy/SUPER-SURE
interactions discovered in production instead of specified here.

### 2.1 Shared primitives and their owners

```
NEW PURE MODULES (unit-tested, no DOM/network — the js/game.js discipline)

js/records.js   Device records store: streak fold (G1), personal bests
                (G8), ACE counters (G4), one versioned localStorage schema.
                Consumed by daily-ui, share text, and the intro/done UI.
js/ghost.js     Ghost Duel codec + duel logic (G5): URL-fragment
                encode/decode, integrity check, ghost score recomputation,
                per-round comparison fold, verdict. Consumed by daily-ui
                and share.js.
js/twist.js     Twist engine (G2): the deck, seeded deterministic draw,
                eligibility matrix, timer/movement/score application
                helpers, Long Haul scoring curve. Consumed by host-ui,
                player-ui, screen renderers — and consulted by G6/G7 rules.
js/decoy.js     Decoy Pin logic (G7): availability, deploy state machine,
                what rivals see, reveal exposure. Sits beside supersure.js
                and mirrors its economy.
js/night.js     Crown Night fold (G3): tally, carry, champion detection,
                tally line/summary formatting. Rides the room state that
                already survives next_game.

EXTENDED MODULES (additive only)

js/daily.js     Day-key arithmetic exported for the streak fold
                (daysBetweenKeys); hard-mode constants (G6); daily result
                schema v2 (stores pins + elapsed so a saved run can become
                a ghost, §5.2).
js/share.js     Card text gains streak (G1), hard-mode star (G6), ACE
                grid square (G4), and the challenge-link form (G5).
js/game.js /    Reveal formatting gains twist and medal captions; h2h live
js/h2h.js       pin feed becomes twist/decoy-aware (pure helpers only).
js/analytics.js EVENT_SCHEMA additions (§7) — the hard allowlist grows,
                never loosens.
```

### 2.2 Dependency graph (build order follows it)

```
records.js ──────────► G1 streak ──► share copy (streak line)
   │                       │
   ├─► G8 personal bests   └─► G6 hard mode (streak explicitly does NOT
   │                            depend on hard — normal-only, §3.6)
   └─► G4 ACE counter
daily result v2 (pins+elapsed) ──► ghost.js ──► G5 Ghost Duels
                                        │
G6 hard mode ───────────────────────────┘ (hard flag rides the same codec)
twist.js ──► G2 twists ──► G7 decoy (Blind Duel interaction, §3.7)
night.js ──► G3 crown night   (independent of twists; touches only the
                               game-over / next-game chain)
```

Note the ghost branch: `ghost.js`/G5 hangs **only** off the daily-result
v2 foundation — `records.js` and G1/G8 are not on its path. That is what
lets the owner-prioritized order ship Ghost Duels (P2) directly after P0,
before the records phase P1 (§8): records are valuable but not a
prerequisite for the first challenge link.

State ownership at a glance (full detail §5):

| State | Where | Writer |
|---|---|---|
| Streak, PBs, ACE counters | `localStorage geoparty_records` | the device itself, fold-on-completion |
| Daily results (normal + hard) | `localStorage geoparty_daily_result[,_hard]` | the device, at run completion |
| Ghost challenge | the URL fragment, person-to-person | the sender's device; never any server, never analytics |
| Twist of a round | RTDB `round/twist` | the round starter (host phone / hostTeam phone) — same single writer as `round` itself |
| Decoy spend + location | RTDB `teams/tN/decoyUsed`, `round/results/tN/decoy` | team tN's phone only — same paths discipline as SUPER SURE |
| Night tally | RTDB `night` at room root | couch: host phone; h2h: the next-room creator carries it (§3.3) |

Why one program in phases (not one big change, not eight strangers): every
phase below is independently shippable and revertible on main (§8), but the
*decisions* — how twists interact with SUPER SURE, whether a decoy exists
in a Blind Duel, whether hard mode feeds the streak, what a ghost link may
carry — are cross-feature and are all resolved in this document so no phase
re-litigates them.

---

## 3. Game-design contracts

Scoring constitution for everything below: the score is
`scoreForDistance(km) + timeBonus(...)` (`js/game.js:49–83`), full stop.
Twists may multiply a round total, SUPER SURE may double-or-zero it, but no
feature introduces a second currency, and every multiplier resolves into
the same running total the standings already read.

### 3.1 G1 — Daily streak (with one-day grace)

**The contract.** Completing the normal daily on consecutive local calendar
days increments a device-local streak. One missed day can be bridged by
grace, at most once per rolling 7 days. The streak is displayed on the
daily intro and done screens and rides the share card.

**What counts as "completed."** All `DAILY_ROUNDS` rounds resolved —
i.e. exactly the moment `daily-ui.js#finishRun()` already calls
`saveDailyResult` (`js/daily-ui.js:428`). Forfeited rounds still complete a
run (a 0-point finished run extends a streak; showing up is the ritual). A
run abandoned mid-way (tab closed) neither extends nor resets — the day
simply passes, and the miss is judged by the next completion. **Hard mode
(G6) and exhibition ghost runs (§3.5) never touch the streak** — the streak
is one obligation, not two.

**Day semantics.** The streak uses the same local-calendar-day rule as the
daily itself: `dailyKey(new Date())` (`js/daily.js:29`) — your today is
your midnight. Day arithmetic is done by parsing keys as UTC midnights
(the existing `keyToUtcMs` trick, `js/daily.js:43` — DST-proof); export it
as `daysBetweenKeys(a, b)` from `daily.js`.

**The fold** (in `records.js`, pure; state shape in §5.1). On completion of
the normal daily with key `K`, given `{count, best, lastKey, graceKey}`:

- `lastKey` empty (first ever, or post-reset) → `count = 1`.
- `gap = daysBetweenKeys(lastKey, K)`:
  - `gap <= 0` → no change (same-day re-entry, or a clock that rolled
    backwards — never punish a clock).
  - `gap == 1` → `count += 1`.
  - `gap == 2` **and** (`graceKey` empty or `daysBetweenKeys(graceKey, K) > 7`)
    → `count += 1`, `graceKey = K` (grace spent: exactly one missed day
    bridged, at most once per rolling week).
  - otherwise → `count = 1`, `graceKey` cleared (a fresh streak gets a
    fresh grace).
- `best = max(best, count)` always.

Rationale for the grace shape: "streak survives one missed day per week"
is the gameplay review's retention argument (§3.1 there — Wordle's
harshness sheds more players than it disciplines); the rolling-7 guard
stops grace from converting a 3-days-a-week habit into a fake streak. The
rule is four branches and fully table-testable.

**Copy.**
- Intro card, returning player: `🔥 12 — day streak` under the daily
  number; after a grace bridge (detected: `graceKey == todayKey` after the
  previous completion... shown on the *next* intro):
  `Missed a day — your streak survived. 🔥 12`.
- Done screen: streak joins the score line.
- Share card (extend `dailyShareText`, `js/share.js:87`):
  `GeoParty Daily #37 🔥12 · 18,340 pts` — streak omitted when `count < 2`
  (a 🔥1 is noise, not a brag).

**Storage loss.** `records.js` treats unreadable/malformed storage as a
fresh device (same posture as `loadDailyResult`, `js/daily.js:118–127`).
No recovery exists by construction (no accounts); the intro card's first
streak surface carries the one honest line, once per device (a
`geoparty_hint_streak` one-shot via `hints.js#claimHint`): *"Streaks live
in this browser — same phone, same streak."* Never accuse the player of
missing a day we can't prove they missed: on reset, copy is simply `Day 1`.

### 3.2 G2 — Twist rounds

**The contract.** From round 2 onward, a party round may carry one twist —
a one-line rule change announced with a card flip before the pano loads.
The draw is deterministic from the room code and round number, never from
standings — that is the mechanical guarantee that twists soften blowouts
*without* scripting comebacks (a trailing team benefits from a ×1.5 Blitz
because the deck did it, not because they were trailing).

**Launch deck** (all four buildable on existing levers; data-only table in
`twist.js`):

| id | Card | Rule | Levers | Modes |
|---|---|---|---|---|
| `blitz` | ⚡ BLITZ | 20-second clock, round total ×1.5 | round `endsAt` override + multiplier | couch, h2h |
| `frozen` | 🧊 FROZEN | No street movement — read the single frame | the existing movement toggle, per-round | couch, h2h |
| `blind` | 🔒 BLIND DUEL | Rival pins invisible this round | `liveRivalPins` returns `[]` for the round | h2h only |
| `longhaul` | 🌍 LONG HAUL | Gentler scoring curve — go bold | a halved decay curve on the round's normal location | couch, h2h |

> **As shipped (this release):** Long Haul applies the gentler (halved-decay)
> curve to the round's **normal selected location**. The dedicated Expert-tier
> secondary sampler (`lhCursor`, described under "Long Haul location supply"
> below) is the one **explicitly deferred** item of this release — see §12. The
> card copy ("Gentler curve — go bold") reflects the shipped behavior; it makes
> no "expert spot" claim.

**Host control.** One segmented setting in the collapsed "More options"
disclosure (per the de-clutter rules — it's a convenience setting):
**Twists: Off / Occasional / Chaos**, default **Occasional**. Stored in
`settings.twists` (`"off"|"occasional"|"chaos"`; absent on old rooms ⇒
off, so resumed pre-twist rooms are untouched).

**Seeded, fair selection** — pure function in `twist.js`:

```
drawTwist({roomCode, roundNumber, roundCount, mode, moveAllowed,
           difficulty, twists, prevTwistId, isShowdown}) -> twistId | null
```

- Round 1: never (the easy-first-round guard, `js/pool.js:96–100`, exists
  so first impressions are gentle; a twist there would undo it).
- The couch Final Showdown: never (it has its own identity and ritual).
- Frequency: `off` → null; `chaos` → always (when any twist is eligible);
  `occasional` → drawn with p ≈ 0.35 per eligible round.
- Randomness: `mulberry32(hashSeed(roomCode + ":" + roundNumber))` —
  export `hashSeed`/`mulberry32` from `pool.js` (they exist at
  `js/pool.js:45–64`) rather than duplicating them. Deterministic ⇒ a
  resumed host redraws identically; and because the twist is *written into
  the round* (below), even a code change between deploys can't desync a
  live room.
- Eligibility filters before the draw: `blind` requires h2h with >1 team;
  `frozen` requires the room's `moveAllowed` (freezing an already-frozen
  room is not a twist); `longhaul` requires a scored pool and
  `difficulty !== "expert"` (redundant there). Never the same twist as
  `prevTwistId` (variety is the point).

**Authoritative application.** The round starter (host phone in couch, the
`hostTeam` phone in h2h — the exact writer that already owns `round`
start, architecture write-ownership table) computes the draw and writes
`round/twist: {id}` in the same patch that starts the round. Every other
device reads the round record, never re-draws — so version skew or a
future deck change cannot split a room. Round `endsAt` is computed from
the twisted seconds by the same writer, exactly as today.

**Application helpers** (pure, in `twist.js`):
- `twistRoundSeconds(settings, twist)` → 20 for blitz, else
  `settings.roundSeconds`.
- `twistMoveAllowed(settings, twist)` → false for frozen, else the room's.
- `twistMultiplier(twist)` → 1.5 for blitz, else 1.
- `longHaulDistancePoints(km)` → `scoreForDistance(km / 2)` — the gentler
  curve is the existing tested scorer with the distance halved (an
  effective 2,984 km decay constant): a 2,000 km miss on a Long Haul
  scores like a 1,000 km miss normally. Max stays 5,000; a bonus hunt, not
  a punishment. Time bonus computes from the gentled distance points, so
  it scales naturally.
- Round total with a twist: `points = round(mult × (distancePoints +
  timeBonus))` — one number, banked into the same `total` as always.
  `guess_submitted.total_score` remains "the raw round total", which now
  simply *is* the twisted total.

**Long Haul location supply.** *(DEFERRED — not in this release; see §12.)*
The design below describes a future dedicated expert-tier sampler. **As
shipped, none of it exists:** Long Haul is purely the gentler scoring curve
(`longHaulDistancePoints` = `scoreForDistance(km / 2)`) applied to the round's
**normal** selected location; the main sampler order and its single
`poolCursor` are untouched, and there is no `lhCursor` in room state, no
`orderedPool(…, "expert")` call, and no separate cursor persisted anywhere.
`drawTwist` is invoked with `longHaulExhausted: false` (there is no expert
order to exhaust). The deferred design: *the room would get a second
deterministic order `orderedPool(pool, roomCode + "-lh", "expert")` with its
own persisted `lhCursor`; a Long Haul round would pull from it without
advancing the main cursor; dead-image skips would advance `lhCursor` like
`poolCursor`; an exhausted expert order would make `longhaul` ineligible.*
That work is the single explicit deferral of this release (§12).

**Explicit interactions** (the cross-feature rulings other sections refer
back to):

- **Timer:** Blitz is 20 s even in a no-limit room — that's the twist. The
  bonus window is `bonusWindowMs(20)`; the auto-lock at `endsAt` behaves
  exactly as today.
- **Movement:** Frozen disables navigation for the round via a new
  `iv.setMoveAllowed(bool)` on the viewer wrapper (activates/deactivates
  the direction/sequence/keyboard components; `viewer-ui.js` is the only
  legal place to touch the viewer, per CLAUDE.md). `guess_submitted.moved`
  is definitionally false on frozen rounds — fine; the twist property
  (§7) lets analysts exclude them.
- **SUPER SURE:** the bet doubles the **twisted** round total
  (`adjustedPoints` reads `result.points`, which already carries the
  multiplier — `js/supersure.js:55–63` needs zero changes). A Blitz +
  SUPER SURE round can swing ×3. Both are opt-in drama; no cap.
- **Decoy Pin (G7):** no decoy during Blind Duel — the chip hides, the
  spend is not consumed (§3.7).
- **Final showdown:** untwisted, always (above).

**UI/reveal treatment.** The card flip is a center overlay + scrim — the
one overlay class reserved for "ritual interstitials that must stop the
room" (`docs/ui-ux-design-review.md` §4.4), same family as the Showdown
card and the h2h 3-2-1: full-screen on the TV with the S4 sting, a card on
every phone, auto-dismissing in ~2.5 s (tap to skip; reduced-motion: fade,
no flip). During the round, the twist lives as a HUD-adjacent tag on the
existing round label (`Round 3/5 · ⚡BLITZ` — an amendment to an existing
HUD item, not a new element; the ≤2 non-game-element budget is untouched).
At the reveal, the result line gains the twist tag
(`+4,680 pts · ×1.5 ⚡ · 812 km · ⚡+140 fast` — extend
`revealResultLine`, `js/game.js:125`).

### 3.3 G3 — Crown Night

**The contract.** Consecutive games with carried teams accumulate a
**night tally** of crowns (game wins). First team to **3 crowns** is
Champion of the Night: a full-screen ceremony, then the tally resets. No
host setting — the tally is automatic, invisible until game 2, and dies
with the room chain.

**Session boundary.** A "night" is the chain the product already has:
couch games repeat in the same room (`gameOver → lobby`,
`js/game.js:13-14`); h2h next-games are new rooms linked by the `nextRoom`
pointer with `carryTeams()` (`js/h2h.js:189–217`). The night state rides
that chain and nowhere else — **no localStorage persistence**. A night
that ends when everyone goes home is a feature ("rematch Friday" is a new
night); resurrecting stale tallies days later on one device would be
wrong more often than right.

**State** (`night` at room root, shape in §5.3): `{v: 1, games: N,
crowns: {t1: 2, t3: 1}}`. Slot-keyed, like everything else — slots are
identity (`carryTeams` keeps them stable across games).

**Who wins a game** — one shared pure function, `night.js#gameWinner
(teams, roomCode)`: standings leader, ties broken by the seeded
deterministic coin flip that h2h already uses (`h2hWinner`,
`js/h2h.js:178–185` — reuse it for both modes). Couch games gain the same
tie-break (today the couch podium just shows the tie; the *crown* needs
one winner, and a deterministic flip every device agrees on requires no
extra write). The podium still shows the true tie; the crown line says who
took the night point.

**Write ownership.**
- Couch: the host phone (sole authority) increments `night` in the same
  patch that writes `phase: gameOver`.
- H2H: the game-over phase is settled by the reveal-flip writer, but the
  *next room* is created by the winner's phone — that creator computes
  `carryNight(night, winnerId)` (pure fold: `games+1`,
  `crowns[winner]+1`, or a fresh `{v:1, games:0, crowns:{}}` if a champion
  was just crowned) and writes it into the **new** room in the same
  connection-ordered write that already queues the room before the
  `nextRoom` pointer (architecture "phase machines" — followers never
  dangle). Single writer, no contention. The *display* of "who won this
  game's crown" on the game-over screen needs no write at all — every
  device computes `gameWinner` locally.

**Rules.**
- **Carried teams:** a team keeps its crowns while its slot persists.
- **Late joins:** a new team claiming a free slot mid-night starts at 0
  crowns; a team that leaves keeps its crowns parked on the slot (if the
  slot is re-claimed by a different device via the normal claim
  transaction, the crowns follow the slot — slots are identity, and
  re-claiming an abandoned slot mid-night is already an edge the team
  model accepts).
- **Champion:** after the increment, if `crowns[winner] >= 3` — the
  Champion ceremony replaces the normal podium beat (TV full-screen:
  `👑 CHAMPION OF THE NIGHT — Atlas Cats`, confetti, S4 fanfare; phones
  and the couch-no-TV host phone render their own version via the
  `couchscreen.js` pattern). The next game starts a fresh tally
  (`games: 0`); rematch flow is otherwise the unchanged `next_game` path.
- **Ties for the championship** can't happen — crowns are awarded one per
  game to one winner.
- **TV / no-TV:** the tally line renders wherever the game-over standings
  already render (TV podium corner, phone game-over screens, host phone in
  couch-no-TV). Lobby of game ≥ 2 shows one muted line:
  `👑 Atlas Cats ×2 · Pin Pals ×1 — first to 3 takes the night` (folded
  into the existing lobby status line, not a new element). **Team names on
  the tally/champion surfaces carry `data-ph-mask`** — update
  `docs/replay-mask-checklist.md` in the same change.
- **Persistence scope:** the room chain (24 h RTDB lifetime). An
  abandoned room ends the night silently.

Copy for the game-over hook (the whole feature in one line):
`👑 Ana ×2 · Ben ×1 — Game 4?` on the primary button's sub-line.

### 3.4 G4 — ACE moments + medal naming

**The contract.** An **ACE** is a pin under 1 km. It gets a full-screen
stamp ceremony at the reveal, a device-local counter ("3rd ace this
month"), and a 🎯 square in the daily grid. The existing emoji buckets
get names, shown as a one-word caption at the reveal — the vocabulary of
bragging.

**Thresholds** — fixed, mode- and difficulty-independent (understandable
beats adjusted; an ACE on Expert is simply worth retelling more):

| Grade | Distance | Grid | Caption |
|---|---|---|---|
| **ACE** | < 1 km | 🎯 | "ACE!" |
| Green | ≤ 100 km | 🟩 | "Nailed it" |
| Yellow | ≤ 750 km | 🟨 | "Right region" |
| Orange | ≤ 3,000 km | 🟧 | "Right continent" |
| Red | > 3,000 km | 🟥 | "Lost" |
| No pin | — | ⬛ | — |

Pure logic: `records.js#medalForDistance(km)` returning
`{ace, emoji, caption}`, built on `EMOJI_BUCKETS` (`js/share.js:67–74`) so
the grid and the captions can never disagree. `distanceEmoji` gains the 🎯
case (additive; the ⬛/🟥 behavior is untouched).

**Twist/difficulty interaction:** none — distance is distance. Long
Haul's gentler curve changes points, never the medal. **SUPER SURE
no-double-counting:** an ACE changes zero points, ever — it is ceremony
plus a counter. When a pin is both an ACE and a SUPER SURE win, the reveal
plays the ACE stamp on the pin landing (the pin's story) and the SUPER
SURE verdict at settlement display (the points' story) — two beats,
existing order, nothing multiplies twice because the ACE never multiplies
at all.

**Reveal ceremony.** Phones/daily: the S4 stamp overlay (the mechanism
`fx-ui.js` already owns for LOCKED IN) fires `🎯 ACE — 0.4 km` on the
acing device; other devices and the TV show the ACE burst when the closest
pin lands in the farthest-first cascade. Reduced-motion: static stamp, no
burst, exactly like the existing stamp treatment. Counter line under the
stamp: `3rd ace this month` (from `records.aces`, §5.1 — party aces on
this device count too; the counter is device-scoped and honest about it).

**Share expression.** The daily grid: ace rounds render 🎯 in place of 🟩
— `🟩🎯🟨🟧⬛` is visibly a different flex, no new line of copy. The party
card (`partyShareText`) appends ` 🎯 ACE` after the brag when the game's
best moment was under 1 km.

### 3.5 G5 — Ghost Duels

**The decisive scope choice: Daily-only for the MVP.** The daily is
already a deterministic, fixed-rule, solo, no-Firebase run — a fair shared
challenge *by construction* (`js/daily.js`: same seed, same five, same
60 s, movement on, same scorer). A party-challenge link would need to
encode room settings, multi-team context and a non-daily pool order, for a
recipient experience that is worse (a party run isn't solo-replayable).
Daily-only makes the link small, the fairness argument airtight, and the
build land inside one phase. Party challenges are an explicit non-goal for
this program (§10); the codec below is versioned so a future `v2` can add
them without breaking a single shipped link.

#### 3.5.1 The challenge artifact

Once G5 ships, **every daily share is a challenge link by default** — no
new button, no opt-in friction beyond the share itself (the act of sharing
is the voluntary disclosure; see the privacy boundary, §3.5.6). The share
text becomes:

```
GeoParty Daily #37 🔥12 · 18,420 pts
🟩🎯🟨🟧⬛
⚔️ Beat my ghost: <url>
```

(The 🔥 segment is G1's share line and the 🎯 square is G4's — the card
as first shipped by P2 simply omits them; each joins when its phase
lands, per the §8 order. The challenge link itself is complete from P2.)

**URL format.** `daily.html?utm_source=share&utm_campaign=daily#g=<payload>`
— the run rides the **fragment**, never the query string: fragments are
not sent in HTTP requests, don't reach the Pages logs, and are
scrubbed/stripped from analytics (§3.5.6). `withUtm` keeps working
unchanged; the fragment is appended after.

**Payload** (`ghost.js`, pure): binary, base64url-encoded.

```
byte  0      version        (1)
bytes 1–2    dayNumber      uint16 LE (dailyNumber of the run's key)
byte  3      flags          bit0 = hard mode (G6)
bytes 4–5    poolCheck      FNV-1a-32 of the run's five image_ids
                            (joined with ","), folded to 16 bits
bytes 6–50   5 × 9-byte round records:
  byte 0     round flags    bit0 = pinned (0 ⇒ forfeit; rest zeros)
  bytes 1–3  lat            uint24 = round((lat + 90) × 10000)   (~11 m)
  bytes 4–6  lng            uint24 = round((lng + 180) × 10000)  (~11 m)
  bytes 7–8  elapsed        uint16, deciseconds, clamped 0–6000
bytes 51–52  checksum       FNV-1a-32 of bytes 0–50, folded to 16 bits
```

53 bytes → 71–72 base64url chars. **Length budget (test-enforced): the
fragment (`g=` + payload) ≤ 100 chars; the full share URL ≤ 200 chars** —
short enough that no messenger truncates it and the share text stays
paste-able. Note what is *not* in the payload, deliberately: no name, no
score, no place, no Mapillary image id, no truth coordinate. Scores are
**recomputed** by the recipient from pins + times with the same pure
scorers — a link cannot claim a score its pins didn't earn, which is the
entire integrity posture we need (see tamper posture below).

**Where the sender's pins come from.** The daily result schema gains
per-round `guess {lat, lng}` and `elapsedMs` (v2, additive — §5.2), so a
link can be built at completion *or later from the saved result* (the done
screen's share button works all day, not just at the finish moment).

**Integrity/tamper posture.** The checksum catches messenger truncation
and copy-paste damage — it is not cryptographic. A determined user editing
their own pins in a link they send to a friend is the exact
devtools-grade-honesty non-threat the codebase already accepts (embedded
truth in h2h rounds, `docs/architecture.md` RTDB model). We do not add
crypto for it; we do recompute scores so casual "edit the number" tampering
is structurally impossible.

**Decode failure behavior** (`decodeGhost` returns a tagged result, never
throws — property-tested):

| Condition | Result | Recipient sees | Analytics (§7) |
|---|---|---|---|
| bad base64 / wrong length / bad checksum | `{error: "malformed"}` | "That challenge link got damaged in transit — but today's Daily is right here." + normal intro | `ghost_link_invalid {reason: "malformed"}` |
| unknown version | `{error: "version"}` | "This challenge needs a newer GeoParty — play today's Daily meanwhile." | `reason: "version"` |
| `|dayNumber − today| > 1` | `{error: "expired"}` | "This challenge expired — the Daily is a fresh five every day." + intro | `reason: "expired"` |
| poolCheck mismatch (after loading the day's five) | `{error: "pool"}` | "This challenge was built on an older Daily — playing without the ghost." Run proceeds ghost-less. | `reason: "pool"` |

The ±1-day window exists for time zones: a sender in Auckland shares #37
while the recipient's Chicago evening is still #36. Within the window the
recipient plays **the link's day** (its seed), not their own. Pool-drift
risk inside the window is small by construction — the pool changes only
via the weekly, human-merged quarantine PR (CLAUDE.md) — and `poolCheck`
converts the residual risk into a graceful degrade instead of a nonsense
duel (ghost pins scored against different truths).

#### 3.5.2 Recipient entry and fairness

Opening `daily.html#g=…`:

1. **Immediately** parse and then remove the fragment
   (`history.replaceState`) — before any analytics init can observe the
   URL (§3.5.6).
2. Intro screen becomes the challenge intro: the daily-number card gains
   an eyebrow — `⚔️ CHALLENGE — Daily #37` — and one line: *"A friend sent
   you their run. Their ghost pin appears at every reveal — same five
   places, same rules."* Primary button: **"Take the challenge"**. (Two
   content changes to a calm screen; no new floating elements.)
3. Hard-flagged links route into hard rules (§3.6) with the ⚡ treatment
   on the same card.
4. **Fairness rules:** the recipient plays the link's day-seed, under the
   link's ruleset (normal/hard). The ghost is invisible until each
   round's reveal — during exploration and aiming there is zero ghost
   presence (no marker, no score strip: hidden information stays hidden,
   and the play screens stay at ≤2 non-game elements). The ghost's
   per-round pins decode to ~11 m precision; scores are recomputed on the
   recipient's device with the identical scorer, so drift vs. the
   sender's displayed score is ≤ a couple of points (test asserts the
   bound).
5. **Already played today** (replay lock, same day, same mode): their
   saved run *is* their side of the duel — skip straight to the verdict
   (per-round comparison + verdict card, no replaying). This is the
   instant-gratification path for the most common duel: two people who
   both play every day. (Saved runs from before v2 lack pins; the
   comparison still works — it needs only per-round points, which v1
   stored.)
6. **Day/mode mismatch runs are exhibitions:** if the link's day ≠ the
   recipient's local today (the ±1 window), or it's a hard link and they
   want to keep their hard slot, the run is played but **not saved** — no
   streak, no PB, no replay-lock write. One line on the verdict: *"That
   was yesterday's five — today's Daily is still waiting for you."*
   (An exhibition that ends in an ad for the ritual.) When day and mode
   match and the slot is free, the duel run **is** the daily run: it
   saves, locks, feeds streak/PB/records normally — one run, two
   purposes.

#### 3.5.3 Reveal choreography (the beat this feature lives or dies on)

Per round, on the existing daily reveal screen (`d-reveal`), in order:

1. **Your pin** lands with the polyline to truth — exactly today's
   renderer (`js/daily-ui.js:386–412`).
2. **The ghost materializes**: a visually distinct marker (dashed outline,
   muted color, 👻) fades in at the ghost's pin, ~400 ms after yours, with
   a distance chip `👻 212 km`. No polyline for the ghost — one line on
   the map keeps the payoff legible. Reduced-motion: appears without fade.
3. **The verdict line for the round** joins the result line block:
   `You +3,120 · 👻 +2,890 — you take the round` (or `👻 takes the
   round`, or `dead heat`).
4. **The running comparison**: the existing "Total so far" row becomes
   `You 9,480 · 👻 8,910` for duel runs.

The reveal is a calm screen (chrome rules, `js/chrome.js:21–25` — only
`*-round`/`*-guess` are play screens), so these additions are legal; they
replace/extend existing rows rather than stacking new elements (the §2.10
de-clutter shape is preserved: map, place headline, one result line, one
total row).

Maps remain replay-blocked (`.leaflet-container` in `blockSelector`,
`js/analytics.js:74`) — the ghost marker can never leak into a recording.

#### 3.5.4 Verdict, rematch, return challenge

The done screen (`d-done`) for a duel run:

- Headline: `You won the duel! 🏆` / `The ghost got you 👻` / `Dead heat.`
- Margin line: `18,420 to 16,580 — by 1,840`.
- Per-round strip: five paired emoji squares (yours over theirs) — the
  grid vocabulary, doubled.
- Primary: **"Send your verdict"** — shares *your* card, which (since
  every share is a challenge) carries **your** ghost payload: the return
  challenge is the default share, not a separate mechanic. Share text
  leads with the verdict: `GeoParty Daily #37 — I beat the ghost by 1,840
  🏆` + grid + `⚔️ Your move: <url>`.
- Secondary/ghost: the normal done-screen elements (score, grid) stay.

**Web Share / clipboard:** the existing `shareResult` ladder
(`js/share-ui.js:12–30`) unchanged — sheet where available, clipboard
fallback, toast last resort.

**Mobile deep link behavior:** `daily.html` is inside the PWA scope, so an
installed app opens the link in-app; the fragment survives both the
browser and standalone paths (this is a §6.4 device-matrix test item — it
cannot be unit-tested). **No-TV compatibility is trivially total:** the
daily has no TV surface; a ghost duel is a phone-in-hand experience end to
end.

#### 3.5.5 What ships in the MVP vs. explicitly later

MVP (Phase 2, §8): everything in 3.5.1–3.5.4 for the normal daily.
Phase 3 adds the hard flag (one bit, already reserved). Explicitly later,
only if the funnel says so (§10): party-run challenges (`v2` payload),
multi-ghost links (racing several friends), a ghost overlaid on the
pano/guess screens (rejected for now — it would violate the play-screen
element budget and leak hints pre-commitment).

#### 3.5.6 Privacy and analytics boundary (hard rules)

- The link carries the challenger's own five guesses and timings —
  **voluntarily shared, person-to-person**. That is its entire data
  universe: no name, no score claim, no identity, no location truth, no
  image ids.
- **Nothing from a ghost payload ever rides an analytics property** — not
  the pins, not the timings, not derived per-round distances, not the
  payload string. The only ghost-related analytics are the aggregates in
  §7 (`vs_ghost` flags, outcome/margin of the *recipient's own device's*
  duel, and link-failure reasons). The margin is a score difference — the
  same class of aggregate as `winning_score`.
- **The fragment must never reach PostHog.** Three independent layers,
  each tested: (1) `history.replaceState` strips it at parse time, before
  consent init can capture a pageview URL; (2) `imagery.js#scrubUrl` is
  extended to drop URL fragments entirely (belt) — it already strips query
  strings and ≥10-digit runs for `$current_url`-class properties via
  `sanitizeBeforeSend` (`js/analytics.js:146–181`); (3) the payload is
  base64url with no coordinate-shaped substrings anyway (braces). A
  sanitizer test feeds a `#g=` URL through `sanitizeBeforeSend` and
  asserts zero payload bytes survive.
- Session replay: the duel screens introduce **no user-entered text and no
  names** (the ghost is anonymous by design — the chat context, not the
  link, identifies the sender). Scores/margins are non-identifying.
  Maps stay blocked. `docs/replay-mask-checklist.md` gains the verdict
  screen row with the finding "nothing to mask, by design — keep it that
  way."

### 3.6 G6 — Daily Hard Mode

**The contract.** The same five locations and seed as the day's normal
daily, under harder fixed rules: **no movement, 30 seconds**. One scored
hard run per day, in its own slot. The grid gets the star: `Daily #37* ⚡`.

- **Unlock:** hard mode appears on the intro/done screens only **after
  today's normal run is completed** — the ritual stays singular for
  casuals, and the star stays a chase ("finish normal, immediately want
  the star"). One exception: an inbound **hard challenge link** unlocks a
  hard run directly (the challenge is the tutorial; making a challenged
  player grind normal first would kill the duel loop). Recommended
  default; owner may flip to always-available (§11).
- **Rules:** `HARD_ROUND_SECONDS = 30`, movement off (viewer built
  without navigation components — the `iv.setMoveAllowed` lever from G2's
  Frozen). Same scorer; the bonus window is `bonusWindowMs(30)` so "fast"
  scales to the shorter round automatically (`js/game.js:73–75`).
- **Same locations knowingly:** yes — hard is a second ceiling on the same
  content, and since normal-first is the gate, the player has seen the
  five. That is the design: hard mode tests *how fast and pinned-down*
  your reads are, not fresh geography. (This also keeps "the same five for
  everyone" true across both boards.)
- **Streak:** hard **never** feeds or extends the streak (§3.1) — one
  obligation. **PB:** hard has its own records row (§5.1); normal and hard
  bests never mix.
- **Attempts/replay lock:** mirror of the normal lock — one scored hard
  run per day in `geoparty_daily_result_hard` (§5.2), superseded daily.
- **Share/ghost:** the hard card is `GeoParty Daily #37* ⚡ …` with the
  star and its grid; the link's payload sets the hard flag, so hard
  duels are hard-vs-hard by construction. Normal and hard runs produce
  separate cards; the done screen shares whichever board you're looking
  at.

### 3.7 G7 — Decoy Pin

**The contract.** H2H only. Once per game per team (mirroring SUPER
SURE's economy — `superSureUsed`'s sibling), a team may plant a **decoy**:
from that moment, rivals' live view shows the decoy where a live pin would
be, while the real pin is placed unseen. At the reveal the decoy is
exposed with a 🎭 beat right before the real pins land.

**Deploy rules.**
- Available on the guess map while unspent, via a 🎭 chip in the action
  bar's chip dock beside the 🔥 chip (§4.2 — the dock is the screen's one
  contextual element; two chips share it, they don't stack layers).
- Tap → the one bottom sheet (dismissing any other, per the one-sheet
  rule): *"DECOY — Plant a fake pin for rivals to see. Your real pin goes
  dark. Once per game."* Buttons: **"Plant the decoy"** / "Not now".
- Arming: the next map tap places the **decoy** (marked 🎭 on your own
  map, so you can never mistake it for your pin); every tap after that
  places/moves your **real pin** as normal. Until the decoy is placed,
  your live feed keeps broadcasting normally; from decoy placement to
  lock-in, the live feed carries the decoy's coordinates, frozen where
  planted, and your real pin never rides the wire (see mechanics).
  The decoy is a static plant (no puppeting) — simple, and a settled pin
  reads exactly like a rival who's made up their mind. (Puppet-mode is an
  owner option explicitly deferred, §11.)
- **Number of uses:** one per game; `carryTeams` resets it next game
  (identical lifecycle to the bet — add `decoyUsed` to the reset list in
  `js/h2h.js:206–217`).
- Planting with no real pin at the buzzer: normal forfeit; the decoy is
  consumed (it was deployed and did its work). No refunds — the economy
  must stay legible.

**Mechanics — who writes what** (all paths stay disjoint; the
write-ownership table gains no contention):
- `teams/tN/decoyUsed = roundNumber` — own-team write at plant time
  (survives refresh, like `superSureUsed`).
- `round/live/tN/pin` — from plant to lock-in, carries the decoy coords
  (one write, then the ≤4/s mirror stops); `lockIn()` nulls it exactly as
  today, so the "pin vanishes at lock-in" tell is preserved and a decoyed
  team locks in looking identical to anyone else.
- `round/results/tN/decoy = {lat, lng}` — written in the same lock-in
  patch as the result row, for the reveal renderer. Results are readable
  pre-reveal in devtools; same accepted posture as the embedded truth and
  the bet (`docs/architecture.md`, security model).
- Pure logic in `decoy.js`: `decoyAvailable(teams, teamId, twistId)`
  (false when spent, false during `blind`), the deploy-state fold for the
  guess-map UI, and `revealDecoys(round)` for the renderers.

**Visibility/timing.** Rivals see the decoy from the moment it's planted
until "lock-in" (when it vanishes like a real pin). It is
indistinguishable from a real live pin by construction — same marker, same
feed. Hidden information rule: nothing anywhere reveals a pin is a decoy
until the reveal (no toast, no roster mark, no live style difference — the
same inviolable rule as SUPER SURE, and a test enforces the live-surface
absence the same way).

**Reveal exposure.** In the farthest-first cascade, before the real pins
begin: each planted decoy pops onto the reveal map with a 🎭 flip and
fades to a muted ghost marker (reduced-motion: appears, no flip). The
roster/board line for the planter gains `🎭 decoy` once per game — the
table needs to know who played whom. TV and phone reveal renderers both;
couch-no-TV n/a (below).

**Interactions.**
- **SUPER SURE:** fully independent; the same round may carry both (the
  all-in bluff round is the story this feature exists to create).
- **Twists:** no decoy during 🔒 Blind Duel (pins invisible — a decoy is
  noise); chip hidden, spend preserved. All other twists: normal.
- **True pin:** the real pin is placed and locked exactly as today —
  decoy code never touches scoring, distances, or the result row's guess.
- **Anti-confusion guardrails:** on the planter's own map the decoy is
  visually distinct (🎭 badge, non-draggable); the real pin is the only
  draggable marker; the lock button stays disabled until a real pin
  exists (unchanged behavior); planting is blocked after lock-in.
- **Couch:** not applicable — couch solo rounds have no rival-pin
  surface, and the Showdown is pass-the-phone. The chip never renders in
  couch mode. (If C1 ever unifies couch as an h2h configuration, decoys
  come along free.)
- **Remote/no-TV h2h:** fully supported — live pins and reveal maps are
  already phone-rendered.

### 3.8 G8 — Personal bests

**The contract.** Device-local records, updated monotonically, surfaced
only on calm screens.

**Exact records** (all in `geoparty_records`, §5.1):

| Record | Updated when | Rule |
|---|---|---|
| `daily.bestScore {score, day}` | normal daily completes | strictly greater score replaces |
| `hard.bestScore {score, day}` | hard daily completes | same |
| `closest {km, context}` | any pin lands on this device: daily (both modes) or this device's own h2h guesses | strictly smaller km replaces; `context` is `"daily"` \| `"party"` |
| `streak.best` | streak fold | max(count) (§3.1) |
| `aces {month, monthCount, allTime}` | any ACE on this device | monthCount resets on month change |
| `duels {played, won}` | ghost verdict on this device | counters |

Couch guesses are excluded from `closest` — the host phone is a shared
device and "your closest ever" would be the couch's, not yours. H2H
guesses happen on the guessing phone, which is personal; they count.

**Update rules:** folds run at run/round completion inside the existing
completion paths; records only improve (no decay, no deletion). **No
backfill** of history that predates the feature, with one cheap exception:
on first load, if today's `geoparty_daily_result` exists, seed
`daily.bestScore` from it (yesterday's players shouldn't see "no best"
the day the feature ships).

**Surfaces** (calm screens only; never on `*-round`/`*-guess`):
- Daily intro card: `Your best: 22,110 (Daily #29) · 🔥 12` — one muted
  line under the number.
- Daily done: `New personal best! 🏆` line when the run set one (the
  moment G8 exists for).
- Hard done: same, against the hard row.
- Records never render in the party UI (the party's memory is Crown
  Night; a personal-device stat line on a shared night is noise).

**Relationship to Duel scores:** a duel run that is also the daily run
(§3.5.2 case 6) updates records normally; exhibitions update nothing.
Execution-order note (§8): P2 ships before the records folds in P1, so
duels resolved in the gap are simply not counted — the `duels` counter
starts fresh when P1 lands, consistent with the no-backfill rule above.

---

## 4. UX information architecture by screen

Global rules restated once (from `docs/ui-ux-design-review.md` §4, all
binding): one primary per screen; ≤2 non-game elements on active play
screens; one sheet at a time; toasts never explain mechanics; center
overlays only for ritual interstitials; reduced-motion collapses every new
animation to appear/disappear; every new team-name/room-code/place-name
surface gets `data-ph-mask` and a checklist row.

### 4.1 Daily surfaces (`daily.html`)

- **Intro (`d-intro`, calm):** daily-number card gains the streak/PB muted
  line (G1/G8). After normal completion, a secondary card/row appears:
  `⚡ Hard mode — no moving, 30 seconds` with ghost-style button
  **"Try Hard Mode"** (G6, contextual — invisible until earned). With a
  challenge fragment: the ⚔️ eyebrow + one explainer line + primary
  **"Take the challenge"** (§3.5.2). Never more than one primary.
- **Round/guess (`d-round`, `d-guess`, play):** **unchanged inventory.**
  Hard mode changes the timer value and removes navigation, not the
  chrome. Duels add nothing here — the ghost does not exist on play
  screens.
- **Reveal (`d-reveal`, calm):** the §3.5.3 beats. Non-duel runs:
  unchanged except the medal caption on the result line (G4) and the ACE
  stamp when earned.
- **Done (`d-done`, calm):** score + grid (🎯-capable) + streak line + PB
  line when set + duel verdict block when dueling (§3.5.4). Hard-mode
  entry row after a normal run. Primary stays the share.

### 4.2 Party phone surfaces (`player.html`, `host.html`)

- **Setup:** `Twists: Off / Occasional / Chaos` joins Seconds/Movement
  inside the existing "More options" `<details>` (G2). Nothing else.
- **Guess map (play — the audited hotspot):** inventory after this
  program: map + top banner (until first pin) + HUD timer + action bar +
  **chip dock** (🔥, and in h2h 🎭). The dock is the one contextual
  element; chips only render while their power is unspent and applicable
  (SUPER SURE's existing contextual rule, extended to the decoy —
  `decoyAvailable` handles Blind Duel and couch). Element count stays ≤2
  non-game (bar + dock). The decoy sheet is the one sheet while open.
- **Twist interstitial (transition):** center overlay card, ~2.5 s,
  tap-through, S4 sting; then the HUD round label carries the tag.
- **Reveal (calm):** result line gains twist tag + medal caption; ACE
  stamp beat; decoy 🎭 exposure in the pin cascade; board unchanged.
- **Game over (calm):** night tally line + `Game 4?` sub-line on the
  primary (G3); champion ceremony replaces the podium beat at 3 crowns.

### 4.3 TV (`screen.html`) — the do-not-touch surface, touched minimally

Twist card full-screen flip (it *is* a ritual interstitial — the one
overlay class the TV already uses for the 3-2-1); ACE burst in the reveal
cascade; decoy 🎭 flip in the cascade; night tally in the existing podium
layout + champion full-screen at 3. Corners-only HUD discipline untouched;
nothing joins the HUD. The tally/champion team names carry `data-ph-mask`.

### 4.4 Accessibility / reduced motion

Every new beat (card flip, ghost fade-in, ACE burst, decoy flip, champion
confetti) collapses to a static appear under `prefers-reduced-motion`,
via the existing `fx.js` easing-math path — no new looping animation
anywhere, cascade stagger stays ≤ 0.35 s total. New interactive elements
(chips, hard-mode button) meet the 44 px touch target rule. Ghost/duel
information is never color-only (👻/🎯/🎭 glyphs + text labels carry the
meaning). Timer changes (Blitz 20 s, hard 30 s) keep the existing low-time
pulse + tick semantics.

---

## 5. Data & architecture plan

### 5.1 `geoparty_records` (new localStorage key, owned by `records.js`)

```json
{
  "v": 1,
  "streak": { "count": 12, "best": 14, "lastKey": "20260820", "graceKey": "20260817" },
  "daily":  { "bestScore": { "score": 22110, "day": 29 } },
  "hard":   { "bestScore": { "score": 14200, "day": 41 } },
  "closest": { "km": 0.8, "context": "daily" },
  "aces":   { "month": "2026-08", "monthCount": 2, "allTime": 5 },
  "duels":  { "played": 4, "won": 3 }
}
```

Load rules (mirror `loadDailyResult`'s posture): unreadable, unparsable,
or `v` missing/greater-than-known → fresh defaults (never throw, never
partially trust). All writes are full-object `setItem` inside try/catch
(private mode: this session just isn't remembered). **Versioning:** `v` is
bumped only for incompatible shape changes; additive fields need no bump
(readers default missing fields). Migration policy: a known older `v`
gets an explicit pure `migrateRecords(old)`; there is no `v0`, so v1 ships
migration-free but with the function's seam in place.

### 5.2 Daily result v2 (existing keys, additive)

`geoparty_daily_result` (and new sibling `geoparty_daily_result_hard`):
rounds gain `guess: {lat, lng} | null` and `elapsedMs`. The v1 loader's
validation (`key`, numeric `score`, array `rounds` — `js/daily.js:120`)
already passes v2 objects; new code treats missing pins as
"can't build a ghost from this save" (share falls back to the plain card
with one honest toast). No version field needed — the shape is
self-describing. The hard slot is a separate key so the two locks can
never corrupt each other and the v1 code path is untouched.

### 5.3 RTDB additions (all additive; old clients ignore unknown paths)

```
rooms/CODE
  settings.twists       "off" | "occasional" | "chaos"   (absent = off)
  lhCursor              int — Long Haul sampler position (host-resume, like poolCursor)
  night                 { v: 1, games: int, crowns: { tN: int } }
  teams/tN/decoyUsed    round number (sibling of superSureUsed)
  round/twist           { id }        written with round start, same writer
  round/results/tN/decoy{ lat, lng }  written in the team's own lock-in patch
```

**Write ownership / race treatment** (extends the architecture table; no
new contention classes):

| Path | Writer | Race posture |
|---|---|---|
| `round/twist`, `lhCursor` | the round starter (host / hostTeam) | single writer, rides the round-start patch |
| `teams/tN/decoyUsed`, `round/results/tN/decoy` | team tN's phone | own-subtree, disjoint by construction |
| `night` (couch) | host phone | sole authority |
| `night` (h2h) | next-room creator | written into the new room before the `nextRoom` pointer on the same connection — the same ordering guarantee the pointer already relies on |

The reveal-flip and forfeit-sweep collision contracts are untouched: the
decoy adds no reveal-time writes (exposure is pure rendering from
`results`), and twists change what the flip writers *compute* only via
data already in their atomic snapshot (`round/twist` + results), so racing
writers still produce identical settlements — the SUPER SURE settlement
argument (`js/supersure.js:64–74`) carries over verbatim.

**Version-skew note:** a deploy landing mid-room means an old client in a
twisted room won't apply the twist locally (wrong timer/multiplier). Rooms
live for one evening and the round record is authoritative for *what* the
twist was, so the blast radius is one confused round on one stale tab;
accepted, listed in the risk register (§10) — same posture as every
existing mid-room deploy.

### 5.4 Where Firebase is genuinely needed vs. local-only

Firebase: only what must be shared live — twist id, decoy spend/location,
night tally. Local-only: everything G1/G4/G6/G8 (records, results) and
the entirety of G5 (the link is the transport; two devices never touch a
common store). Nothing here creates a new Firebase surface for the daily,
which stays no-Firebase (`js/daily-ui.js:2–8`).

### 5.5 URL fragment codec strategy

Encode/decode are pure byte-array transforms in `ghost.js` (no `atob`
dependency on DOM — implement base64url over arrays so Node tests run it
natively). Decode is total: any input → `{ok} | {error}` (never throws).
Safe-failure UX per the §3.5.1 table. The fragment is stripped from
`location` at parse; `scrubUrl` drops fragments as the second layer; a
`sanitizeBeforeSend` test is the third (§3.5.6).

---

## 6. Tests & verification

Every phase lands its tests in the same change (CLAUDE.md mandate).
`npm test` + `npm run check` green per phase; no new deps, Node's runner.

### 6.1 New/extended unit suites (pure layer)

| Suite | Coverage that matters |
|---|---|
| `tests/records.test.js` | streak table: first-ever, gap 0/1/2/3, grace available/spent/re-earned at day 8, negative gap (clock rollback), best watermark; corrupted/missing/future-`v` storage → defaults; PB monotonicity; ace month rollover; write-failure tolerance (throwing storage) |
| `tests/ghost.test.js` | round-trip property: `decode(encode(run)) ≡ quantized(run)` over ~1,000 seeded-PRNG runs (mulberry32-seeded — deterministic fuzz); **hostile inputs:** truncation at every byte boundary, bit flips (checksum catch), random base64, empty/huge strings, wrong version, all-forfeit runs, poles/antimeridian pins (lat ±90, lng ±180 wrap), elapsed clamp; **length budget:** fragment ≤ 100 chars, URL ≤ 200 (hard asserts); **score reproduction:** recomputed ghost score within ±5 pts of full-precision score for fuzzed runs; day-window logic incl. timezone ±1; poolCheck mismatch path; verdict/margin/per-round fold incl. ties |
| `tests/twist.test.js` | draw determinism (same inputs → same twist, 500 rooms); eligibility matrix (mode, moveAllowed, difficulty, round 1, showdown, prev-twist exclusion, off/occasional/chaos); occasional frequency within tolerance across seeded rooms; `twistRoundSeconds`/`twistMoveAllowed`/multiplier math; Long Haul curve values + monotonicity + 5,000 cap; SUPER SURE over twisted totals (adjustedPoints on multiplied points) |
| `tests/decoy.test.js` | availability (spent, blind-twist, couch, after lock); deploy-state fold; carryTeams resets `decoyUsed`; reveal exposure list; **live-surface absence:** the live-pin feed shape carries no decoy marker (the SUPER SURE hidden-in-play test pattern, extended) |
| `tests/night.test.js` | tally fold; `gameWinner` tie-break parity with `h2hWinner`; champion at 3 exactly; carry vs. reset-after-champion; late-join slot at 0; malformed/absent `night` treated as fresh |
| `tests/daily.test.js` (extend) | `daysBetweenKeys` across DST/month/year boundaries; hard-mode constants; v2 result round-trip + v1 compatibility |
| `tests/share.test.js` (extend) | streak line presence/omission, hard star, 🎯 grid, challenge/verdict text forms, URL composition (UTM + fragment coexist) |
| `tests/analytics.test.js` / `track-schema` (extend) | every new event/property through the sanitizer; **fragment-leak test** (§3.5.6); assert no new schema key matches `BANNED_KEY_RE` (`js/analytics.js:429`) — note this is why no property may contain `pin`/`lat`/`name` etc.; coordinate-shaped-value tests for new events |
| `tests/game.test.js` / `h2h.test.js` (extend) | `revealResultLine` with twist tag/medal caption; `liveRivalPins` under blind twist; reveal-flip settlement identical across racing writers with twists in the snapshot |
| `tests/html-contract.test.js` (extend) | chip dock present on h2h guess bar; `data-ph-mask` on night tally/champion nodes; challenge intro nodes; hard-mode row |

### 6.2 What cannot be mocked — browser/device verification per phase

Manual matrix (360×640 phone, one iOS Safari, one Android Chrome, one
TV-sized viewport; documented in each phase's summary):

- Web Share sheet with the full challenge text+URL on iOS (share-sheet URL
  handling differs) and the clipboard fallback path.
- Fragment survival: paste a ghost link through WhatsApp/iMessage/Telegram
  and open it (messenger link rewriting is the real hostile input).
- PWA standalone launch of a `#g=` link (in-scope navigation, fragment
  intact); offline/file:// degradation (decode works, imagery fails
  gracefully as today).
- Safari ITP 7-day script-storage eviction awareness check (streak copy
  honesty — nothing to fix, something to see).
- Reduced-motion pass over every new beat; twist card + ACE + champion on
  a real TV cast; decoy flow with two phones (the bluff must *feel*
  invisible).

### 6.3 Failure modes & rollback

Every phase is additive and independently revertible: pure modules + UI
call sites + schema entries revert cleanly with the commit; RTDB fields
are ignored by reverted clients (unknown paths are never read); records/
result keys are tolerated by old code (v1 loader validated fields only).
Rollback procedure per phase: `git revert`, push main, and the Pages
`verify` job is the activation oracle (`docs/architecture.md`,
deployment). No feature flags are added — phases are small enough that
revert *is* the flag, and the one PostHog flag stays reserved for replay.

Specific failure modes:
- **Ghost decode bug in the wild** → worst case is the §3.5.1 error copy
  and a normal daily; the run is never corrupted by a bad link
  (decode-before-touch, exhibitions don't save).
- **Records corruption** → self-heals to defaults on next load; streak
  loss is the worst outcome, and the copy never claims data we don't have.
- **Twist desync (skew)** → one round, one stale tab; round record is
  authoritative; next round self-corrects.
- **Night tally lost (chain broken/abandoned)** → the night silently has
  no score, which is exactly the pre-G3 product.

---

## 7. Analytics event catalog & KPI questions

All events consent-gated through `track()` as ever; every property below
is an aggregate (counts, flags, scores, day indexes); none matches
`BANNED_KEY_RE`. Nothing from a ghost payload, a pin, a team name, or a
coordinate ever rides. Schema + call site + sanitizer test + this catalog
mirrored into `docs/analytics.md` land together per phase. Each extended
property lands with the phase that introduces it, in the §8 execution
order: `vs_ghost` and the ghost events with P2, `streak`/`pb` with P1
(so the ghost funnel reports before streak slicing exists — accepted),
`hard` with P3, twist/decoy/night properties with their phases.

### 7.1 New/extended events

| Event | Properties (new in bold) | Fired from | KPI question |
|---|---|---|---|
| `daily_challenge_started` (extend) | day_number, **hard** bool, **vs_ghost** bool, **streak** int (count *before* the run) | daily page | Ritual mix: hard-share of starts; duel-share of starts; streak distribution = retention health at the source |
| `daily_challenge_completed` (extend) | …existing, **hard**, **vs_ghost**, **streak** (after), **pb** bool, **aces** int (this run) | daily page | Completion by mode; PB-rate (is improvement still happening?); ace rate vs. difficulty of the day |
| `ghost_duel_completed` (new) | **day_number** int, **outcome** string won\|lost\|tie, **margin** int, **hard** bool | recipient's device, at verdict | The bottom of the swing's funnel: do duels resolve, who wins (sender advantage?), are margins close (fair = fun)? |
| `ghost_link_invalid` (new) | **reason** string malformed\|version\|expired\|pool | daily page, at parse | Link rot in the wild — is the codec/window/pool-drift posture right? |
| `result_shared` (extend) | …existing, **challenge** bool | share glue | Top of the duel funnel: shares that carry a ghost vs. plain cards |
| `round_started` (extend) | …existing, **twist** string (absent = none) | round starter | Twist frequency in practice; completion of twisted vs. plain rounds |
| `guess_submitted` (extend) | …existing, **round_number** int, **twist** string, **decoy** bool | guessing phone | Distance/time by twist (does Blitz compress times? does Long Haul's curve land?); decoy deployment rate; **rival behavior shift**: within a room, `time_seconds`/`distance_km` of *non-decoy* guesses in rounds where some guess has `decoy=true` (join on room + round_number — the reason round_number is added) |
| `night_champion` (new) | **mode** string, **games** int | the phase-writing device at champion | Do nights reach a champion? `games` distribution vs. the first-to-3 design (long tails ⇒ threshold too high) |

Existing events answer the rest without additions: `next_game` per
`game_completed` is Crown Night's headline KPI (games per session before
vs. after); `super_sure_resolved` monitors that twists/decoys didn't
cannibalize the bet; PostHog Retention on `daily_challenge_started` is
G1's single most important chart, now sliceable by `streak`.

**Deliberately not instrumented** (justifications, per the CLAUDE.md
requirement): no `ace_scored` event (`guess_submitted.distance_km < 1`
and `daily_challenge_completed.aces` already measure it — a third counter
adds volume, not signal); no `twist_shown` (identical cardinality to
`round_started.twist`); no per-round daily events (the daily's
started/completed pair is intentionally coarse — five more events per run
would triple daily volume for no decision we'd make differently); no
`decoy_planted` event (the `guess_submitted.decoy` flag has the same
cardinality and joins better); no PB-value property (the `pb` flag answers
"is improvement happening" — the value itself is on the device where it
belongs).

### 7.2 Event ordering (for funnel sanity)

- Daily solo: `daily_challenge_started` → `daily_challenge_completed`
  [→ `ghost_duel_completed` when vs_ghost] [→ `result_shared`].
- Ghost arrival: [`ghost_link_invalid` |] `daily_challenge_started
  {vs_ghost:true}` → … (an already-played instant verdict emits
  `ghost_duel_completed` with no new `started` — the run already ran).
- Party round: `round_started {twist}` → `guess_submitted ×N
  {twist, decoy, round_number}` → `reveal_shown` →
  [`super_sure_resolved`] → … → `game_completed` → [`night_champion`] →
  [`next_game`].

### 7.3 The Ghost funnel, end to end, aggregate-only

`result_shared {mode: daily, challenge: true}` (cards sent) →
`$pageview` with `utm_source=share` (arrivals — automatic) →
`daily_challenge_started {vs_ghost: true}` (duels begun) →
`ghost_duel_completed` (verdicts) → the *recipient's*
`result_shared {challenge: true}` (return fire — the loop closing). Five
steps, zero payload bytes, zero identity.

---

## 8. Phased implementation plan (for Opus)

Rules for every phase: pure logic in the named modules with the §6 tests;
schema + call sites + `docs/analytics.md` + `docs/replay-mask-checklist.md`
updated in the same change; `npm test` + `npm run check` green; the §6.2
manual matrix for the touched surfaces; one commit series per phase,
shippable and revertible alone. Effort scale as in the design reviews.

The table reads in **execution order** (owner-amended 2026-08-20:
P2 precedes P1). Phase identifiers are unchanged from the approved spec —
P1 is still the records phase, P2 still Ghost Duels; only the sequence
moved.

| Phase | Ships | Builds | Effort | Verify |
|---|---|---|---|---|
| **P0** | (foundation, invisible) | `records.js` skeleton + `daysBetweenKeys` + daily result v2 (save pins/elapsed, hard-slot key) | S | unit suites; a saved run round-trips with pins; v1 results still load |
| **P2** | **G5 Ghost Duels (normal daily)** — *the first genuinely usable ghost link ships here* | `ghost.js` codec + challenge intro + reveal beats + verdict + default challenge share + scrubUrl fragment layer + funnel events | L | fuzz/hostile/length suites; two-device duel through a real messenger; fragment-leak test; already-played instant verdict |
| **P1** | **G1 + G8** streak, PBs, share lines | records folds + intro/done surfaces + share.js lines (🔥/PB join the already-shipped challenge card) + extended daily events | S–M | streak table tests; device check: complete a daily, see 🔥/PB, share carries them |
| **P3** | **G6 Hard Mode** (+ hard duels) | hard slot + unlock flow + `setMoveAllowed` viewer lever + star share + hard flag in codec | S–M | hard runs score on 30 s window; hard link forces hard rules; streak untouched by hard |
| **P4** | **G4 ACE + medals** | `medalForDistance` + 🎯 grid + stamp/TV burst + captions + ace counters | S | grid/caption tests; both-ACE-and-SUPER-SURE reveal on device |
| **P5** | **G3 Crown Night** | `night.js` + couch/h2h carry + tally/champion surfaces + masks + `night_champion` | S–M | fold tests; a 3-game two-phone night reaches a champion; TV + no-TV |
| **P6** | **G2 Twist rounds** | `twist.js` + setting + round-start write + card/HUD/reveal treatment + `lhCursor` + viewer lever reuse + event props | M | determinism/eligibility suites; each twist played on device in both modes; resume mid-twist-round |
| **P7** | **G7 Decoy Pin** | `decoy.js` + chip/sheet + live-feed switch + reveal exposure + carry reset + `decoy` prop | M | hidden-in-play tests; two-phone bluff session; blind-twist exclusion |

Ordering rationale — the sequence is intentionally owner-prioritized:
real shareable challenge links are the owner's stated goal, and Ghost
Duels depend only on P0's daily-result v2 (pins + elapsed, §2.2) —
nothing in G1/G8 is a prerequisite for the first link. So P2 ships first
after the foundation: **Eduardo can send a real challenge link at the end
of the program's first shipping phase**. P1 follows immediately — the
streak compounds daily (every streak-less day is a lost cohort — the
gameplay review's "G1 tomorrow"), so records land right behind the link
and the 🔥/PB lines join the challenge card then; deferring P1 by one
phase trades a few streak-less days for the duel loop existing at all.
P3 rides the codec while it's warm. The party arc (P4→P7) orders by
blast radius: ACE touches only formatting; Crown Night touches the
game-over chain; twists touch the round lifecycle; the decoy lands last
because its one cross-feature rule (Blind Duel) needs the deck in the
tree first.

---

## 9. Compatibility matrix

✅ works · ⚪ not applicable by design · ✋ deliberately excluded

| | Daily normal | Daily hard | Ghost duel | Couch | Couch no-TV | H2H | H2H remote/no-TV | TV screen | PWA |
|---|---|---|---|---|---|---|---|---|---|
| G1 streak | ✅ feeds it | ✋ never (§3.6) | ✅ when the run counts (§3.5.2) | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ | ✅ start_url ritual |
| G2 twists | ✋ daily rules are fixed for comparability — hard mode *is* the daily's twist | ✋ | ✋ | ✅ | ✅ card on host phone | ✅ (+🔒 blind) | ✅ | ✅ card flip | ✅ |
| G3 crown night | ⚪ | ⚪ | ⚪ | ✅ same-room chain | ✅ host-phone ceremony | ✅ nextRoom chain | ✅ | ✅ tally + champion | ✅ |
| G4 ACE/medals | ✅ 🎯 grid | ✅ | ✅ both sides' rounds | ✅ stamp + TV burst | ✅ phone burst | ✅ | ✅ | ✅ cascade burst | ✅ |
| G5 ghost duels | ✅ the MVP | ✅ via hard flag (P3) | — | ✋ party links out of scope (§3.5.5) | ✋ | ✋ | ✋ | ⚪ no TV surface exists — no-TV by construction | ✅ deep link opens in-app |
| G6 hard mode | ⚪ sibling | — | ✅ hard-vs-hard | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ | ✅ |
| G7 decoy | ⚪ | ⚪ | ⚪ | ✋ no rival-pin surface | ✋ | ✅ | ✅ phones render everything | ✅ reveal exposure | ✅ |
| G8 PBs | ✅ | ✅ own row | ✅ counting runs | ✋ shared device (§3.8) | ✋ | ✅ own-phone closest | ✅ | ⚪ | ✅ |

Every existing capability on the do-not-change list (both play styles,
remote h2h, difficulty tiers, movement toggle, Add-a-TV, share cards,
auto-advance, SUPER SURE, consent gate) is untouched or purely extended.

---

## 10. Non-goals, constitutional guardrails, risk register

**Non-goals for this program** (present in the reviews, deliberately not
here): the Passport (G9), all-play couch rounds (G10, waits for C1),
reveal clue lines (G11), themed weeks (G12), monthly recap (G13); party
ghost links; multi-ghost races; puppet decoys; any leaderboard beyond the
device; any account, backend, server, or new vendor, ever.

**Constitutional guardrails restated as tests-or-review-blockers:**
1. Twist draw is a pure function of (roomCode, roundNumber, settings) —
   it must never read standings (no scripted comebacks). Reviewable in one
   function signature.
2. SUPER SURE semantics unchanged: hidden in play, once per game,
   double-or-nothing on the round total (which may now be twisted) — the
   existing hidden-surface tests extend to decoys and keep running.
3. The ghost payload never appears in any analytics property, replay, or
   URL that leaves the device (three-layer defense, §3.5.6, each layer
   tested).
4. Active play screens: ≤2 non-game elements, counted per screen in
   review; the chip dock is one element.
5. One score system: every mechanic resolves into
   `distance points + time bonus` and its multipliers; no parallel
   currency (ACEs are ceremony, crowns are game wins, never points).
6. Consent gate byte-for-byte untouched; PostHog init options untouched.

**Risk register:**

| Risk | Likelihood | Blast radius | Mitigation |
|---|---|---|---|
| Messenger mangles ghost links (truncation, unfurl rewriting) | med | a duel doesn't start | checksum + graceful copy + `ghost_link_invalid.reason` tells us which messengers; length budget keeps links short |
| Pool/quarantine drift inside the ±1-day window | low (weekly human-gated merges) | ghost-less run instead of a nonsense duel | `poolCheck` degrade path (§3.5.1) |
| Safari ITP evicts localStorage after 7 idle days → streak loss | med for casual iOS users | trust in streaks | honest copy (§3.1); PWA install (already shipped) exempts; never accuse on reset |
| Fragment leaks into analytics via a future PostHog default | low | privacy incident | scrubUrl drops fragments (belt), replaceState (braces), sanitizer test (alarm) |
| Decoy erodes the pin-watching mechanic (everyone distrusts pins) | med | the bluff economy | once-per-game economy caps it; KPI: rival `time_seconds`/`distance_km` shift on decoyed rounds; revert P7 alone if the table stops watching pins |
| Twist multiplier + SUPER SURE ×3 swings feel unfair | low–med | party trust | both are opt-in/announced; `super_sure_resolved` EV by twist watches it; deck is data — a multiplier tweak is one number |
| Version skew mid-room on twist rounds | low | one round, one stale tab | round record authoritative (§5.3); accepted |
| Night tally on a re-claimed slot credits the wrong humans | low | one night's bragging rights | slots-are-identity is the existing model; copy names teams, not people |
| Clock tampering inflates streaks | — | none we care about | devtools-honesty posture, consistent with the whole product |
| Reveal-screen density creeps (ghost + medal + twist + SS) | med | the payoff moment | §4 keeps them as extensions of existing rows/beats, never new stacked elements; 360×640 manual pass per phase |

---

## 11. Owner review checklist

Only choices that shouldn't be silently defaulted; each has a recommended
default the spec is written against. Approving the spec approves the
defaults.

1. **Ghost scope: Daily-only MVP** (party links deferred to a possible
   v2 payload). *Recommended: yes — §3.5 rationale.*
2. **Every daily share is a challenge link by default** (no separate
   "share with ghost" button). *Recommended: yes — the swing is the
   default-ness; the payload is only your own guesses.*
3. **Challenge validity window ±1 day** (time zones), exhibitions beyond
   that same-day rule don't save. *Recommended: yes.*
4. **Streak grace: one missed day, at most once per rolling 7; hard mode
   never feeds the streak.** *Recommended: yes — kindness with a guard.*
5. **Hard mode gated behind completing the day's normal run** (challenge
   links bypass). *Recommended: yes — keeps one ritual; flip to
   always-available later is a one-line change.*
6. **Crown Night: automatic, fixed first-to-3, no host setting, no
   persistence beyond the room chain.** *Recommended: yes — a setting
   would be clutter; 3 fits a 3–5 game night. `night_champion.games` will
   say if 3 is wrong.*
7. **ACE threshold fixed at < 1 km in every mode/difficulty; 🎯 replaces
   🟩 in the grid for ace rounds.** *Recommended: yes.*
8. **Decoy: static plant, once per game, h2h only, excluded in Blind
   Duel; consumed even on a forfeit.** *Recommended: yes; puppet-mode
   decoys are a deliberate later maybe.*
9. **Twist defaults: Occasional (~35% of eligible rounds), never round 1,
   never the Showdown; Blitz ×1.5 stacks with SUPER SURE (max ×3
   swing).** *Recommended: yes — the stack is rare, loud, and opt-in.*
10. **Long Haul curve: distance halved through the standard scorer
    (2,984 km effective decay).** *Recommended: yes — one tested scorer,
    one parameter.*

---

*Fable owns the engineering and design choices in this document within the
PM guardrails; where a mechanic could have undermined the product it was
minimized, not dropped — all eight features are specified as their
smallest genuinely-fun shape. Implementation begins only after owner
approval, phase by phase per §8.*

---

## 12. Implementation status — G1–G8 release completion pass (Opus 4.8, 2026-08-20)

This section is the source of truth for **what actually shipped** versus the
design text above, so no reader mistakes a described-but-deferred mechanic for a
live one. Everything in §1–§11 is implemented **except** the one item called out
below.

**The single explicit deferral.** Long Haul's dedicated **expert-tier secondary
sampler / `lhCursor`** (§3.2 "Long Haul location supply") is **not built**.
Long Haul ships as a gentler scoring curve
(`longHaulDistancePoints` = `scoreForDistance(km / 2)`, tested) on the round's
**normal** selected location. There is no `lhCursor`, no `orderedPool(…,
"expert")`, no second cursor in room state; `drawTwist` runs with
`longHaulExhausted: false`. Product copy is honest — the card reads *"Gentler
curve — go bold"*, never "expert spot". **Future follow-up:** build the
expert-order sampler exactly as the deferred design in §3.2 describes, behind
the same `longHaulExhausted` eligibility hook that already exists — the seam is
in place, so it is additive and needs no rework here.

**Shipped in this completion pass (release blockers, required, and approved
user-visible work):**

- **Blind Duel TV (B1):** `screen-h2h.js` suppresses rival *live* pins whenever
  `round.twist.id === "blind"` (reveal pins unaffected) — the TV can no longer
  contradict the card or the hidden-information rule.
- **Crown Night refresh-safety (R2):** `night.js#gameNight` resolves a
  game-over's crown from `(night, teams, roomCode)` alone; `host-ui.js`'s finish
  path **and** its gameOver *resume* path both call it, so a host refresh between
  games recomputes the identical tally and re-threads the carry. Couch and h2h
  carry are refresh-safe (h2h carry already rode the persisted room chain).
- **Couch `guess_submitted` (R4):** now carries `round_number` and (when present)
  `twist`, matching h2h.
- **Ghost link telemetry (R3):** `ghost_link_invalid {reason:"expired"}` is now
  emitted once at boot alongside malformed/version; `pool` keeps its own site.
- **Pre-v2 / all-forfeit ghost guard (R5):** `ghost.js#runHasPins` gates the
  share; a run with no usable pins produces the plain card + an honest toast,
  never an all-forfeit challenge link.
- **Streak storage-honesty hint (R6):** one-shot `geoparty_hint_streak` line on
  the daily intro's first streak surface.
- **Party record folds (R7):** `records.js#applyPartyGuess` folds an own-phone
  h2h guess into device-local `closest` (context `"party"`) and the ACE
  counters; wired in `player-ui.js#lockIn`, gated on a real pin. Couch (shared
  host phone) never folds. Local-only — no analytics.
- **TV twist interstitial (C1):** full-screen `.twist-card-overlay` ritual on the
  TV, once per round, reduced-motion → fade (CSS).
- **Party ACE (C2):** medal caption on the h2h reveal result line, an ACE stamp
  on the acing phone and an ACE burst on the TV reveal, and a 🎯 ACE tag on the
  party share card. Reduced-motion via the existing stamp CSS; no new PII.
- **Ghost already-played instant verdict (C3):** an already-completed matching
  daily/mode resolves straight to the duel verdict (recomputing the ghost's
  scores on-device), emits `ghost_duel_completed`, and the done screen's
  **"Send your verdict"** primary is the return challenge.
- **Ghost reveal choreography (C4):** the 👻 marker materializes ~400 ms after
  your pin with a fade (reduced-motion → instant); the duel done screen's
  primary reads **"Send your verdict"**.
- **Other C5 fixes:** resumed **Frozen** rounds re-assert the no-movement lever
  (couch + h2h); the lock-button estimate is priced through the twist-aware
  scorer (Blitz ×1.5 + 20 s window, Long Haul curve); the couch champion plays
  exactly **one** fanfare; a planted decoy writes `decoyUsed` at **plant time**,
  so it stays spent across a refresh and a host forfeit-sweep (no refund); the
  night tally renders in both h2h lobbies (game ≥ 2); the daily ACE counter line
  ("Nth ace this month") renders on the done screen; `BLITZ_MULTIPLIER = 1.5` and
  the deck card copy are pinned by tests.

**One honest divergence from the copy above (C5 — better UX, documented, not
silent):** the grace-bridge line *"Missed a day — your streak survived. 🔥 N"*
renders on the **done screen at the moment the bridging run completes** (the
immediate, legible beat), rather than on the *next* intro as §3.1's copy
paragraph describes. The done-screen moment is strictly more timely and needs no
"already-shown" flag; the streak fold, grace guard, and all other §3.1 behavior
are unchanged. The intro still carries the streak count (`🔥 N`) and the
storage-honesty line (R6).
