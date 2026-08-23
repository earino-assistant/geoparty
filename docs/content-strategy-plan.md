# GeoParty — Content Strategy Plan (v1)

Author: Yichen (CTO seat) · Date: 2026-08-23 · Scope: user-facing copy audit +
prioritized execution plan. DIAGNOSE-AND-PLAN ONLY — no edits made, no commits.

Lens: content strategist at Meta / big tech — experiences that are clear,
consistent, compassionate. Solve people problems, not polish sentences. Every
proposal names the *surface*, the *moment*, and *why*.

Sources read in full: all 6 HTML pages (index, daily, howto, host, player,
screen), every JS module that renders or builds user-facing strings (daily-ui,
host-ui, player-ui, screen-ui, screen-h2h, share, share-ui, ghost, fx, game,
hints, modifier, supersure, decoy, twist, night, records, recap, couchscreen,
landing-ui, tvlink, autoadvance, report-ui), and the tests that lock any of it.

---

## 0. Executive summary

The game's copy is, by and large, already strong — clear, warm, and mostly free
of jargon. There are **four real, fixable problems**, in priority order:

1. **"Send your verdict"** (daily-ui.js:825) is the single worst button label in
   the product. It uses an internal-code metaphor ("verdict") where the user
   needs an action verb. This is the P0.
2. **Three words for one concept.** The same Ghost Duel feature is called
   "challenge", "duel", and "verdict" across the intro, the reveal, the done
   screen, and the share card. Meta would call this a vocabulary failure — the
   same idea must have one name.
3. **Engineering jargon that already leaked** into a few user-facing lines
   ("verdict", "dead heat", "exhibition's" cousin). Mostly behind the curtain —
   good — but the visible instances need cleaning.
4. **The win celebration / done-screen tone** is flat ("Daily #N done!") and two
   of the five win lines ("take the room", "run the table") are metaphors that
   don't land for a geoguessing game.

There is **no analytics instrumentation required** for any of this. All items
are pure copy edits (a handful touch pure string formatters that ARE unit-tested,
flagged inline). Per CLAUDE.md, where a change is a pure copy edit I state so
explicitly rather than inventing events.

---

## 1. Full audit of user-facing copy, cataloged by surface

### 1.1 Landing (index.html + landing-ui.js)
| Where | Current string | Verdict |
|---|---|---|
| index.html:39 tagline | "Guess where in the world you are. Phones in, pins down." | Good, distinctive. |
| index.html:7,19 meta/og | "Guess where in the world you are — phones in, pins down. No app, no accounts." | Good. |
| index.html:52 | "Same spot, same clock — rival pins in plain sight." | Good. |
| index.html:57 | "One phone drives, everyone shouts directions." | Good. |
| index.html:77 | "Daily Challenge — five mystery places, the same for everyone today." | Good — but "Daily Challenge" is the full name here, while the page h1-tag and done screen use bare "Daily" (see 1.2). |
| index.html:43-44 CTAs | "Start a party" / "Have a code? Join" | Good, clear verbs. |

**Verdict:** landing is the strongest surface. No mandatory changes.

### 1.2 Daily Challenge (daily.html + daily-ui.js)
| String (file:line) | Verdict |
|---|---|
| daily.html:42 h1-tag "daily challenge" (lowercase) vs index:77 "Daily Challenge" (title case) | **Inconsistent capitalization** of the same proper noun. |
| daily.html:69 "Play today's Daily" / daily-ui.js:1058 "Play Today's Daily" | Uses "Daily" as a noun. Fine as casual shorthand, but inconsistent with the title-cased "Daily Challenge". |
| daily.html:62,149 "⚡ Hard mode — no moving, 30 seconds" / "Try hard mode" | Good, self-explaining. |
| daily-ui.js:368 "Round 1/5" | Fine. |
| daily-ui.js:553-556 reveal duel line: "You +12,340 · 👻 +11,500 — you take the round" / "👻 takes the round" / "dead heat" | Good game-y beat. "dead heat" is a mild racing idiom — low priority. |
| daily-ui.js:765-767 done title: "Daily #142 done!" / "You played Daily #142 ✓" | "done!" is flat for the game's signature solo win moment (see §4). |
| daily-ui.js:825 **"Send your verdict"** | **P0 — see §2.** |
| daily-ui.js:826-827 duel head: "You won the duel! 🏆" / "The ghost got you 👻" | "You won the duel" uses the "duel" word — vocabulary clash with "challenge" (see §3). |
| daily-ui.js:860 "Dead heat." | See §3. |
| daily-ui.js:829-832 note: "That was another day's five…" / "One run per day keeps scores honest…" | Good, honest, kind. |
| daily-ui.js:282,724,1128 toasts (challenge broken/expired) | Good — clear what happened, what to do. |

