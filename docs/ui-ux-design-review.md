# GeoParty — UI/UX design review: the de-clutter pass

> **PARTIALLY HISTORICAL — the §7 roadmap (P0, P1, P2) shipped in
> `3e26419`; §9's implementation brief is complete.** Still normative:
> §4 (the layer/hierarchy design system, enforced by `js/chrome.js` and
> cited by `CLAUDE.md`), §6.5 (consent moment), and §8 (what not to
> change). §2's screen inventory describes the pre-de-clutter, pre-G1–G8
> UI — the diagnosis, not the current state.

*Written 2026-08-20, after the full M1–M6 / S1–S7 build, against the
live product and the codebase at `28d2b5b`. Companion docs:
`docs/design-review.md` (product/friction), `docs/gameplay-design-review.md`
(fun/retention). This one answers the owner's concern: **"the UI is getting
cluttered."** The lens is Wordle's restraint and Jackbox's instant
comprehension; the deliverable is a screen-by-screen verdict list, a small
design system to prevent regression, and a prioritized fix roadmap.*

*Verdict vocabulary — every element gets exactly one:*
- **KEEP** — right thing, right place, right weight.
- **DEMOTE** — stays, but smaller / quieter / lower in the hierarchy.
- **COLLAPSE** — merge with a sibling that does the same job.
- **CONTEXTUAL** — only appears in the states where it earns its pixels.
- **REMOVE** — delete the element (never the capability — its job moves or
  was never real).

---

## 1. Executive diagnosis

The bones are excellent — one phase-screen at a time, a bottom action bar,
corners-only TV HUD — but seven rapid feature waves each shipped its own
floating element, note line, or button without an eviction policy, and the
phone now pays the tax: on the h2h guess map (the highest-stakes moment in
the game) up to **eight overlapping UI elements** compete for a 360×640
viewport. The core failure mode is not ugly screens but **simultaneity**:
persistent chrome (consent 🍪, sound 🔊, SUPER SURE pill, estimate pill,
hint cards, toasts) all treat themselves as always-deserving, and copy
explains the same rule in three places at once. The fix is almost entirely
subtraction and sequencing — one primary action per state, one floating
layer per class, everything else contextual — and none of it requires
removing a single capability.

---

## 2. Screen-by-screen inventory & verdicts

### 2.1 Landing / front door (`index.html`)

The strongest screen in the product — M4 got it right. Protect it.

| Element | Verdict | Notes |
|---|---|---|
| Hero pano + scrim | KEEP | The product demos itself. Degrades to gradient. |
| Logo + tagline | KEEP | |
| "Start a party" primary + "Have a code? Join" secondary | KEEP | Exactly one primary. The model for every other screen. |
| Chooser (2 experience cards + back) | KEEP | Named by experience, not page. Correct. |
| Join panel (code input + Join) | KEEP | |
| Daily Challenge card | KEEP | Always-visible is right — it's the retention front door. |
| 3-step "How it works" strip | KEEP | Below the fold, ≤6 words/step. |
| Footer (Add a TV · Privacy · GitHub) | KEEP | |
| Consent banner (first visit) | CONTEXTUAL | Fine *here* — the landing is a calm moment. The problem is on the join pages (§3, hotspot 3). |

### 2.2 Host setup — couch (`host.html` `#h-setup`)

| Element | Verdict | Notes |
|---|---|---|
| Resume banner | KEEP | Already contextual, accent-bordered. Model behavior. |
| Difficulty segment | KEEP | The one setting that changes the felt game. |
| Rounds segment | KEEP | |
| Teams segment + name inputs | KEEP | Couch-defining. |
| Seconds-per-round segment | COLLAPSE | Into a collapsed "More options" `<details>` with Movement. Defaults (120 s, movement on) are sane; 8 extra tap targets don't belong on the default path. |
| Movement segment | COLLAPSE | Same disclosure. |
| "All-time top 10" leaderboard | DEMOTE | Information shown too early — nobody needs history while configuring a party. Move behind a "Past games" link, or show only on game over next to "Save to leaderboard." |
| New Game (action bar) | KEEP | Sole primary. |

