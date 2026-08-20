# GeoParty — gameplay design review

> **PARTIALLY SHIPPED — G1–G8 of §6 are live on `main`** (spec:
> `docs/g1-g8-gameplay-expansion-spec.md`; authoritative status: its
> §12). **G9–G13 remain unbuilt ideas** and are the live backlog in this
> file. §1–§5 describe the pre-G1–G8 product; read them as design
> rationale, not current state.

*Written 2026-08-19, after the full design-review roadmap
(M1–M6, S1–S7) shipped. This is the pure-gameplay counterpart to
`docs/design-review.md`: that doc fixed friction, onboarding, and polish;
this one asks a single question — **what would make GeoParty more fun, and
what would make people reopen it?** Perspective: party-game design
(Jackbox / GeoGuessr / Wordle lineage), not engineering.*

*Grounding: couch + head-to-head (both TV-optional), SUPER SURE
double-or-nothing, distance-decay + time-bonus scoring, soft auto-advance,
date-seeded Daily Challenge with emoji share grid, UTM-tagged share cards,
Casual/World tour/Expert tiers with an easy first round, sound + motion
pass, PWA, one front door, 5,312 locations / 134 countries, consent-gated
PostHog per `docs/analytics.md`.*

---

## 1. The fun model — what the game actually runs on

### 1.1 The core loop, named

Every round is a four-beat loop:

1. **Displacement** — you're dropped somewhere on Earth. Instant mystery,
   zero rules to learn. This is the game's unfair advantage: the premise
   *is* the tutorial.
2. **Deduction** — reading the world like a detective: script on the signs,
   driving side, vegetation, the couch shouting "that's DEFINITELY
   Portugal." This is where the social texture lives.
3. **Commitment** — the pin. The clock squeezes (time bonus front-loads the
   pressure), rivals' visible pins whisper doubt, and SUPER SURE turns the
   pin into a poker move. Commitment is where tension peaks.
4. **Judgment** — the reveal. Farthest-first elimination, the truth landing
   last, the crown. The gasp ("*that's* where it was?!") is the game's
   signature emotion and the moment people retell later.

The "one more game" pull today is **variable-ratio reward on knowledge**:
the next location might be one you *know*, and nailing a hard one (🟩 on an
Expert round) feels like personal genius. That's a slot machine where the
payout is feeling smart — the strongest compulsion loop in trivia-adjacent
games.

### 1.2 Moments that work — protect and amplify

- **The reveal gasp.** Farthest-first elimination on the TV is genuinely
  the best 10 seconds of the product. Every idea below should be judged by
  whether it feeds this moment.
- **"Team X locked in!"** race pressure. The toast lands right in the
  commitment beat and makes solo deliberation communal.
- **Pin-watching gamesmanship in h2h.** Visible rival pins + the copy-tax
  (time bonus already spent) is an emergent bluffing game nobody had to be
  taught. This is the most *designed*-feeling thing in GeoParty and it was
  nearly free.
- **SUPER SURE at the reveal.** "SUPER SURE ×2" flipping up is a scripted
  table-eruption. The hidden-until-reveal rule is exactly right — never
  compromise it.
- **The daily grid.** 🟩🟨🟧🟥 is legible bragging; the emoji row is the
  game's face in a group chat.

### 1.3 Moments that go flat — the honest list

- **Every round is the same round.** Five identical (drop → guess → reveal)
  beats. Round 4 of 5 has no identity of its own; the only per-round
  variance is the location. Great party games vary the *shape* of rounds,
  not just the content (Jackbox never plays the same round type twice in a
  row).
- **Blowouts after the bet is spent.** SUPER SURE gives the trailer one
  hail-mary; once it's used (or the leader banks a ×2), a 4,000-point gap
  by round 3 makes rounds 4–5 a formality. There is no *ongoing* tension
  instrument — deliberately no scripted finale (owner decision, and this
  doc honors it), but "no scripted comeback" shouldn't mean "no reasons to
  keep caring."