### 1.3 Ghost Duel flow (the duel surfaces + share)
See §2 and §3 in depth. Briefly:
- Inbound eyebrow (daily-ui.js:1045) "⚔️ CHALLENGE — Daily #142" + "Take the challenge" button: **good**.
- Explain (daily-ui.js:1047-1049): "A friend sent you their run. Their ghost pin appears at every reveal — same five places, same rules." **Good**.
- Outbound done-button "Send your verdict" (daily-ui.js:825): **bad — P0**.
- Share card (share.js:127-147): "⚔️ Beat my ghost: url" / "⚔️ Your move: url" — the **"Your move"** version is the "verdict card". Both are flavor lines; "Your move" is a chess idiom and doesn't say what's being returned.

### 1.4 Party modes (host.html/player.html/screen.html + host-ui/player-ui/screen-ui/screen-h2h)
| Where | String | Verdict |
|---|---|---|
| host.html:130 "New game" / player.html:83 "Start a new game" | Fine. "game" = one play (consistent). |
| host.html:213 "Final standings" (h1) | Static header — host phone never sets a winner headline. Defensible (host is operator, not a competitor). P2: could mirror the winner line. |
| player.html:189 default "Game over!" | Correct for non-winners. |
| player-ui.js:2029 winner "🏆 You won!" (champion) / winLine(seed, winnerName) | Good, but depends on WIN_LINES quality (§4). |
| player-ui.js:2063 handoff "Winner runs the table" | Reuses a WIN_LINE metaphor ("run the table") in a *different* meaning. **Vocabulary collision** — same phrase, two senses (§4). |
| screen-h2h.js:180 "👑 X won — their phone runs the next game" | Same "runs the next game" (correct sense). Fine. |
| Host settings labels (Difficulty/Rounds/Teams/Seconds/Movement/Twists) | Clear. |
| player-ui.js:492-530 error copy ("That's not a room code.", "Room not found — check the code.", "That game already started.", "Room is full (4 teams max).") | Excellent — what happened + what to do. |
| lobby "Send the TV link" / "Add a TV — optional" | Good. |

**No P0/P1 in party modes.** The couch/h2h surfaces are in good shape.

### 1.5 Lock-in verbs (a real inconsistency)
LOCK_LABELS (hints.js:135-139) + call sites:
- h2h phone & daily: **"Lock it in"** / "Lock in"
- couch host: **"Confirm guess"** / "Confirm"

Same action (drop pin, commit the guess), two verbs, one per mode. This is a
consistency failure — the user shouldn't have to learn the verb differs by
which screen they're on. **P1** (§3 item C).

### 1.6 Medals / result copy (records.js, share.js, game.js)
- EMOJI_BUCKETS captions (share.js:85-90): "Nailed it" / "Right region" / "Right continent" / "Lost". **Good**, felt-tier.
- ACE caption (records.js:115): "ACE!". Good.
- RevealResultLine (game.js:128-148): "+3,120 pts · 812 km · ⚡+140 fast · ACE!". **Good**.
- resultRowText / boardRowText: "+3,120 → 9,480". Good.

---

## 2. THE "Send your verdict" fix (P0)

**Current (daily-ui.js:825):** `if (extra.verdict) $("btnDShare").textContent = "Send your verdict";`
**Surface:** the Daily Challenge done screen, on a *live Ghost Duel run* (the
recipient just played their five against the friend's ghost and reached the done
screen).
**Moment:** the user has finished; the primary button's action is to *send back
their own completed run as a new challenge link* — the return volley in an
asynchronous ghost duel.