Result: the setup wall drops from 5 setting groups + a leaderboard to
3 groups + one disclosure — a screen a host parses in five seconds.

### 2.3 Player home — h2h (`player.html` `#p-home`)

The second-worst screen (§3, hotspot 2). It merges two different users —
the **joiner** (majority, arrives via QR/link, needs 2 fields) and the
**starter** (needs settings) — onto one scrolling page with **two
competing `btn-primary`s** ("Join" mid-page, "Start a New Game" in the bar).

| Element | Verdict | Notes |
|---|---|---|
| Team name input | KEEP | First field, both flows share it. |
| Join code + Join button | KEEP | The joiner's whole world. |
| "or start a new game" divider | REMOVE | Replaced by a two-panel step (below). |
| Rounds / Seconds / Movement / Difficulty segments | CONTEXTUAL | Shown only after tapping "Start a new game" — the landing's panel-swap pattern, already proven. |
| "Start a New Game" (action bar) | DEMOTE | Becomes a secondary "Start a new game →" under the join card; the settings panel it reveals owns the primary "Open the Room." |
| Resume banner | KEEP | |
| Next-game setup (`#p-next`) | COLLAPSE | It duplicates the same 4 segments a third time. Reuse the one settings panel; only the heading ("👑 Your game now") differs. |

### 2.4 Lobbies

**Couch lobby (`#h-lobby`)** — hotspot 4 (§3). Three ways to attach a TV
are explained *simultaneously* (QR + caption, "Send the TV link" button,
"TV has a browser? Open …" typing line), followed by a note saying you
don't need a TV at all. Four blocks of instruction for an optional
accessory.

| Element | Verdict | Notes |
|---|---|---|
| Huge room code | KEEP | Add a small "Room code" eyebrow; drop the redundant `<h1>Room</h1>`. |
| TV QR + caption + send button + typing line | COLLAPSE | Into one "📺 Put it on a TV" module: QR + one caption visible; "Send the TV link" and the typing fallback inside the same expanded area. Reuse the h2h `.tv-add` details pattern — it already exists and is right. |
| "No TV? No problem…" waiting note | KEEP | One status line, already state-aware via `lobbyReadiness`. |
| Abandon (action bar) | DEMOTE | Ghost/text style. Destructive actions never dress like siblings of Start Round. |
| Start Round | KEEP | Sole primary. |

**H2H lobby (`#p-lobby`)** — mostly right (the collapsed `.tv-add` proves
the pattern). Remaining noise:

| Element | Verdict | Notes |
|---|---|---|
| Code + join QR + "Send invite link" | KEEP | Two audiences (across the table / across the internet); both earn their place. |
| `pJoinUrl` typeable line | DEMOTE | Caption-size under the QR. It duplicates the QR and the share button for the rare can't-scan case. |
| `pScreenNote` + `pLobbyNote` (two stacked muted lines) | COLLAPSE | One status line: TV state folds into the lobby note ("3 teams in — start when ready · TV ✓"). |
| "📺 Add a TV — optional" details | KEEP | The reference implementation. |
| Teams roster | KEEP | |
| Leave / Start Game | KEEP | Demote Leave to ghost style, as with Abandon. |

### 2.5 Panorama / exploration (all pages)

The best in-game screen — full-bleed imagery, 3 HUD items, one button.
**KEEP everything**: viewer, HUD (round / locked-count / timer), "Make
Guess" primary, one-shot pano hint. One change: the corner utilities
(🍪 consent, 🔊 sound) become CONTEXTUAL (§4 layer rules) — during
`roundActive`/`guessing` the only chrome is the game.

### 2.6 Guess map (h2h phone; couch and daily are milder)

**Hotspot 1** (§3). Simultaneous inventory on first-ever play: hint card
(3 lines + button, z2500) + guess-hint banner (top) + HUD timer +
lock-now pill (z600) + SUPER SURE pill (z600) + action bar (2 buttons) +
🍪 (z2900) + 🔊 (z2900), plus "Team X locked in!" toasts and moving rival
pins. Verdicts:

| Element | Verdict | Notes |
|---|---|---|
| Map + rival pins | KEEP | The gamesmanship layer is the game's best emergent mechanic. |
| "Tap the map to drop your pin" hint | KEEP | But it disappears once a pin exists — the "Drag to adjust, then lock it in" second state is REMOVE (the draggable pin teaches itself). |
| Timer (HUD) | KEEP | |
| Lock-now estimate pill | COLLAPSE | Into the primary button as a live sublabel: "Lock It In · ≈ +3,240". One element instead of two; the estimate now lives exactly where the decision is made. |
| SUPER SURE pill (unspent, disarmed) | DEMOTE | From a full-width labeled pill ("🔥 SUPER SURE · double or nothing · once per game") to a 🔥 chip docked to the action bar. Tap opens a small sheet that owns ALL the explanation (§6.1). |
| SUPER SURE pill (spent: "SUPER SURE — spent") | REMOVE | A disabled button explaining a thing you can no longer do is pure noise. Absence communicates spent. |
| SUPER SURE arm/disarm toasts | REMOVE | The explanation moves to the chip's sheet; the armed state shows on the button itself ("🔥 Lock In ×2 — or 0"). Mechanic rules must never live in a 2.5 s `white-space: nowrap` toast (which clips on narrow phones today). |
| Back to Street | KEEP | Legit secondary; ghost style. |
| Lock It In | KEEP | Sole primary, now carrying the estimate. |
| 🍪 / 🔊 corner buttons | CONTEXTUAL | Hidden during play (§4). |
| First-time hint card | KEEP | But it must be the *only* overlay while shown (§4 rule: one sheet at a time — the SUPER SURE line moves out of it and into the chip's sheet). |

### 2.7 Locked / waiting (`#p-locked`)

| Element | Verdict | Notes |
|---|---|---|
| LOCKED IN stamp + rank + sub-line | KEEP | Good drama, state-aware copy (TV vs no-TV). |
| "Who's in" roster | KEEP | The race is the content while waiting. |
| "Close Round (forfeit stragglers)" | KEEP, reword | Already contextual (host + stuck only). Label: "Close Round" with the consequence in a confirm toastless sub-line — parentheses in a button is a spec, not a label. |

### 2.8 Reveal (phone: h2h `#p-reveal`, couch-no-TV `#h-reveal`)

**Hotspot 5** (§3). The payoff moment is a scroll: 36 vh map, then three
stacked stat cards (Location / Distance / Points + two injected sub-lines),
then *two* lists ("This round", "Totals"), then a countdown line, then the
bar. The gasp ("*that's* where it was?!") is squeezed into a third of the
screen while three cards restate numbers the lists repeat.

| Element | Verdict | Notes |
|---|---|---|
| Reveal map | KEEP, grow | To ~52 vh. It is the payoff; everything else is commentary. |
| Location stat card | COLLAPSE | Place name becomes the headline *on/under the map* (accent, big) — the TV's `reveal-place` treatment, phone-sized. |
| Distance + Points cards | COLLAPSE | One result line under the place: "**+3,120** — 812 km · ⚡+140". The injected speed/SS sub-lines fold into it. |
| "This round" list + "Totals" list | COLLAPSE | One board: `👑 Atlas Cats · +3,120 → 9,480` (round delta → running total). Halves the scroll, and the delta-next-to-total is *more* legible than two lists the eye must join. |
| SUPER SURE verdict (map halo + note) | KEEP | The table-eruption moment. Verdict rides the merged result line + the map halo. |
| Auto-advance countdown + Hold | KEEP | Hold appears only while counting — already contextual. |
| Reveal cascade animation | KEEP, trim | Fewer elements = shorter cascade; cap total delay ≤ 0.35 s. |

### 2.9 Game over

| Element | Verdict | Notes |
|---|---|---|
| Standings / crown / podium (TV) | KEEP | |
| Host bar: Share + Save to leaderboard + New Game (3 equal buttons) | DEMOTE/COLLAPSE | One primary ("New Game" / winner's "Set Up the Next Game"), "📤 Share" secondary, and **auto-save** to the local leaderboard (it's localStorage — there is no reason to make a human press a database button). Three flex-1 buttons currently squeeze illegibly on a 360 px phone. |
| Player bar: Leave + Share + Set Up the Next Game | DEMOTE | Same rule: primary right, Share secondary, Leave ghost. |
| Handoff note | KEEP | |

### 2.10 Daily Challenge (`daily.html`)

| Element | Verdict | Notes |
|---|---|---|
| Intro: today-number card + date | KEEP | |
| Intro rules paragraph (4 sentences) | COLLAPSE | Two lines max: "Five mystery places — the same five for everyone today." / "One run per day. Closer + faster = more points." The pano/map hints teach the rest in place. |
| Round + guess map | KEEP | Inherits the §2.6 fixes (no SUPER SURE here already — good restraint). |
| Reveal: 4 stat cards | COLLAPSE | Same §2.8 shape: map + place + one result line + "Total so far" as a single row, not a fourth card. |
| Done: score + emoji row + share | KEEP | The emoji row is the product's face in a chat. |
| Done: two stacked note paragraphs | COLLAPSE | One line: "Fresh five tomorrow — or start a party with friends." (link on "start a party"). |

### 2.11 TV / screen (`screen.html`)

The most disciplined surface — corners-only HUD, imagery as the show.
**KEEP** essentially everything: entry, lobby chips, round corners,
live guess map, reveal split, h2h grid/locked stamps/3-2-1, podium +
confetti. Two demotions: the game-over "New game — enter a room code"
button + hint line shrink to one quiet line (a TV is not a touch surface;
the real path is "the screen follows the host"), and the h2h lobby gains
nothing new (it already narrates itself).

### 2.12 Persistent chrome (all pages)

| Element | Verdict | Notes |
|---|---|---|
| Reconnecting pill | KEEP | Already contextual. |
| Toasts | KEEP, constrain | Max-width 92 vw with wrapping (today `white-space: nowrap` clips long toasts); copy ≤ ~40 chars; **never** used to explain mechanics. |
| Consent banner | CONTEXTUAL | §3 hotspot 3. Legally inviolable opt-in stays; *when it asks* changes. |
| 🍪 consent button | CONTEXTUAL | Visible in calm states (setup, lobby, reveal, game over, landing); hidden during `roundActive`/`guessing`. |
| 🔊 sound toggle | CONTEXTUAL | Same rule. Sound state changes are rare and never urgent mid-round. |
| Hint cards | KEEP | The one-shot mechanism is exactly right; add the "only overlay on screen" rule (§4). |

---

## 3. The five worst clutter hotspots, ranked

1. **The h2h guess map** — up to 8 simultaneous floating elements at the
   game's decision peak; three of them (pill, pill, hint card) explain
   scoring three ways at once; SUPER SURE persists even when spent; toasts
   with mechanic rules clip on narrow screens. *(Fix: §2.6, §6.1.)*
2. **Player home** — joiners (the majority, arriving by invite link) face
   the full game-setup wall and two competing primary buttons to do a
   two-field job. *(Fix: §2.3, §6.2.)*
3. **Consent-over-the-join-moment** — on a first-visit
   `player.html?room=CODE`, the GDPR banner (z3000) sits over the join
   form: the very first GeoParty experience is a cookie dialog. Nothing
   loads before accept anyway, so the *ask* can move to a calm moment
   (lobby wait / reveal / landing) without weakening the gate one pixel.
   *(Fix: §6.5.)*
4. **The couch lobby's TV seminar** — three attachment methods explained
   simultaneously plus a "you don't need one" note; the optional accessory
   gets more words than the game. *(Fix: §2.4, §6.3.)*
5. **The phone reveal + game-over pile** — three stat cards, two lists,
   and a 3-equal-button action bar bury the payoff map and the one number
   that matters. *(Fix: §2.8–2.9, §6.4.)*

---

## 4. The design system: hierarchy rules that prevent re-cluttering

Not a restyle — the identity (near-black `#111`, `#ffcf3f` accent, system
sans, big friendly radii) is good and stays. This codifies *placement and
weight* so the next seven features don't each invent a floating pill.

### 4.1 The layer model — one occupant per layer, per state

| Layer (z) | Occupant | Hard rule |
|---|---|---|
| Stage (0) | Pano / map / content | Full-bleed on play screens. |
| HUD (400) | ≤ 3 corner items | Text-shadowed, pointer-events none. Nothing new may join the HUD. |
| Context pill (600) | **At most one** floating pill | Today: lock-now + SUPER SURE = two. After: zero (both fold into the action bar, §6.1). The slot stays defined for the future — but it's a slot, not a stack. |
| Action bar (500) | 1 primary + ≤ 1 secondary | Primary always rightmost/widest. Secondary = ghost style (`--panel-2` text button), never a second filled button. 3-button bars are forbidden — third actions go to overflow or die. |
| Sheet (2400–2500) | **At most one** (hint card, SUPER SURE sheet, TV-add expanded) | A sheet opening dismisses any other. Never two stacked teaching surfaces. |
| Utility corners (2900) | 🍪 left, 🔊 right | Only in calm states: setup, lobby, reveal, game over, landing, daily intro/done. Hidden during `roundActive`/`guessing`. |
| System (3000) | Consent banner, reconnect pill, toasts | Toasts: wrapping, ≤ 2 lines, status only — never rules. |

### 4.2 Typography & density

- **Display** (room code, countdown, place name, score): 800 weight,
  `tabular-nums` for anything that ticks. Already present — keep.
- **Title** 1.6 rem / **Body** 1 rem / **Caption** 0.85 rem uppercase
  muted (the existing `.label` treatment). No new sizes.
- **One card max per screen.** Cards are for the single hero fact
  (today's daily number, your score). Everything enumerable is a list row.
  (The reveal currently uses three cards + two lists; §2.8.)
- Spacing on a 4 px grid; screens must fit a 360×640 viewport with at most
  one scroll for lists — never for the primary action.

### 4.3 Controls & touch

- Minimum touch target 44×44 px. (Corner utilities are 34 px today —
  enlarge the hit area, keep the visual size.)
- Segmented controls: default-visible only when the choice defines the
  experience (Difficulty, Rounds, Teams); convenience settings live behind
  one `<details>` ("More options").
- Destructive/exit actions (Abandon, Leave) are ghost buttons, never
  filled peers of the primary.
- Emoji in labels only where meaning-bearing (📤 share, 🔥 the bet,
  👑 winner). Not as decoration on every button.

### 4.4 Cards vs sheets vs overlays — when each is appropriate

- **Card (inline)**: one hero fact per screen (§4.2).
- **Bottom sheet**: teaching + optional powers (hints, SUPER SURE,
  TV-add). Dismissible, one at a time, never covers the action bar's
  primary.
- **Center overlay + scrim**: only for ritual interstitials that must stop
  the room (Showdown card, h2h 3-2-1). Nothing else earns a scrim.
- **Toast**: past-tense status ("Invite link copied") — ≤ 2 s of reading.

### 4.5 Motion & sound restraint

Keep S4's beats (lock-in stamp, countdown ticks, reveal sting, cascade)
— they're punctuation, and reduced-motion already collapses them. Rules:
no new looping animation off the TV; cascades ≤ 0.35 s total stagger;
sound cues only on state changes the player caused or must notice. The
current pass already obeys this; the rule exists so the next pass does too.

---

## 5. Copy principles (applied throughout §6)

- Buttons say what happens: "Lock It In", "Start Round", "Send invite
  link". No parenthetical specs in labels.
- **Each rule of the game is explained in exactly one place** — the
  moment's hint card or sheet. Pills show numbers, toasts show outcomes,
  buttons show actions. (Today "double or nothing, once per game" appears
  in a button label, a hint line, a toast, and a pill.)
- Notes about absent things ("No TV needed") get one line, once, and
  disappear when the thing arrives (already done — keep).
- Sentence case everywhere except the stamps (LOCKED IN, SUPER SURE) —
  shouting is reserved for the game's two shouting moments.

---

## 6. Before → after: the five screens, with exact copy

### 6.1 H2H guess map

**Before:** hint card (3 lines) + top banner + timer + estimate pill +
SUPER SURE pill + [Back to Street][Lock It In] + 🍪 + 🔊 + toasts.

**After:** map with rival pins · top banner (until first pin) · timer ·
action bar only. 🍪/🔊 hidden. One 🔥 chip docked left of the bar.

- Top banner (no pin yet): **"Tap the map to drop your pin"** — h2h
  first-timers' one-shot hint card instead reads:
  - Title: **"Drop your pin"**
  - "Closer = more points. Faster = bonus."
  - "Rivals see your pin move — bluff away."
  - Button: **"Got it"**
- Primary button, live sublabel (replaces the estimate pill):
  **"Lock It In · ≈ +3,240"** (armed: **"🔥 Lock In ×2 — or 0"**)
- 🔥 chip (only while the bet is unspent). Tapping opens the one sheet:
  - Title: **"SUPER SURE"**
  - "Double or nothing, once per game. Closest pin this round: your
    points ×2. Anyone closer: you score 0."
  - Buttons: **"Arm the bet"** / **"Not now"**
- When spent: no chip, no disabled pill, nothing.
- Secondary: **"Back to street"** (ghost).

### 6.2 Player home (join vs start)

**Before:** name + join + error + divider + 4 setting groups + "Start a
New Game" bar button (two primaries, one long scroll).

**After — panel 1 (default, and the only panel a `?room=` arrival sees):**
- **"Your team name"** — input, placeholder "The Atlas Cats"
- **"Have a code?"** — code input + primary **"Join"**
- Ghost link-button below: **"Start a new game →"**

**After — panel 2 (starter, slides in; also serves `#p-next`):**
- **"Difficulty"** Casual / World tour / Expert
- **"Rounds"** 3 / 5 / 10
- ▸ **"More options"** (collapsed): Seconds per round, Movement
- Action bar primary: **"Open the Room"** · ghost **"← Back"**

### 6.3 Couch lobby

**Before:** "Room" h1, code, TV QR, cast caption, send button, typing
line, no-TV note, [Abandon][Start Round].

**After:**
- Eyebrow **"ROOM CODE"** + the huge code (h1 removed)
- One line: **"No TV? No problem — the reveal shows right here."**
  (swaps to **"TV connected ✓"**)
- One collapsed module: ▸ **"📺 Put it on a TV"** — expanded: QR,
  caption **"Scan with any spare phone or tablet, then cast it to the
  TV."**, button **"Send the TV link"**, caption-size typing fallback.
- Action bar: primary **"Start Round"** · ghost **"Abandon"**.

### 6.4 Phone reveal

**Before:** heading, 36 vh map, 3 stat cards + 2 injected sub-lines, two
lists, countdown, bar.

**After:**
- **"Round 3 of 5"** (small heading)
- Map at ~52 vh; under it, accent display: **"Ubon Ratchathani,
  Thailand"**
- One result line: **"+3,120 pts** · 812 km · ⚡+140 fast" (SUPER SURE
  verdict appends: **"🔥 SUPER SURE ×2"** / **"🔥 SUPER SURE — 0"**)
- One board (replaces both lists), rows:
  **"👑 Atlas Cats  +3,120 → 9,480"** / "Pin Pals  +1,870 → 8,910" …
- Countdown line + **"✋ Hold"** (unchanged) · primary **"Next Round"**.

### 6.5 Consent moment (all game pages)

**Before:** banner over the join form on every first visit; 🍪 + 🔊 pinned
above the action bar through entire rounds.

**After:** the banner never interrupts a join or a round. It shows on the
landing and daily intro as today, and on game pages it waits for the first
calm state (lobby wait, locked screen, or reveal). Copy tightens:
- **"🌍 Share anonymous play stats?** Scores, distances, and modes —
  never your guesses, names, or anything about you. EU-hosted, change
  anytime."
- Buttons: **"No thanks"** / **"Sounds good"**
- 🍪/🔊 appear only in calm states (§4.1). *The opt-in gate itself is
  untouched: nothing loads or fires before an explicit accept, exactly as
  now — only the timing of the question moves.*

---

## 7. Roadmap: P0 / P1 / P2

Effort: S ≤ ½ day · M ≈ 1–2 days. Risk = regression risk to shipped
behavior. Every item lists the PostHog signal that judges it (all
pre-instrumented unless noted).

### P0 — clutter removals (pure subtraction, ship first)

| # | Change | Where | Effort | Risk | Signal |
|---|---|---|---|---|---|
| P0.1 | Hide 🍪/🔊 during `roundActive`/`guessing`; show in calm states | `consent.js`, `fx-ui.js` (+ a pure "calm state" predicate, testable) | S | Low | `sound_toggled` volume shouldn't collapse (it's a lobby/reveal action anyway) |
| P0.2 | Remove the disabled "SUPER SURE — spent" pill; remove arm/disarm toasts | `host-ui.js`, `player-ui.js` | S | Low | `super_sure_resolved` deployment rate must not drop |
| P0.3 | Toasts: allow wrapping, max-width 92 vw, audit all copy ≤ ~40 chars | `style.css` + call sites | S | Low | — (untestable CSS/copy; say so in the summary) |
| P0.4 | Couch lobby TV module: collapse to the `.tv-add` details pattern | `host.html`, `host-ui.js` | S | Low | `screen_joined.via` mix + couch `game_created → round_started` (must hold steady) |
| P0.5 | Game-over bars: 1 primary + 1 secondary + ghost; auto-save leaderboard | `host.html`, `player.html`, `host-ui.js` | S | Low | `result_shared` rate (share must not get lost in demotion); `next_game` rate |
| P0.6 | Reveal: drop the "Drag to adjust" second hint state; trim daily intro/done copy per §6 | `player-ui.js`, `daily-ui.js`, `daily.html` | S | Low | Daily started→completed gap |

### P1 — hierarchy (small redesigns, the real wins)

| # | Change | Where | Effort | Risk | Signal |
|---|---|---|---|---|---|
| P1.1 | Guess-map consolidation (§6.1): estimate into the primary button; SUPER SURE chip + sheet; kill both pills | `player.html`, `host.html`, `daily.html`, `*-ui.js`, `hints.js` (label logic is pure → tests) | M | Med — SUPER SURE hidden-until-reveal must survive; keep `lockNowLabel` pure and tested | `guess_submitted.time_seconds` (decision speed), `super_sure` deployment + win rate (does the sheet teach better than the pill?) |
| P1.2 | Player home split (§6.2) + reuse panel for `#p-next` | `player.html`, `player-ui.js`, `frontdoor.js` (routing already pure) | M | Med — deep-link `?room=`/`?create=1` paths need care | Funnel `$pageview → team_joined` on invite arrivals; `game_created` (h2h) must hold |
| P1.3 | Reveal restructure (§6.4), phone + couch-no-TV + daily | `player.html`, `host.html`, `daily.html`, `*-ui.js` | M | Med — reveal renderers are the game's payoff; visual QA on 360 px | Between-round tempo (`reveal_shown → round_started`); `game_completed` rate |
| P1.4 | Consent timing (§6.5): defer the ask to the first calm state on game pages | `consent.js` (+ pure "may prompt now" predicate, testable) | S–M | Med — the gate must stay inviolable; only the prompt moment moves | `consent_given` count trend vs `$pageview` (accept rate should rise when asked at a calm moment) |
| P1.5 | Setup disclosure: "More options" for Seconds/Movement (host + player); leaderboard demoted | `host.html`, `player.html`, `host-ui.js` | S | Low | `game_created` per setup pageview; settings mix shouldn't shift (defaults already dominate) |

### P2 — polish

| # | Change | Where | Effort | Risk |
|---|---|---|---|---|
| P2.1 | 44 px touch targets (corner utilities, seg buttons); restore pinch-zoom (`user-scalable`) with `touch-action` guards on map/pano | HTML meta, `style.css` | S | Low |
| P2.2 | Type/spacing token audit against §4.2 (one card per screen, tabular-nums everywhere that ticks) | `style.css` | S | Low |
| P2.3 | Cascade stagger cap ≤ 0.35 s; TV game-over button demotion | `style.css`, `screen.html` | S | Low |
| P2.4 | AA contrast pass on `--muted` over `--panel` | `style.css` | S | Low |

---

## 8. What NOT to change

- **The pano screen.** Full-bleed + 3 HUD items + one button is the
  product's best screen. Nothing may be added to it.
- **The TV surface.** Corners-only HUD, the farthest-first reveal, the
  3-2-1, the podium — the discipline holds; don't "enrich" it.
- **The landing.** M4's structure (one primary, one secondary, daily card,
  3 steps) is the model the rest of the app should converge to.