- **The daily has no tomorrow.** You finish Daily #1, you share the grid…
  and nothing acknowledges that you came back for #2. **No streak exists
  anywhere in the codebase.** For a Wordle-lineage feature this is the
  single biggest missing organ — the grid without the streak is a
  screenshot, not a ritual.
- **The reveal teaches nothing.** "812 km — Ubon Ratchathani, Thailand" is
  a verdict, not a lesson. GeoGuessr addicts are people who *learned to
  read the world*; GeoParty never tells you what you could have noticed.
  No learning arc → no mastery fantasy → shallower "one more game."
- **Winning is amnesiac.** `carryTeams()` keeps the same teams into the
  next game, and the crown rotates the host — but *nothing counts the
  night*. Three consecutive games produce three disconnected scoreboards.
  Game night has no ladder, no rivalry memory, no "best of five, we're
  down 1–2."
- **Couch solo downtime survives.** S7 removed the TV gate, not the
  passivity: with 4 teams, each team still spectates 3 of every 4 rounds.
  The Showdown fixes exactly one round.

---

## 2. Fresh mechanics & modes

Each idea: what it is, why it's fun *in the moment*, why it brings people
back, and effort (S ≤ ½ day · M ≈ 1–2 days · L ≈ 1 wk+, matching the
design-review scale). All of them respect the constitution: no accounts, no
backend, no scripted finale comebacks, SUPER SURE stays hidden in play.

### 2.1 Twist rounds — a deck of round modifiers 🎉

**The idea.** Rounds 2+ can draw a *twist* — a one-line rule change
announced with fanfare at round start (a card flip on the TV/host screen).
Launch deck, all buildable on existing levers:

- **⚡ Blitz** — 20-second clock, scores ×1.5. (Timer is already
  configurable per round; the multiplier is one line of pure logic.)
- **🧊 Frozen** — no street movement; read the single frame. (The movement
  toggle and `moved` detection already exist.)
- **🔒 Blind duel** *(h2h)* — rival pins invisible this round. No copying,
  no bluffing — pure knowledge check. (Inverts `liveRivalPins` for a
  round.)
- **🌍 Long haul** — pull the round from the Expert tier regardless of the
  room's difficulty; distances scored on a gentler curve so it's a bonus
  hunt, not a punishment. (Tiers already tag every location.)

Host setting: twists **off / occasional (default) / chaos** (every round).
Which twist a round gets is drawn from the room's seeded PRNG, so resumes
stay deterministic — the shuffle infrastructure already guarantees this.

**Why it's fun.** It gives rounds *identity* ("the Blitz round" gets
retold, "round 3" doesn't) and resets the table's attention every 90
seconds. The card-flip moment — the TV going "⚡ BLITZ ROUND" with the S4
sting — is a manufactured whoop.

**Why it brings people back.** Variety is replayability's cheapest
currency: the same group's third game of the night stops feeling like the
first. It also softens blowouts *without* scripting a comeback — a ×1.5
Blitz keeps the trailing team mathematically and emotionally alive because
the *deck* did it, not a rubber-band.

**Effort: M.** Pure-logic twist table + per-round application in
`game.js`/`h2h.js`, UI card on host/TV/player, one `round_started.twist`
property. **KPI:** `guess_submitted.distance_km`/`time_bonus` by twist;
`game_completed` rate for twist-on vs twist-off rooms; rounds-per-game.

### 2.2 The Decoy Pin — a second poker chip for h2h 🎉