**Why it's bad:** "verdict" is a judge's ruling. It describes a *result
announcement*, not an *invitation to play*. A user who reads "Send your verdict"
does not learn they are about to fire a challenge back at their friend. It
(1) reads as authority, not play, and (2) uses the internal code term.

**Proposed label — primary:**
> **"Challenge them back"**

Rationale:
- It names the action with a clear verb ("challenge") and the recipient
  ("them" = the friend whose ghost you just played).
- It is a **perfect reciprocal pair** with the inbound button already on the
  intro: **"Take the challenge"** → **"Challenge them back"**. Same word
  ("challenge"), opposite direction. That symmetry is what consistency feels
  like to a user.
- It reads as play (a game, a duel), not a ruling.

**Alternates (if "them" feels cold / you want the run explicit):**
- "Send your run back" — names the *artifact* (your run) rather than the duel.
  Slightly longer; good.
- "Return the challenge" — clean, slightly formal.
- "Challenge a friend" — loses the "this is a return" context.

**My recommendation:** "Challenge them back" as primary, "Send your run back" as
the runner-up. Both kill the verdict metaphor.

### Surrounding duel copy (change with it for cohesion)
| file:line | Current | Proposed | Why |
|---|---|---|---|
| daily-ui.js:825 | "Send your verdict" | **"Challenge them back"** | P0 (above). |
| share.js:137 (verdict-card tail) | "⚔️ Your move: url" | "⚔️ Send your run back: url" | The card is the return challenge; "Your move" is chess idiom, doesn't say what's being sent. Aligns with the button. **Test-coupled** → update tests/share.test.js:209. |
| daily-ui.js:856-857 done head | "You win the duel! 🏆" / "The ghost got you 👻" | **"You beat the ghost! 🏆"** / "The ghost got you 👻" (keep) | The share card already says "I beat the ghost by X" (share.js:144). One opponent word ("ghost"), not "duel". Fixes the challenge-vs-duel clash (§3). |
| daily-ui.js:860 dead heat | "Dead heat." | **"You and the ghost tied."** | Plain, warm, matches tone; drops jargon. |

---

## 3. Consistency pass — one vocabulary for one concept

**The problem.** The Ghost Duel feature is called three different things across
the product:
- **"challenge"** — intro eyebrow "⚔️ CHALLENGE", intro button "Take the challenge", share card "Beat my ghost".
- **"duel"** — done headline "You win the duel!", internal comments/event names.
- **"verdict"** — the button label, and internal code (ghost.js duelVerdict etc.).

A user who reads "CHALLENGE" on the way in and "You won the duel!" + "Send your
verdict" at the end has experienced three names for one thing. That is the
consistency failure a content strategist flags first.

**The decision — one public vocabulary:**
- **The mechanic/act = "challenge"** (noun + verb). This is already the dominant,
  inbound-facing word and it reads as play. Use it everywhere a user sees a label.
  ("challenge", "challenged", "Take the challenge", "Challenge them back".)
- **The opponent = "the ghost"** (their run, their pin, "👥 ghost got you"). Already
  consistent in the reveal map and cards.
- **Kill the user-facing words** "duel", "verdict", "exhibition", "round",
  "fold". (These all remain as *internal* code/event names — no reason to rename
  variables — they just stop being spoken to the user.)

**Concrete edits (all pure copy, no logic):**

| # | file:line | Current | Proposed | Priority |
|---|---|---|---|---|
| A | daily-ui.js:861 | "You win the duel! 🏆" | "You beat the ghost! 🏆" | P0 (with §2) |
| B | daily-ui.js:860 | "Dead heat." | "You and the ghost tied." | P1 |
| C | hints.js:137 + couch button label | "Confirm guess" / "Confirm" (couch) vs "Lock it in" / "Locked" (h2h + daily) | **Unify to "Lock it in" / "Locked"** on all three surfaces | P1 — **test-coupled** (hints.test.js:178,191 asserts "Confirm guess") |
| D | daily.html:42 tag | "daily challenge" | "Daily Challenge" (title case) | P2 |
| E | daily.html:69 / daily-ui.js:1058 "Play today's Daily" / "Play Today's Daily" | keep "Daily" as casual shorthand | — but keep it consistently lower-"Daily" or title it once. Minor. | P2 |
| F | index.html:77 vs daily.html:8 title | "Daily Challenge" vs "Daily Challenge" (title/meta) — **already consistent**, but the h1-tag on daily.html:42 lowercases it. | Match the tag to the title case. | P2 |
| G | internal "verdict" → not user-facing after A/C | — | confirm none of the 8 "verdict"/"duel" surface remain after A | verify |