- **The one-shot hint mechanism** (`hints.js` claim-once flags). Change
  what hints say, never how they gate.
- **SUPER SURE's hidden-until-reveal rule** and its reveal ceremony (map
  halos, ×2/0 verdicts). Any P1.1 work must preserve invisibility on every
  live surface — a test already enforces parts of this; extend it, don't
  weaken it.
- **Zero-account, no-install, fast-join**: the QR → name → Join flow, code
  self-routing, resume banners, winner-takes-the-host handoff.
- **The consent gate's substance**: opt-in before any load/fire, the 🍪
  revoke path, PRIVACY.md promises. Only presentation timing moves.
- **Sound/motion defaults** (phones muted, TV on; reduced-motion resets).
- **Capabilities**: both play styles, remote h2h, Daily, difficulty tiers,
  movement toggle, Add-a-TV, share cards, auto-advance + hold. Everything
  in this review relocates or re-weights; nothing is removed.

---

## 9. Implementation brief (for Opus — do not implement in this change)

Scope: P0 first (one PR-sized change per row, P0.1–P0.6), then P1 in the
order 1.1 → 1.3 → 1.2 → 1.4 → 1.5. P2 rides along opportunistically.

Ground rules from `CLAUDE.md`, restated for this work:

1. **Decision logic goes in pure modules with tests.** New predicates this
   plan creates: "is this a calm state?" (chrome visibility, P0.1/P1.4),
   "may the consent prompt show now?" (P1.4), primary-button label
   composition with the embedded estimate (P1.1 — extend
   `hints.lockNowLabel`), merged reveal-board row text (P1.3 — extend
   `game.js` formatting helpers). Pure CSS/copy rows (P0.3, P2.x) are
   genuinely untestable — say so explicitly in the change summary.
2. **Instrumentation**: most rows move existing surfaces, and the
   existing events already measure them (each row's Signal column). One
   new event is justified: `super_sure_sheet_opened` (P1.1 — did the chip
   invite exploration?) with aggregates only (`mode`), added via the
   `EVENT_SCHEMA` + sanitizer-test + `docs/analytics.md` process. If a row
   adds no signal, write that justification in the summary rather than
   inventing an event.
3. **Never touch**: the PostHog init key/options, `tools/`,
   `data/location_pool.json`, the SUPER SURE hidden-in-play rule, the
   consent gate's accept-before-load contract.
4. **Verification**: `npm test` + `npm run check` green per change;
   manual pass on a 360×640 viewport for every screen a row touches
   (the guess map and reveal especially), with a TV attached and without.
5. **Copy is spec**: use §6's strings verbatim; where a screen isn't
   specified, apply §5's rules.

The success criterion for the whole pass: on any phone screen during play,
count the UI elements that are not the game — the number should be ≤ 2
(action bar + at most one contextual element). Today on the guess map it
is 6–8. That count, not aesthetics, is what "the UI is getting cluttered"
means, and it's the number to drive to zero-ish and then defend.