**The idea.** Once per game (mirroring SUPER SURE's economy), an h2h
player may plant a **decoy**: rivals see a fake live pin while the real pin
placement is hidden until lock-in. At the reveal, the decoy is exposed with
a 🎭 — right before their real pin lands.

**Why it's fun.** The visible-pins copy/bluff dance is already the game's
best emergent mechanic; the decoy weaponizes it. The moment: a rival
smugly drags their pin toward your decoy in rural Argentina, the reveal
flips 🎭, and the table *erupts* — you didn't just win, you *played* them.
It's the SUPER SURE feeling (hidden information detonating at the reveal)
pointed outward instead of inward.

**Why it brings people back.** Mind-game mechanics create stories about
*people*, not rounds ("never trust Sam's pin again") — and grudges are the
strongest rematch engine a party game can own. It also makes pin-watching
risky, which keeps the copy-tax honest for skilled groups who've learned
to leech.

**Effort: M.** Pure logic beside `supersure.js` (availability, what rivals
see, reveal exposure), UI on the guess map + reveal beat, extend the
reveal renderers. One event property (`guess_submitted.decoy`) + a
`decoy_resolved`-style aggregate if it earns one. **KPI:** deployment rate
and whether decoyed rounds change rivals' `time_seconds`/`distance_km`
(did the bluff actually bend behavior?).

### 2.3 Crown Night — the session ladder 🎉🔁

**The idea.** Stop treating consecutive games as strangers. The room
already carries teams via `carryTeams()`; add a **night tally**: crowns
won tonight, shown in the lobby and on the game-over screen ("👑 Ana ×2 ·
Ben ×1 — Game 4?"). First to 3 crowns gets a "Champion of the Night"
full-screen moment and the tally resets.

**Why it's fun.** "One more game" stops being a vague urge and becomes a
*score*: nobody leaves a 2–2. The champion moment gives the night an
ending — party games that end well get scheduled again.

**Why it brings people back.** Session length first (`next_game` rate is
the direct KPI), but also *next week*: "rematch Friday, I'm not staying
runner-up" is a retention hook that no daily loop reaches.

**Effort: S–M.** The tally rides the room state that already survives
`next_game`; pure logic is a fold over winners. **KPI:** `next_game` per
`game_completed` (games per session), session length.

### 2.4 All-play couch rounds — kill the downtime, keep the couch 🎉

**The idea.** A couch-mode host option: **"Everyone guesses"** — each
round, after the driving team explores the pano on the shared screen,
*every* team drops a pin (pass the phone in standings order, Showdown
ritual generalized; or teams with a second phone in the room use it). The
driver rotates; the exploration stays communal and shouted.

**Why it's fun.** It fixes the biggest flat spot in couch mode (§1.3):
with 4 teams, passive time per round drops from 75% to ~0. The
pass-the-phone ritual — already the Showdown's charm — becomes the mode's
heartbeat instead of its finale.

**Why it brings people back.** Couch abandonment is concentrated in big
groups (spectating 3 rounds in a row is why people drift to their own
phones — the design review flagged `game_abandoned.rounds_played` as the
tell). Groups whose *whole table* played return as a table.

**Effort: M–L** (it leans on the C1 couch-as-h2h-configuration unification;
worth doing together). **KPI:** couch funnel `round_started →
game_completed` for all-play rooms vs classic; `game_abandoned`.

### 2.5 Daily Hard Mode ⚡ — one checkbox, a second ceiling 🔁

**The idea.** On the daily start screen: **"Hard mode: no moving, 30
seconds."** Same five locations, same seed. The share grid gets Wordle's
asterisk treatment — `Daily #37* ⚡` — so hard-mode grids are visibly a
different flex.

**Why it's fun.** Frozen + fast is the purest read-the-world test; for the
player who finds 60s-with-movement comfortable, it's a new game on the
same content for free.

**Why it brings people back.** Two-tier dailies double the ritual's
lifespan: finish normal, immediately want the star. And the `*` in a
group chat is a status challenge that recruits ("what's the star?").

**Effort: S.** Both levers (movement toggle, round seconds) exist; the
grid suffix is a string. **KPI:** share of `daily_challenge_started` with
a `hard=true` property; hard-mode completion rate vs normal.

### 2.6 Themed weeks — the pool as a content calendar 🔁

**The idea.** The daily gets a weekly rhythm: **Capital Sundays**,
**Island Week**, **One-Country Week** ("all five rounds are somewhere in
Brazil — but where?"). Offline pool-tools work tags locations (country is
already in the geocoded names; capital/island flags are one enrichment
pass), and the date-seeded sampler filters by the week's tag.

**Why it's fun.** Constraints sharpen deduction: knowing "it's Brazil"
turns every clue into a regional puzzle instead of a continental coin
flip — a genuinely different mental game on the same engine.

**Why it brings people back.** Appointment content. "Island Week starts
Monday" is a reason to reopen that no evergreen mode can generate, and
themed grids re-energize the share loop when the novelty of plain dailies
fades.

**Effort: L** (pool-tools enrichment + a published theme calendar — a
static JSON, still no backend). **KPI:** `daily_challenge_started` daily
actives by theme week vs baseline; retention cohort comparison.

---

## 3. Retention hooks — why a no-account party game gets *reopened*

The design review's growth engine (share card → UTM → new rooms) is the
*acquisition* loop. Retention for an account-less game lives in exactly
three places: **the device** (localStorage/PWA), **the group chat** (share
artifacts that demand a response), and **the calendar** (appointment
content). Rank order of what to build:

1. **Daily streak — the missing organ (MUST, S).** `🔥 12` on the daily
   done screen and on the share card. localStorage: last-played day key +
   count; `dailyKey`/`dailyNumber` already define the calendar. Grace rule:
   a streak survives one missed day per week (Wordle's harshness sheds
   more players than it disciplines — kinder streaks retain better and
   still motivate). The card line writes itself: `Daily #37 🔥12 —
   18,340`. *KPI: PostHog Retention on `daily_challenge_started` (add a
   `streak_length` aggregate property); this is the single highest-leverage
   retention change available.*
2. **Personal bests (SHOULD, S).** "Your best daily: 22,110 (Daily #29)"
   and per-party "your closest guess ever: 0.8 km — Lisbon". Beating
   *yesterday's you* is the solo skill loop; localStorage only. *KPI:
   repeat `daily_challenge_completed` per device; `best_distance_km`
   trend.*
3. **The Passport (SHOULD→could be the swing, M–L; §4).** Collection
   pressure across every mode — see Depth, it earns its section.
4. **Crown Night tally (§2.3)** — the party-side reopening hook: rematches
   are scheduled by grudges.
5. **Themed weeks (§2.6)** — the calendar hook.
6. **Monthly recap card (COULD, S).** First daily of a new month shows
   last month's card: `Your August 🌍 19 dailies · 🔥 best streak 11 ·
   34×🟩 · closest 0.4 km`. Spotify-Wrapped psychology at emoji scale;
   pure localStorage fold. *KPI: `result_shared` with `mode=recap`.*
7. **PWA re-entry polish (already shipped — aim it).** The daily is the
   natural `start_url` habit surface; the icon on the home screen should
   *be* the daily ritual's front door. Watch `pwa_launch →
   daily_challenge_started` funnels to confirm.

---

## 4. Depth & skill — a ceiling for addicts, a floor for the couch

**The design tension:** GeoGuessr's depth comes from learnable knowledge
(scripts, road lines, sun position), but party players must never feel an
exam. The rule: **depth lives in optional layers and post-hoc feedback,
never in the required path.**

- **The Passport.** A local, beautiful world map that fills in as you play
  *any* mode: a country gets a bronze stamp when you've seen it, silver
  when you've guessed it within 500 km, gold within 100 km. `134
  countries` is a collection scaled like a Pokédex — big enough to be an
  arc, small enough to feel finishable. Skilled players grind gold stamps
  in Expert; casuals passively watch the map get less gray. Zero accounts:
  it's the device's story (and honest copy says so). The share card gains
  its best line: `🌍 Passport: 61/134 — gold ×9`. *Effort M–L (country
  per location is derivable offline in pool-tools; the map render is the
  L part — a country list with stamp counts is the M version and ships
  first). KPI: return sessions per device; `result_shared` rate.*
- **Reveal clue lines — teach one read per round (SHOULD, L, pool-tools).**
  Enrich each location offline with one **"how you could have known"**
  line: "🚗 Thailand drives on the left · Thai script has no spaces
  between words." Shown small under the reveal. This converts every
  judgment beat into a micro-lesson — the mastery fantasy ("I'm getting
  *good* at this") is the deepest hook GeoGuessr owns and GeoParty
  currently forfeits. Casuals read it as trivia; addicts build a mental
  toolkit. *KPI: `distance_km` by `round_number` learning curve, and by
  device over weeks.*
- **Medal thresholds, not just points.** The emoji buckets (🟩 ≤100 km)
  already exist — name them everywhere: an **ACE** (< 1 km) deserves a
  full-screen moment and a counter ("3rd ace this month"). Skilled players
  chase aces; the couch cheers them. *Effort S.*
- **Hard mode (§2.5) + Expert tier + SUPER SURE/Decoy mind games** are the
  self-selecting ceiling: nothing casual players must touch, everything
  addicts can opt into. The fun floor stays where it belongs — Casual
  tier, easy first round, 60 seconds, shout at the TV.

---

## 5. The one big swing: **Ghost Duels — every share is a playable challenge**

**The bet.** Today the share card is a *screenshot*: the group chat sees
your grid, feels a flicker of envy, moves on. The swing is to make every
daily (and party) share a **challenge link**: tapping it plays the *same
five locations*, with the challenger riding along as a **ghost** — their
pin materializing on your reveal map each round ("Sam was 212 km closer
🎭"), a running you-vs-them score, and a final verdict card that begs to be
sent back.

**How it works with zero backend** — the run is encoded *in the link
itself*: the day key + the challenger's five guesses (rounded coords +
per-round scores), compressed into the URL fragment. The recipient's
client replays the ghost locally against the same date-seeded pool order.
No server, no account, no new infrastructure — the same trick as the UTM
card, one layer deeper. (Privacy line: the link carries the *challenger's
own guesses*, voluntarily shared, person-to-person; nothing about it ever
rides a PostHog event — the analytics schema stays aggregates-only.)

**Why this is the swing and not just another SHOULD:**

1. **It converts the growth loop into a retention loop.** The
   share→new-room KPI measures cards that *recruit*; a ghost link doesn't
   ask the recipient to imagine fun — it *is* the fun, one tap away. And
   the verdict card ("You beat Sam by 1,840 🏆 — rematch?") makes the
   response a move in a rivalry, not a reply in a chat. Asynchronous
   head-to-head is how a party game gets played on a Tuesday lunch break.
2. **It multiplies existing organs instead of growing new ones.** The
   date-seeded sampler (S2), the share pipeline (S1), the UTM attribution,
   the reveal beat, the h2h rivalry feeling — Ghost Duels is the four of
   them composed. The hard parts are already unit-tested.
3. **It's the strongest possible use of the reveal gasp.** The ghost pin
   landing next to yours turns the game's best moment into a *social*
   moment even when you're alone — beat by beat: your pin, their ghost,
   the truth. Three-stage drama, every round.
4. **It has a complete measurement story on day one.** Top of funnel:
   `result_shared` (add `challenge=true`). Middle: `$pageview` with
   `utm_source=share` (already automatic). Bottom: `daily_challenge_started`
   with a `vs_ghost=true` aggregate, then duel completion and
   return-challenge rate — the whole loop lands in the existing
   `docs/analytics.md` framework without a single new identifying
   property.

**Effort: L** (encode/decode + ghost overlay on reveal + verdict card),
but almost entirely pure logic and therefore testable to this repo's
standard. **The moment it creates:** two friends who can't be in the same
room trading ghost links across time zones all week — and showing up to
the next party with a grudge the couch gets to watch settle.

---

## 6. Priorities

Effort: S ≤ ½ day · M ≈ 1–2 days · L ≈ 1 wk+. Lens: 🎉 in-game fun ·
🔁 reopening · 📈 growth.

### MUST

| # | Idea | Lens | Why (one line) | Effort | KPI |
|---|---|---|---|---|---|
| G1 | **Daily streak** (🔥 counter + share-card line, one-day grace) | 🔁 | The Wordle organ the daily shipped without; highest retention leverage per line of code | S | Retention on `daily_challenge_started`; `streak_length` distribution |
| G2 | **Twist rounds** (Blitz/Frozen/Blind duel/Long haul deck, host-set frequency) | 🎉 | Rounds get identities; variety is the cheapest replayability; softens blowouts without scripting comebacks | M | `distance_km`/`time_bonus` by twist; completion rate twist-on vs off |
| G3 | **Crown Night** session tally + champion moment | 🎉🔁 | "One more game" becomes a score; nights get endings worth repeating | S–M | `next_game` per `game_completed`; session length |
| G4 | **ACE moment + medal naming** (thresholds already exist as emoji buckets) | 🎉 | The best guesses deserve a ceremony; aces are the brag unit | S | ACE rate in `guess_submitted.distance_km`; `result_shared` |

### SHOULD

| # | Idea | Lens | Why | Effort | KPI |
|---|---|---|---|---|---|
| G5 | **Ghost Duels** (challenge links with ghost replay — the big swing) | 📈🔁 | Turns every share into a playable rivalry; async h2h for the days between parties | L | Share→duel funnel; `vs_ghost` starts; return-challenge rate |
| G6 | **Daily Hard Mode ⚡** (no move, 30 s, `*` on the grid) | 🔁 | Doubles the ritual's lifespan on existing levers | S | Hard-mode start share + completion vs normal |
| G7 | **Decoy Pin** (h2h once-per-game fake visible pin) | 🎉 | Weaponizes the game's best emergent mechanic; grudges drive rematches | M | Deployment rate; rival `time_seconds` shift on decoyed rounds |
| G8 | **Personal bests** (best daily, closest-ever guess) | 🔁 | Beating yesterday's you is the solo skill loop | S | Repeat `daily_challenge_completed` per device |
| G9 | **The Passport** (country stamps bronze/silver/gold; list-view first, map later) | 🔁🎉 | A 134-country collection arc that every mode feeds; no accounts needed | M–L | Return sessions; passport line on `result_shared` |
| G10 | **All-play couch rounds** (everyone pins every round; ride the C1 unification) | 🎉 | Kills the last big flat spot — solo-round downtime | M–L | Couch `round_started → game_completed`; `game_abandoned` |

### COULD

| # | Idea | Lens | Why | Effort | KPI |
|---|---|---|---|---|---|
| G11 | **Reveal clue lines** ("how you could have known", pool-tools enrichment) | 🎉 | Turns judgment into micro-lessons; builds the mastery arc | L | `distance_km` learning curve per device |
| G12 | **Themed weeks** (Capital Sundays, One-Country Week; static theme calendar) | 🔁 | Appointment content re-energizes the daily when novelty fades | L | Daily actives by theme week vs baseline |
| G13 | **Monthly recap card** (localStorage fold, Wrapped-style) | 🔁📈 | A twelfth-of-a-year retention beat for one afternoon's work | S | `result_shared` with `mode=recap` |

**Sequencing logic:** G1 tomorrow (it compounds daily — every streak-less
day is a cohort lost); G2–G4 next because they deepen the party the growth
loop is already recruiting for; then the swing (G5) once the daily's
retention floor (G1, G6, G8) proves the ritual holds. The Passport (G9)
ships list-first and grows into its map.

**The line to hold while building any of this:** every mechanic above is
opt-in, hidden-information stays hidden until the reveal, no comeback is
ever scripted to a round number, and no idea is allowed to add a login, a
server, or a byte of identifying analytics. The game's soul is "a URL and
six letters" — the job is to give that URL a reason to be typed twice.