**Verify during review:** after §2+§3, grep for `verdict|duel` in user-visible
strings. Remaining hits should be: internal identifiers (ghost.js duelVerdict,
duelFoldPlan, event names), comments, and docs — none spoken to a user. The only
intentional user-facing keeps: "ghost" everywhere, "challenge" everywhere.

---

## 4. Tone / voice definition + win-celebration copy

**Voice (one paragraph, for the whole product):**
> GeoParty talks like the best host at a party — warm, plain, and a little
> playful, never corporate, never cold, never jargony. It says what it means
> with everyday words (drop the pin, lock it in, you beat the ghost). It
> celebrates wins out loud, comforts losses without soft-soap ("the ghost got
> you"), and explains errors in two beats: *what happened, what to do*. It
> treats the user as smart but never makes them decode internal names.

**Moment-by-moment tone:**
- Instruction: warm and short, one step at a time ("Tap the map to drop your pin").
- Celebration: big, joyful, first-person-plural ("You beat the ghost! 🏆").
- Error: calm, specific, actionable ("Room not found — check the code.").
- The solo Daily done: deserves a real celebration, not "done!".

### Win Celebration lines — WIN_LINES (fx.js:139-145)
Current:
```
"take the room",
"run the table",
"The room belongs to",        // special: "The room belongs to X"
"own the map",
"that's the game",            // special: "X — that's the game"
```
Problems:
- "take the room" — noun-verb that reads as a mumble.
- "run the table" — pool metaphor that doesn't fit geoc.
- "own the map" — actually good for a geoc game (own the map = you found it).
- "that's the game" — flat, not a win.

Also **"run the table" is reused in player-ui.js:2063** ("Winner runs the table —
your phone is the host now") in a *different* sense (handoff). Same phrase, two
meanings in the same product = vocabulary collision.

**Proposed replacement (keep the two special-case slots fixed):**
```
// position 0: "<subject> <verb> <the map>"
"own the map",            // keep — it's the good one, and position-0 has no special rule
// position 1: "<subject> <verb>"
"locked it down",
// position 2: "The room belongs to <subject>"  (special rule preserved)
"The room belongs to",    // keep the special-case slot
// position 3: "<subject> <verb> <obj>"
"read the map",
// position 4: "<subject> — <that's the game>" (special rule preserved)
"that's the game",        // keep the special-case slot
```
Net: drops the two weak metaphors, keeps "own the map" and the two special-case
slots exactly as the code expects. **fx.test.js (328-344) is structural — it
checks determinism, subject inclusion, and that all 5 lines get covered across
seeds; it does not lock the literal strings. So this is a pure copy edit and does
not break tests — but note position 2 & 4's special-case rules must be preserved.**

**Win tone on the Daily done (daily-ui.js:765-767):** "Daily #N done!" is flat
next to "You beat the ghost!" / "New personal best! 🏆". Propose for a fresh
(non-replay, non-exhibition) win:
- "Daily #N — done!" → "Daily #N — you did it! 🎉" (fresh) keeping "You played
  Daily #N ✓" for a replay. This is a tone win, not a P0. **P2.**

---

## 5. Prioritized list of copy changes

### P0 — do now, one surface, the flagged issue
| Current (file:line) | Proposed | Surface/Moment | Why it's better | Testability |
|---|---|---|---|---|
| "Send your verdict" (daily-ui.js:825) | **"Challenge them back"** | Daily done-screen primary on a duel run — the return-challenge action | Drops the judge metaphor; states the action (send a challenge back); reciprocal with "Take the challenge". | Pure copy edit — **untestable**; no logic touched. `btnDShare.textContent` is set in DOM glue (not a pure fn). State explicitly: **pure copy edit, no test.** |

### P1 (do with P0 or immediately after — they're one "duel vocabulary" sweep)
| # | Current (file:line) | Proposed | Surface/Moment | Why | Testability |
|---|---|---|---|---|---|
| 1 | "You won the duel! 🏆" (daily-ui.js:821) | "You beat the ghost! 🏆" | Done-screen duel headline | Brand word "ghost", matches share card "I beat the ghost". Kills "duel". | Pure copy (DOM glue) — **untestable**. |
| 2 | "Dead heat." (daily-ui.js:860) | "You and the ghost tied." | Done-screen duel margin | Plain, warm. | Pure copy — **untestable**. |
| 3 | "⚔️ Your move: url" (share.js:137) | "⚔️ Send your run back: url" | Verdict share-card tail | Says the return volley plainly. | **TEST-COUPLED**: share.test.js:209 asserts the tail. Update that assertion alongside. |
| 4 | "Confirm guess" (hints.js:137 couch / player-host guess button) | "Lock it in" | Host couch guess button | One verb for one action across h2h + couch + daily. | **TEST-COUPLED**: hints.test.js:171,191 asserts "Confirm guess". Update both. |

### P2 — polish / tone / capitalization (batch whenever you next touch these files)
| # | Current (file:line) | Proposed | Why |
|---|---|---|---|
| 5 | "run the table", "take the room" (fx.js:141-145 WIN_LINES) | see §4 proposal | Clearer, on-theme win lines; fix the "run the table" collision with the handoff note. **Pure copy — fx.test.js is structural, not string-locked.** |
| 6 | "Daily #N done!" (daily-ui.js:765) | "Daily #N — you did it!" (fresh only) | Match the celebration tone. **Pure copy — untestable.** |
| 7 | "Daily #N — done!" vs replay "You played Daily #N ✓" | (keep distinct paths) | fine already; just the fresh-path tone. |
| 8 | daily.html:42 "daily challenge" | "Daily Challenge" | Capitalization consistency with index.html:77. Pure copy. |
| 9 | "That's not a room code." / "Room not found — check the code." | (no change) | already good. Document as "keep". |
| 10 | Report/consent copy (report-ui.js, consent.js) | (no change) | already clear + kind. |

**No new analytics events.** All items are copy; none asks a product question that
existing instrumentation doesn't already answer. Per CLAUDE.md, no new `track`
calls, no schema additions.

---

## 6. What NOT to touch (anti-churn)

- **"round"** — is standard party-game vocabulary ("Round 1/5"). Not jargon. Keep.
- **"hard mode"** — standard, self-explaining. Keep.
- **"pool"/"exhibition"/"fold"** — do NOT appear in user-facing copy today; they are
  code identifiers. Do not surface them. (Confirmed: "exhibition" only exists as
  `isExhibition` and produces "That was another day's five…" — good.)
- **Medal copy** ("Nailed it" / "ACE!") — strong. Keep.
- **Error copy in party/join** — already exemplary. Keep.

---

## 7. Testability summary (per repo rules)

- **P0 "Challenge them back"** — pure copy edit; **untestable** (DOM glue). State
  "pure copy" explicitly; no test, no analytics.
- **P1 #3 (share tail), #4 (couch lock verb)** — these two live in pure formatters
  (share.js, hints.js) that ARE unit-tested. Update the two assertions
  (share.test.js:209, hints.test.js:171/191) **in the same change**. Not pure
  — but a one-line assertion sync, not a new test.
- **P1 #1, #2, P2 #5, #6, #8** — pure copy edits in DOM glue or un-asserted pure
  formatter; **untestable**; fx.test.js WIN_LINES coverage is structural (covers
  count/subject) and survives the rewording.

No instrumentation anywhere; no consent implications; no schema additions.

---

## One-line summary for Eduardo

The copy is 90% there. The single must-fix is **"Send your verdict" →
"Challenge them back"** (P0, one line, pure copy). Then run one small
consistency sweep so the Ghost Duel is called one thing ("challenge" + "ghost")
everywhere, and a two-minute tone pass on the win lines. Nothing here needs a
test or analytics — it's words, chosen deliberately.
