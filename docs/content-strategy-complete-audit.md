# GeoParty — Complete User-String Content Strategy Audit (v2)

Date: 2026-08-23 · Scope: EVERY user-facing string in the product, plus a
prioritized execution plan. **DIAGNOSE-AND-PLAN ONLY — no edits made, no
commits, no pushes.**

Method: six parallel exhaustive sweeps over all 6 HTML pages and all 42 `js/`
modules (grep for `textContent`, `innerHTML`, `placeholder`, `title=`,
`aria-label`, `alt=`, toasts, template literals fed to render functions, plus
the static HTML body), then a synthesis pass that verified every load-bearing
claim against the source and the test suite. **~670 strings inventoried.**
Supersedes and extends `docs/content-strategy-plan.md` (v1) — see §8 for what
v1 missed.

## The trigger (field finding — center of this audit)

A real first-time user (Natha) finished a Ghost Duel run, reached the done
screen, and said **"I don't see the share option"** — while looking directly
at the primary button. The button says **"Challenge them back"**
(`js/daily-ui.js:825`, shipped as v1's P0 fix). It is the share trigger, and it
never says share or send. He only shared after being told the button does it.

That is the proof point for this audit's bar: **"Challenge them back" is
on-brand but ambiguous.** It names the *social meaning* of the action and hides
the *mechanical* action (send/share your run). v1 explicitly ranked
"Send your run back" as its runner-up (`docs/content-strategy-plan.md` §2) and
chose brand symmetry over function-naming. The field falsified that choice.
Function-naming now wins every tie.

---

## 0. Executive summary

| Surface group | Files | Strings | PRECISE | Flagged |
|---|---|---|---|---|
| HTML pages (+ frontdoor.js, pwa.js — both 0) | index/daily/howto/host/player/screen.html | 253 | ~172 (+12 placeholder-class) | ~69 |
| Daily / Ghost / Share | daily-ui, daily, ghost, share, share-ui, recap, records | 92 | ~60 | ~32 |
| Player + modifiers | player-ui, hints, hints-ui, modifier, modifier-ui, supersure, decoy, twist | 153 | ~87 | ~66 |
| Host / landing / TV-link | host-ui, landing-ui, tvlink, team-names, qr | 44 | ~28 | ~16 |
| TV screens / fx / night / reveal | screen-ui, screen-h2h, couchscreen, fx, fx-ui, night, revealmap, revealmap-ui, autoadvance | 88 | ~56 | ~32 |
| Consent / report / core formatters | consent, report-ui, chrome, chrome-ui, viewer-ui, game, h2h, imagery, analytics, pool, firebase | 40 | ~20 | ~20 |
| **Total** | | **~670** | **~435 (65%)** | **~235** |

(Dual-flagged rows counted once. String-free modules, confirmed by sweep:
`frontdoor.js`, `pwa.js`, `daily.js`, `ghost.js`, `decoy.js`, `chrome.js`,
`chrome-ui.js`, `h2h.js`, `analytics.js`, `pool.js`, `firebase.js`, `qr.js`,
`revealmap-ui.js`, `fx-ui.js` (pass-through only).)

After curation (this audit overrides ~115 sweep flags back to "keep" — see the
override notes per table and §7):

- **P0 — 3 changes.** The duel share button (the Natha fix), the copy-toast
  that calls a challenge link a "result", and a person-flip bug in the shared
  card's tie line. All three sit on the growth loop.
- **P1 — 12 consistency clusters, ~45 strings.** One vocabulary per concept:
  the share/send verb family, the lock-in verb's armed-state drift, the crown
  emoji's five meanings, "Make guess", the start/leave-a-game family,
  SUPER SURE's "— 0", "Arm the bet", the head-to-head leak, error-copy
  dead ends, round-label formats, twist tag drift, consent/report wording.
- **P2 — ~70 line edits.** Tone, capitalization, punctuation, placeholders,
  WIN_LINES (carried over from v1, still unshipped).
- **No new analytics events required** (§6). Nearly everything is a pure copy
  edit; ~10 strings are locked by existing tests that must be synced in the
  same change (§6 lists every one).

---

## 1. The bar every string must meet

**Governing principle (owner, 2026-08-23): content strategy is finding the
cleanest words that give the best affordance for OUR specific audience —
casual users who play a few minutes a week.** They don't build product
vocabulary through repetition, so the cleanest word is the most conventional,
most familiar word for the affordance — the one that requires the least
learning. Consistency is a means, not the end: it serves affordance, it never
overrides it. A rigid internal taxonomy (e.g. "send = directed, share =
broadcast") that a casual user never learns is worse than using the familiar
word even where it's "inconsistent" by an internal rule. The share icon +
"share" is the trained muscle memory for posting to a group chat — that is the
affordance, and it wins.

- **Precise** — the string names the exact action or concept. A control's
  label contains the verb of what tapping it does. Metaphor may *decorate* the
  function; it may never *replace* it. (A share button says share. A delete
  button says what gets deleted, and for whom.)
- **Unambiguous** — a first-time user can't misread it, and one concept has
  exactly one name everywhere it appears. The glance test: *cover everything
  but this string; does a first-timer know what it means and what happens
  next?*
- **On-brand** — warm, plain, playful; the best host at a party. Precision
  must not go corporate. "Share your run back" passes; "Transmit challenge
  payload" does not; neither does a label so clever it needs explaining.

Register rules (so precision doesn't flatten the voice):

1. **Controls (buttons, links, toggles): literal first.** The verb of the
   action must be in the label. Flavor rides along ("⚔️", "your run"), never
   substitutes.
2. **Status and errors: what happened + what to do next**, in that order,
   no internal vocabulary, no dead ends ("see console" is a dead end).
3. **Ceremony moments (win stamps, twist cards, "CHAMPION OF THE NIGHT"):
   all-caps shout register is allowed** — these announce, they don't ask the
   user to decide anything.
4. **Marketing surfaces (taglines, og/meta): evocative is allowed** ("phones
   in, pins down"), because the adjacent CTA carries the function. Search
   copy keeps genre terms searchers actually type ("geoguessing").
5. **Consent and privacy copy: additionally honest and specific** — plain
   words, accurate scope, no register that either soft-soaps or lawyer-talks.

---

## 2. Complete inventory

Verdicts: **PRECISE** (keep) · **AMBIGUOUS** · **OFF-BRAND** · **JARGON** ·
**INCONSISTENT**. Rows the audit overrode back to "keep" are marked
*(override: keep — reason)* under each table. Cross-refs (→ P0-1 etc.) point
into §§3–5.

### 2.1 The six HTML pages (253 strings; frontdoor.js and pwa.js contain zero)

index.html:

| file:line | string | surface/moment | verdict |
|---|---|---|---|
| index.html:6 | GeoParty | tab title | PRECISE |
| index.html:7 | Jackbox-style geoguessing party game. Guess where in the world you are — phones in… | meta description | *(override: keep — search copy; "geoguessing"/"Jackbox-style" are the terms searchers type; register rule 4)* |
| index.html:17 | GeoParty | og:site_name | PRECISE |
| index.html:18 | GeoParty — the geoguessing party game | og:title | *(override: keep — rule 4)* |
| index.html:19 | Guess where in the world you are. Phones in, pins down. Free in the browser — no app… | og:description | PRECISE |
| index.html:38 | GeoParty | hero H1 | PRECISE |
| index.html:39 | Guess where in the world you are. Phones in, pins down. | hero tagline | PRECISE |
| index.html:43 | Start a party | primary CTA | PRECISE — this is the canonical name of the act (→ P1-D) |
| index.html:44 | Have a code? Join | secondary CTA | PRECISE |
| index.html:51 | Everyone on their own phone | chooser option 1 | PRECISE — canonical mode name (→ P1-H) |
| index.html:52 | Same spot, same clock — rival pins in plain sight. | chooser subline | *(override: keep — rule 4; the option title above carries the function)* |
| index.html:56 | One phone + the TV | chooser option 2 | PRECISE — canonical mode name |
| index.html:57 | One phone drives, everyone shouts directions. | chooser subline | PRECISE |
| index.html:59 | ← Back | chooser back | PRECISE |
| index.html:65 | CODE | join placeholder | PRECISE — canonical code placeholder (→ P2, screen.html:38) |
| index.html:67 | Join | join submit | PRECISE |
| index.html:77 | Daily Challenge — five mystery places, the same for everyone today. No party needed. | daily entry card | INCONSISTENT — "Daily Challenge" (title case) is the right full name; daily.html:42 lowercases it (→ P2) |
| index.html:83 | How it works | aria-label, 3-step strip | PRECISE |
| index.html:86 | One phone starts a party | step 1 | PRECISE |
| index.html:91 | Friends join — QR or link | step 2 | PRECISE |
| index.html:96 | Add a TV. Optional. | step 3 | INCONSISTENT — third phrasing of the TV feature (→ P1-H) |
| index.html:101 | How to play | footer link | PRECISE |
| index.html:103 | Add a TV | footer link → screen.html | AMBIGUOUS — lands on a code-entry screen; nothing is "added" from here (→ P2) |
| index.html:105 | Privacy | footer link | PRECISE |
| index.html:107 | GitHub | footer link | PRECISE |
| index.html:109 | © 2026 Eduardo Ariño de la Rubia · A game by Eduardo Ariño de la Rubia | ownership line | OFF-BRAND — same name twice in one line (→ P2, ×4 pages) |

daily.html:

| file:line | string | surface/moment | verdict |
|---|---|---|---|
| daily.html:8 | GeoParty — Daily Challenge | tab title | PRECISE |
| daily.html:9,21 | Five mystery places, the same for everyone today. One run per day… | meta/og description | PRECISE |
| daily.html:19-20 | GeoParty / GeoParty Daily Challenge | og | PRECISE |
| daily.html:42 | GeoParty · daily challenge | intro H1 + tag | INCONSISTENT — lowercase tag vs "Daily Challenge" (→ P2) |
| daily.html:46-47 | Today · #— | intro stat card + pre-load placeholder | AMBIGUOUS — literal "#—" on slow load (→ P2 placeholder class) |
| daily.html:55-56 | Five mystery places — the same five for everyone today. / One run per day. Closer + faster = more points. | rules lines | PRECISE |
| daily.html:62-63,149-150 | ⚡ Hard mode — no moving, 30 seconds / Try hard mode | hard-mode entries | PRECISE |
| daily.html:68,162 | ← GeoParty | back links | AMBIGUOUS — brand as destination; means "← Home" (→ P2) |
| daily.html:69 | Play today's Daily | intro primary CTA | *(override: keep — "the Daily" as casual short name is fine once "Daily Challenge" is the titled name; see P2 caps item)* |
| daily.html:77-78 | Round 1/5 · 1:00 | round HUD skeleton | PRECISE |
| daily.html:81 | Make guess | round primary (opens the map) | AMBIGUOUS — reads as "submit"; it only opens the map (→ P1-E) |
| daily.html:88 | Tap the map to drop your pin | guess-map hint | PRECISE |
| daily.html:92 | Back to street | return to pano | PRECISE |
| daily.html:93 | Lock it in | submit | PRECISE — canonical lock verb |
| daily.html:101-110 | Round 1 · — · — · Total so far · — | reveal skeletons | placeholder class (→ P2) |
| daily.html:113 | Next round | reveal advance | PRECISE |
| daily.html:122 | Daily done! | done headline skeleton | PRECISE (JS overwrites) |
| daily.html:124-125 | Your score · — | done stat | PRECISE + placeholder |
| daily.html:129 | New personal best! 🏆 | PB banner | PRECISE |
| daily.html:136 | Share your result | done share button (non-duel default) | PRECISE — and the anchor for the share-verb family (→ P0-1, P1-A) |
| daily.html:144 | Your five places | recap title | PRECISE |
| daily.html:152-153 | Fresh five tomorrow — or start a party with friends. | done footer + inline link | *(override: keep — mid-sentence lowercase link is correct English; sweep flag dropped)* |
| daily.html:157-158 | How to play · © line | ownership row | OFF-BRAND (dup name, → P2) |

howto.html (25 strings — the strongest page):

| file:line | string | verdict |
|---|---|---|
| howto.html:6,7,16,18,29,30 | titles, meta, H1, subhead | PRECISE |
| howto.html:17 | GeoParty — how to play (og) | INCONSISTENT — lowercase vs its own `<title>` (→ P2 caps batch) |
| howto.html:34-51 | steps 1–3 + alts | PRECISE |
| howto.html:55 | The daily challenge rules card (alt) | INCONSISTENT — Daily-specific alt on a universal-scoring step (→ P2) |
| howto.html:58 | Closer + faster = more points. | PRECISE |
| howto.html:62-65 | step 5 + alt | INCONSISTENT — "Put it on the TV" vs "Add a TV" (→ P1-H) |
| howto.html:71-72 | Play today's Daily / Start a party instead | PRECISE |

host.html (61 strings — settings labels, lobby, reveal):

| file:line | string | verdict |
|---|---|---|
| host.html:8,17-19 | titles/og | PRECISE (og:title lowercase → P2 caps batch) |
| host.html:31 | reconnecting… | AMBIGUOUS — no reassurance the game survives (→ P2; same at player.html:32, screen.html:30) |
| host.html:39,43-48 | H1, resume banner (Game in progress / Room CODE — resume as host? / Resume) | PRECISE |
| host.html:52-56 | Difficulty: Casual / World tour / Expert | *(override: keep — playful, roughly self-ranking; a settings-subtitle would be a UI change, not a copy fix; noted §7)* |
| host.html:61-75 | Rounds/Teams + numerals | PRECISE |
| host.html:85 | 🎲 Surprise me | *(override: keep — adjacent to the name field; context carries it; sweep flag dropped)* |
| host.html:94-101 | More options / Seconds per round / 60/120/180/No limit | PRECISE |
| host.html:105-108 | Movement: Allowed / No moving | *(override: keep — paired label+options read fine together)* |
| host.html:113-117 | Twists: Off / Occasional / Chaos | *(override: keep — "Chaos" is a deliberate mystery-box; the twist card explains at the moment it matters)* |
| host.html:125 | Past games | PRECISE |
| host.html:130 | New game | INCONSISTENT — 4th name for "create the room" (→ P1-D) |
| host.html:141-144 | Room code · ······ · No TV? No problem — the reveal shows right here. | PRECISE (+ placeholder class) |
| host.html:146,148 | 📺 Put it on a TV / Scan with any spare phone or tablet, then cast it to the TV. | INCONSISTENT — TV-feature naming + device wording drift vs player.html:102,104 (→ P1-H) |
| host.html:150 | Send the TV link | PRECISE — model share label |
| host.html:155 | Abandon | OFF-BRAND + AMBIGUOUS — cold, and hides that it deletes the room for everyone (→ P1-D) |
| host.html:156 | Start round | INCONSISTENT vs "Start game" (→ P1-D) |
| host.html:164-166,169 | HUD skeletons + Make guess | AMBIGUOUS (→ P1-E) |
| host.html:178-184 | map hint + Lock it in | PRECISE |
| host.html:193-198 | reveal skeletons | placeholder class |
| host.html:203 | ✋ Hold | AMBIGUOUS — hold what? (→ P2; pair with countdown line) |
| host.html:204 | Next round | PRECISE |
| host.html:213 | Final standings | INCONSISTENT + OFF-BRAND — sportscaster register; player/TV say "Game over!" (→ P2) |
| host.html:224-225 | ownership row | OFF-BRAND (dup name, → P2) |
| host.html:229 | Share | AMBIGUOUS — share what? (→ P1-A) |
| host.html:230 | New game | INCONSISTENT (→ P1-D) |

player.html (72 strings):

| file:line | string | verdict |
|---|---|---|
| player.html:8,18-19 | titles/og (You're invited to a GeoParty) | PRECISE |
| player.html:20 | Grab a team and drop your pin — same spot, same clock, rival pins in plain sight. | *(override: keep — invite-card marketing register, rule 4)* |
| player.html:32 | reconnecting… | AMBIGUOUS (→ P2) |
| player.html:43-52 | H1, resume banner (Rejoin) | PRECISE |
| player.html:58-66 | Your team name / The Atlas Cats | PRECISE |
| player.html:71 | 🎲 Surprise me | *(override: keep)* |
| player.html:76-80 | Have a code? / CODE / Join | PRECISE |
| player.html:83 | Start a new game → | INCONSISTENT (→ P1-D) |
| player.html:91-92 | Room · ······ | AMBIGUOUS — bare noun; doesn't say "share this code" (→ P2) |
| player.html:96 | Send invite link | PRECISE — model share label |
| player.html:102,104 | 📺 Add a TV — optional / Scan with any phone or tablet, then cast or AirPlay it… | INCONSISTENT with host.html wording (→ P1-H) |
| player.html:106 | Send the TV link | PRECISE |
| player.html:109 | Teams | PRECISE |
| player.html:114 | Leave (JS swaps to Abandon for host) | INCONSISTENT (→ P1-D) |
| player.html:115 | Start game | INCONSISTENT vs "Start round" (→ P1-D) |
| player.html:123-125 | HUD skeletons | PRECISE |
| player.html:129,146 | Give up | AMBIGUOUS — doesn't say the round's points are forfeited (→ P2) |
| player.html:130 | Make guess | AMBIGUOUS (→ P1-E) |
| player.html:139-148 | map hint / Back to street / Lock it in | PRECISE (hint duplication with button gate text → P2 note) |
| player.html:155 | LOCKED IN | PRECISE — ceremony register |
| player.html:157 | Eyes on the TV 📺 | *(override: keep — the static default is overwritten by state-aware JS (player-ui.js:1623/1625) before display)* |
| player.html:158 | Who's in | AMBIGUOUS — means "who has locked in", reads as "who's in the game" (→ P1-B) |
| player.html:171-180 | reveal skeletons + ✋ Hold + Next round | Hold → P2 |
| player.html:189 | Game over! | PRECISE — the canonical end-screen name |
| player.html:199 | Leave the game | INCONSISTENT (→ P1-D) |
| player.html:201-202 | ownership row | OFF-BRAND (dup, → P2) |
| player.html:206 | Share | AMBIGUOUS (→ P1-A) |
| player.html:207 | Set up the next game | PRECISE (winner handoff — distinct act from "New game", keep distinct) |
| player.html:218-279 | setup panel labels (same set as host.html) | same verdicts as host.html rows |
| player.html:263 | Auto-lock pins | JARGON — engineering shorthand (→ P2: "Lock in whatever's dropped") |
| player.html:279 | Open the room | JARGON + INCONSISTENT (→ P1-D) |

screen.html (30 strings):

| file:line | string | verdict |
|---|---|---|
| screen.html:6 | GeoParty — Screen | tab title | OFF-BRAND — bare system noun (→ P2: "GeoParty — TV") |
| screen.html:16-18 | og (…put the game on this screen / Open on the TV (or cast this tab)…) | PRECISE |
| screen.html:30 | reconnecting… | AMBIGUOUS (→ P2) |
| screen.html:35-36 | GeoParty / Enter the room code from the host's phone | PRECISE |
| screen.html:38 | KWPFRT | code placeholder | AMBIGUOUS + INCONSISTENT — looks like a real code; every other field says CODE (→ P2) |
| screen.html:46-47 | lobby H1 + Waiting for the host… | PRECISE |
| screen.html:57-67 | HUD skeletons, Guessing…, waiting for a pin… | lowercase drift → P2 caps batch |
| screen.html:78-82 | — · Distance · 0 · Points | placeholder class |
| screen.html:93 | head-to-head (H1 mode tag) | JARGON + INCONSISTENT — the player chose "Everyone on their own phone"; the TV renames the mode (→ P1-H) |
| screen.html:104-116 | HUD + This round / Leaderboard | "Leaderboard" vs "Totals" vs "Final standings" → P2 (one name for the score list) |
| screen.html:121-122 | ALL TEAMS LOCKED IN · 3 | PRECISE — ceremony register |
| screen.html:130,140-141 | Game over! / Start a new game on the host's phone — this screen follows. / Enter a code | PRECISE |
| screen.html:142 | © line | OFF-BRAND (dup, → P2) |

Structural gaps found (not strings, recorded for the owner): `host.html`,
`player.html`, `screen.html` have **no `<meta name="description">`**; and when
a QR payload is too long to encode, the QR **silently disappears with no
fallback copy** (`js/qr.js:166`) — the typing fallback line happens to cover
it, but nothing says the QR is gone on purpose.

### 2.2 Daily / Ghost / Share (92 strings)

The full trigger path, verified end-to-end:
`daily-ui.js:825` (button "Challenge them back") → `daily-ui.js:985-1014`
(`wireShare` onclick) → `share.js:137` (card line "⚔️ Send your run back:
url") → `share-ui.js:14-33` (`shareResult`: Web Share or clipboard) →
`share-ui.js:28` (toast "Result copied — paste it anywhere 📋").
**Four verbs for one tap: Challenge / Send / copied (+ "Beat" on the fresh-run
card at share.js:138).**

| file:line | string | surface/moment | verdict |
|---|---|---|---|
| daily-ui.js:126,136-137,141 | imagery skip toast / degraded panel / Retry | mid-run failures | PRECISE |
| daily-ui.js:282 | This challenge was built on an older Daily — playing without the ghost. | boot toast | JARGON — "the ghost" reaches users who never saw the :1053 explainer (→ P1-G) |
| daily-ui.js:296 | Couldn't load today's places — try again. | intro error | INCONSISTENT — straight `'` vs curly `’` elsewhere (→ P2 punctuation batch) |
| daily-ui.js:368 | Round ${n}/5 ⚡ | round HUD | *(override: keep — ⚡ is taught by the "Hard mode" entry the user just tapped)* |
| daily-ui.js:428-429,343 | Drop your pin + hint bodies | hint cards | PRECISE (strings owned by hints.js) |
| daily-ui.js:449,457 | Lock it in / Lock in | lock button | INCONSISTENT — armed-state drift (→ P1-B; owned by hints.js:136-138) |
| daily-ui.js:518-519 | Time! Your pin was locked in. / Time! No pin — no points this round. | timeout toasts | PRECISE |
| daily-ui.js:531 | Round ${n} of 5 | reveal heading | INCONSISTENT — third round format product-wide (→ P1-K) |
| daily-ui.js:533,536,543 | place name / result line / 🎯 ACE — 3 km stamp | reveal | PRECISE |
| daily-ui.js:553-556 | You +12,340 · 👻 +11,500 — you take the round / 👻 takes the round / you and the ghost tied | reveal duel line | AMBIGUOUS — "👻 takes the round" uses an emoji as the sentence's subject (→ P2: "the ghost takes the round") |
| daily-ui.js:558-564 | You / Total so far + totals | reveal totals | *(override: keep — "You · 12,300 · 👻 11,900" label swap is deliberate on duel runs)* |
| daily-ui.js:568 | See my score / Next round | reveal advance | PRECISE |
| daily-ui.js:724 | This challenge was built on an older Daily — showing your result. | instant-verdict toast | PRECISE |
| daily-ui.js:766-767 | You played Daily #142* ✓ / Daily #142* done! | done titles | AMBIGUOUS — the hard-mode `*` is never glossed on any user surface (→ P2); "done!" tone → P2 (v1 §4) |
| daily-ui.js:768-769 | score + emoji grid | done stats | PRECISE |
| daily-ui.js:805-806 | Missed a day — your streak survived. 🔥 5 / 🔥 5 — day streak | streak lines | PRECISE (format drift with :1075 → P2) |
| daily-ui.js:817 | 🎯 3rd ace this month | ACE counter | INCONSISTENT — lowercase "ace" vs "ACE!" (→ P2 caps batch) |
| **daily-ui.js:825** | **Challenge them back** | **done-screen primary on a duel — the share trigger** | **AMBIGUOUS — THE trigger finding (→ P0-1)** |
| daily-ui.js:830,833 | exhibition note / one-run-per-day note | done notes | PRECISE ("exhibition" correctly never leaks) |
| daily-ui.js:856-857 | You beat the ghost! 🏆 / The ghost got you 👻 / You and the ghost tied. | duel headlines | PRECISE (v1's sweep shipped; period drift → P2) |
| daily-ui.js:861-862 | 12,340 apiece / 12,340 to 11,900 — by 440 | duel margin | AMBIGUOUS — "by 440" has no unit (→ P2: "by 440 pts") |
| daily-ui.js:866-868 | You ␣␣grid / 👻 ␣␣grid | duel grids | *(override: keep — the 👻 row is directly under the explained verdict headline)* |
| daily-ui.js:944 | recap captions | done recap | PRECISE (owned by recap.js) |
| daily-ui.js:1012 | This run has no saved pins — sharing a plain card, no ghost challenge. | share fallback toast | JARGON (→ P1-G: "…sharing your score card — without the challenge link.") |
| daily-ui.js:1050 | ⚔️ CHALLENGE — Daily #142* ⚡ | inbound intro eyebrow | *(override: keep caps — ceremony register, rule 3; the `*` → P2)* |
| daily-ui.js:1053-1054 | A friend sent you their run. Their ghost pin appears at every reveal — same five places, same rules. | intro explainer | PRECISE — the model string for the whole feature |
| daily-ui.js:1057 | Take the challenge | intro button | PRECISE |
| daily-ui.js:1063 | Play Hard Mode ⚡ / Play Today's Daily | intro buttons | INCONSISTENT — "Hard Mode" caps vs "hard mode" (→ P2 caps batch) |
| daily-ui.js:1071-1088 | records line, day badge, date | intro | PRECISE (bare 🔥4 and `*` → P2) |
| daily-ui.js:1129,1131,1133 | link-damaged / needs-newer / expired toasts | boot toasts | :1131 AMBIGUOUS — offers no action to get "a newer GeoParty" (→ P2: "…reload this page, then open the link again.") |
| daily-ui.js:1148 | Loading your challenge… | disabled intro button | PRECISE |
| share.js:57-59 | party card (We were 3.2 km from Kyoto… beat us: url) | party share card | PRECISE |
| share.js:69-71 | 🎯 Your ACE pin — 0.4 km / Your closest pin — … | win brag lines | PRECISE |
| share.js:86-90 | Nailed it / Right region / Right continent / Lost | medal captions | *(override: keep "Lost" — Wordle-terse tier name; a two-word alternative ("Way off") is P2-optional)* |
| share.js:128,134-135 | daily card line 1 (verdict lead or #N ⚡🔥 · pts) | daily card | PRECISE (`*` → P2) |
| **share.js:137** | **⚔️ Send your run back: ${url}** | **duel card line 3 — what the P0-1 button copies** | **PRECISE — and the verb the button must adopt (→ P0-1)** |
| share.js:138 | ⚔️ Beat my ghost: ${url} | fresh-run challenge card line 3 | PRECISE — recipient-facing imperative; correctly different speaker from the button (§3.1 note) |
| share.js:139 | Beat me: ${url} | plain card line 3 | PRECISE |
| share.js:144-145 | I beat the ghost by 1,840 🏆 / The ghost got me by 620 👻 | card verdict leads | AMBIGUOUS — no unit on the margin (→ P2: "by 1,840 pts") |
| **share.js:146** | **You and the ghost tied 🤝** | **card verdict lead, tie** | **INCONSISTENT — person-flip bug: won/lost speak as "I/me", the tie addresses the reader (→ P0-3)** |
| **share-ui.js:28** | **Result copied — paste it anywhere 📋** | **toast after clipboard fallback** | **AMBIGUOUS — on a duel share the thing copied is a challenge link, not a "result" (→ P0-2)** |
| share-ui.js:31 | toast(text) — the whole card as a toast | clipboard blocked | AMBIGUOUS — 3 lines in a 2.5 s toast, no instruction (→ P2 note) |
| share-ui.js:44-45,55,58 | TV-link share sheet + toasts | TV link | PRECISE |
| recap.js:105-111 | Round 2 · Kyoto, Japan · 3 km · 1,240 pts / no guess | recap captions | "Round 2" → P1-K; "no guess" vs "no pin" → P2 (unify on "no pin") |
| records.js:113-117 | ACE! + caption passthrough | reveal medals | PRECISE |
| daily.js, ghost.js | — | — | 0 strings (outcome codes routed to copy in daily-ui) |

Gap: **no countdown-to-next-Daily exists anywhere** ("Fresh five tomorrow" is
the only forward-looking line). Recorded as a product gap, not a copy defect.

### 2.3 Player + modifiers (153 strings)

The lock-in button, every state (definition `hints.js`, render
`hints-ui.js:84-97`, `player-ui.js:1177-1197`; static defaults
player.html:148, host.html:184, daily.html:93):

| state | main label | sublabel | aria | source |
|---|---|---|---|---|
| idle | Lock it in | ≈ +3,240 | Lock it in · ≈ +3,240 | hints.js:136-138,159-160 |
| armed (SUPER SURE) | 🔥 Lock in ×2 | or 0 | 🔥 Lock in ×2 — or 0 | hints.js:156 |
| no pin (gate) | Tap the map to drop your pin | — | same | hints.js:145,158 |

**The armed state silently drops "it" from the verb at exactly the moment the
stakes double** — one action, two verbs, switched mid-round (→ P1-B).

| file:line | string | surface/moment | verdict |
|---|---|---|---|
| hints.js:47-66 | Where are you? / Look around 👀… / How points work / FINAL SHOWDOWN interstitial | hint cards | PRECISE |
| hints.js:51,93,97 | Then Make Guess. | hint card line | INCONSISTENT — title-case "Make Guess" vs the button's "Make guess"; both change under P1-E |
| hints.js:72-75 | This phone is the big screen / No TV attached — the reveal lands right here. | no-TV hint | JARGON — "attached" is `screenAttached` leaking (→ P2: "No TV connected…") |
| hints.js:109-111 | Closer = more points. Faster = bonus. / Rivals see your pin move — bluff away. | map hints | PRECISE |
| hints.js:136-138 | Lock it in / Lock in | lock labels ×3 modes | INCONSISTENT (→ P1-B) |
| hints.js:145,158 | Tap the map to drop your pin (gate) | lock button no-pin state | *(override: keep — an instruction as the disabled-state label is correct; the duplication with the banner (player.html:139) → P2 note)* |
| hints.js:156 | 🔥 Lock in ×2 / or 0 | armed labels | AMBIGUOUS — "×2/or 0" of what is never on the button (→ P1-B) |
| hints.js:159 | ≈ +3,240 | live estimate sublabel | *(override: keep — adjacent to a points-scored context every round; "pts" would crowd the button; revisit only if field confusion appears)* |
| hints-ui.js:43 | Got it | hint dismiss | PRECISE |
| modifier.js:133-134 | Raise the stakes? / 🔥 Double or nothing · 🎭 Decoy pin | callout pill (both) | *(override: keep title — the second line names both actions; pill+line read together)* |
| modifier.js:141,144 | Are you SUPER SURE? Tap for double or nothing 🔥 / Feeling sneaky? Tap to plant a decoy pin 🎭 | callout pills | PRECISE |
| modifier.js:154-156 | SUPER SURE / Double or nothing, once per game. Closest pin this round: your points ×2… | sheet title + rule | PRECISE |
| modifier.js:159 | Once armed, the bet is on — no backing out this round. | commitment line | JARGON — "armed" (→ P1-F) |
| modifier.js:161 | Arm the bet | primary action | JARGON — military/engineering verb for a betting act (→ P1-F: "Place the bet 🔥") |
| modifier.js:162,171,188 | Not now | cancels | PRECISE |
| modifier.js:165-170 | 🎭 Decoy / Plant a fake pin for rivals to see. Your real pin goes dark. / Once per game. / Plant the decoy | decoy sheet | AMBIGUOUS — "goes dark" reads as "stops counting" (→ P2: "…rivals stop seeing your real pin.") |
| modifier-ui.js:33 | pill aria-label | pill accessible name | inherits the pill fix |
| supersure.js:94 | SUPER SURE ×2 / SUPER SURE — 0 | reveal badges | AMBIGUOUS — "— 0" for both lost and burned; no unit, no outcome (→ P1-F: "×0") |
| twist.js:23 | ⚡ BLITZ / 20-second clock · round ×1.5 / ⚡BLITZ / ×1.5 ⚡ | twist card, HUD tag, reveal tag | INCONSISTENT — spacing drift card↔HUD; bare reveal tags (→ P1-L) |
| twist.js:24 | 🧊 FROZEN / No moving — read the frame / 🧊FROZEN / 🧊 | same | JARGON — "the frame" (→ P1-L: "No moving — read the scene") |
| twist.js:25 | 🔒 BLIND DUEL / Rival pins are hidden / 🔒BLIND / 🔒 | same | INCONSISTENT — card "BLIND DUEL" vs HUD "BLIND"; also the product's one remaining user-facing "duel" outside the Daily (→ P1-L) |
| twist.js:26 | 🌍 LONG HAUL / Gentler curve — go bold / 🌍LONGHAUL / 🌍 | same | JARGON — "curve" is the scoring function (→ P1-L: "Far-off pins score kinder — go bold") |
| player-ui.js:168 | Some images wouldn't load — we skipped ahead. | degraded toast | *(override: keep — "skipped ahead" + the round continuing is self-evident in the moment)* |
| player-ui.js:184,189 | Couldn't load the imagery… / Retry | degraded overlay | JARGON — "imagery" (→ P2: "Couldn't load the street view."); Retry → keep |
| player-ui.js:366-368 | 👑 Your game now / Start a new game / Same teams, fresh scores… | winner-handoff setup | PRECISE |
| player-ui.js:430,454,493 | Give your team a name first(.) | 3 copies, toast+inline | INCONSISTENT — punctuation drift across 3 literals (→ P2: one literal) |
| player-ui.js:481 | Could not create game — see console | create failure | OFF-BRAND + JARGON — devtools as recovery for a party guest (→ P1-I) |
| player-ui.js:492-530 | join errors (That's not a room code. / Room not found — check the code. / That game already started. / Room is full (4 teams max). / Could not join — try again.) | inline errors | PRECISE — the model error family (:506 gets a next step, → P2) |
| player-ui.js:499 | That room is a couch game — this page is head-to-head. | wrong-mode join | JARGON — two internal mode names in one error (→ P1-H) |
| player-ui.js:565-566 | The room was closed. / Room not found. | kick toasts | PRECISE / INCONSISTENT with :497 (→ P2) |
| player-ui.js:586-587 | Couldn't follow into the next game. / Following the winner… | handoff | :586 AMBIGUOUS — no recovery (→ P2: "…ask the winner for the new code.") |
| player-ui.js:657 | You're no longer in this room. | slot-vanished toast | AMBIGUOUS — no reason/next step (→ P2) |
| player-ui.js:692 | ${Team} locked in! | race toast | PRECISE |
| player-ui.js:750 | " (you)" / " 👑" | lobby roster suffixes | AMBIGUOUS — crown = host here, = winner at game over (→ P1-C) |
| player-ui.js:753 | ready | roster tag, written unconditionally for every team | AMBIGUOUS — decorative noise posing as state (verified: unconditional) (→ P2: drop or make real) |
| player-ui.js:761 | Abandon / Leave | lobby exit | Abandon → P1-D |
| player-ui.js:766-774 | lobby status lines (Start solo, or wait for rivals… / n teams in… / Waiting for {host}… / · TV ✓ / tally· fold-in) | lobby | PRECISE (TV ✓ and triple-fact chains → P2) |
| player-ui.js:786-802 | share sheet (Join my GeoParty head-to-head — room CODE) / Invite link copied / Send this link: url | invite share | "head-to-head" → P1-H; url-in-toast → P2 note |
| player-ui.js:852 | Location pool exhausted! | out of locations | JARGON — sampler vocabulary, "!" celebrates a failure (→ P1-I) |
| player-ui.js:916 | Could not start the round | round-start failure | AMBIGUOUS — no cause/next step (→ P2: "…try again.") |
| player-ui.js:1014 | Imagery didn't load — guess from the map. | image failure toast | JARGON (→ P2: "Street view didn't load — guess from the map.") |
| player-ui.js:1022,1802 | Round 3/5 vs Round 3 of 5 | HUD vs reveal | INCONSISTENT (→ P1-K) |
| player-ui.js:1061 | 2/4 in | locked HUD chip | AMBIGUOUS (→ P1-B: "2/4 locked in") |
| player-ui.js:1242,1321-1324 | Drop your pin / modifier sheet headers + Raise the stakes? | hints, sheet | sheet title duplication with pill → P2 note |
| player-ui.js:1346-1359 | Your next tap plants the decoy — then tap again for your real pin. / 🎭 marker | decoy flow | PRECISE (toast-only rule delivery noted as UX gap) |
| player-ui.js:1560-1565 | You gave up — SUPER SURE burned. / Time! No pin — SUPER SURE burned. (+ plain variants) | forfeit toasts | JARGON — "burned" is the settlement enum (→ P1-F: "…your SUPER SURE bet is gone.") |
| player-ui.js:1567 | Time! Your pin was locked in. | timeout | PRECISE |
| player-ui.js:1607-1621 | roster (✓ in (#2) / …thinking / #2 to lock in) | locked screen | AMBIGUOUS — submission order reads as rank (→ P1-B: "✓ locked in 2nd" / "You locked in 2nd") |
| player-ui.js:1623-1625,1747-1751 | Eyes on the TV 📺 / Results land right here when everyone's in / Everyone's in! / Reveal in 3… | locked/reveal-hold | PRECISE |
| player-ui.js:1685 | ∞ | no-limit timer | AMBIGUOUS (→ P2: "No timer") |
| player-ui.js:1803 | — | unnamed place at reveal | AMBIGUOUS — reads as a load failure (→ P2: "Somewhere mysterious") |
| player-ui.js:1818-1840 | ACE stamp / 👑 board prefix / (you) | reveal | crown = round-winner here — consistent with win semantics (→ P1-C keeps this) |
| player-ui.js:1851-1896 | Finish game / Next round / {host} wraps up… / …starts the next round… | advance | PRECISE |
| player-ui.js:1920 | Holding — advance whenever you're ready | hold toast | INCONSISTENT — "advance" vs the button "Next round" (→ P2: "Holding — tap Next round whenever you're ready.") |
| player-ui.js:2002-2064 | game over (🏆 You won! / winLine / Game over! / Winner runs the table: your phone is the host now… / {winner} won — their phone is the host now…) | end screens | winLine quality → P2 (WIN_LINES); "runs the table" collision → P2 |
| player-ui.js:2170,2206 | Could not create the next game / That room is gone | toasts | :2170 INCONSISTENT with :481's wording (→ P1-I unifies) |
| decoy.js | — | — | 0 strings |

### 2.4 Host / landing / TV-link (44 strings)

| file:line | string | surface/moment | verdict |
|---|---|---|---|
| host-ui.js:148,164,169 | skip toast / degraded overlay / Retry | failures | PRECISE ("imagery" at :1844 → P2) |
| host-ui.js:206-213 | No games saved yet / past-game rows | setup | PRECISE |
| host-ui.js:368,416 | Team ${i} name / Team ${i} | inputs/fallbacks | PRECISE |
| host-ui.js:483 | Could not create game — see console | create failure toast | OFF-BRAND + JARGON (→ P1-I) |
| host-ui.js:675 | Location pool exhausted! | pool-empty toast | JARGON (→ P1-I) |
| host-ui.js:747,1515 | Round 3/5 vs Round 3 of 5 | HUD vs reveal | INCONSISTENT (→ P1-K) |
| host-ui.js:797,1514 | FINAL SHOWDOWN vs Final Showdown | HUD vs reveal | *(override: keep both — caps in the ceremony HUD slot, title case as a heading; register rule 3)* |
| host-ui.js:810 | ∞ | no-limit timer | AMBIGUOUS (→ P2) |
| host-ui.js:827 | Time's up! | timeout toast | PRECISE |
| host-ui.js:984-995,1040 | pin-drop banners (…drop your pin (2/4)) + hint | guess map | "(2/4)" → P2: "(2 of 4)" with the turn framing already in the banner |
| host-ui.js:1115 | Raise the stakes? | modifier sheet title (couch; branch currently unreachable) | *(override: keep — dead branch today; inherits the P1 pill/sheet outcome if it ever lights up)* |
| host-ui.js:1293-1294 | LOCKED IN stamp / Pass the phone — ${name} is up! | showdown handoff | PRECISE (stamp = ceremony register; the toast is the best line in the file) |
| host-ui.js:1390 | Holding — advance whenever you're ready | hold toast | INCONSISTENT (→ P2, with player-ui.js:1920) |
| host-ui.js:1456,1463 | SUPER SURE ×2 / SUPER SURE — 0 / Answer | reveal pin tooltips | "— 0" → P1-F |
| host-ui.js:1517 | — | unnamed place | AMBIGUOUS (→ P2) |
| host-ui.js:1543,1571 | 👑 prefixes | showdown list + board | round-winner semantics — consistent under P1-C |
| host-ui.js:1579 | Finish / Next round | reveal primary | PRECISE |
| host-ui.js:1750,1800 | Saved to your past games ✓ / That room is gone | end + resume | PRECISE |
| host-ui.js:904,1431,1015,1448 | OSM attribution / team-name tooltips | maps | PRECISE (legal / user content) |
| landing-ui.js:41,51,70 | Finding your room… / Room not found — check the code. / Codes are 6 letters — check the TV or the invite. | join flow | PRECISE — model error copy |
| tvlink.js:49,60 | TV typing fallback / Join on your phone: {site} — code {code} | lobby | PRECISE |
| tvlink.js:61 | Scan the host's QR to join | file:// fallback | AMBIGUOUS (→ P2: "Scan the QR on the host's phone to join") |
| team-names.js:10-111 | GEO_PUNS — 102 title-case puns (Istanbul Not Constantinople, Kenya Believe It…) | 🎲 Surprise me + suggestions | PRECISE — on-voice; 4 entries lean edgy for a family party (Iraq of Lamb:18, Uruguay-ded Missiles:36, Florida Man Squad:50, Finnish Him:66) — owner call, §7 |
| qr.js | — | — | 0 strings (see the silent-QR gap, §2.1) |

### 2.5 TV screens / fx / night / reveal (88 strings)

| file:line | string | surface/moment | verdict |
|---|---|---|---|
| fx.js:40,44 | 🔊/🔇 + Sound on — tap to mute / Sound off — tap to unmute | sound toggle (phones + TV) | *(override: keep — "tap" on a TV browser is tolerable; "click" would break phones; a verbless "Sound on/off — mute?" is P2-optional)* |
| fx.js:139-145 | WIN_LINES: take the room / run the table / The room belongs to / own the map / that's the game | winner-phone headline | AMBIGUOUS + JARGON — v1 §4's rewrite is still unshipped; "run the table" also collides with the handoff note (→ P2) |
| screen-ui.js:121-122 | The room was closed. / Room not found — check the code. | TV kickback/entry | PRECISE (":121 passive but accurate; pairs with P1-D's "Close the room") |
| screen-ui.js:379-394,541-557 | Round 3 / 5 · HUD, FINAL SHOWDOWN (— every team plays!), {name} is guessing · 2/4 | TV HUD | "Round 3 / 5" spacing → P1-K; showdown label drift *(override: keep — long form on entry, short in HUD, rule 3)* |
| screen-ui.js:682,711-713 | place-name pop / distance · caption / points | reveal | PRECISE |
| screen-ui.js:707,788 | 🎯 ACE — 0.4 km | TV stamps | *(override: keep — the stamp + medal caption teach it; "ACE" is deliberately learnable brag vocabulary, §7)* |
| screen-ui.js:728,747 | This round / Totals | board captions | "Totals" vs "Leaderboard" (screen.html:116) → P2 (pick "Leaderboard" nowhere, "Totals" everywhere) |
| screen-ui.js:782 | 👑 ${name} | closest-team crown | round-winner semantics — kept under P1-C |
| screen-ui.js:821-822,839 | answered in 23s (⚡+140) / 🔥 SUPER SURE ×2 / — 0 | reveal notes | "— 0" → P1-F |
| screen-ui.js:853-896 | count-ups, standings, podium | reveal/end | PRECISE (data renders) |
| screen-h2h.js:180 | 👑 ${winner} won — their phone runs the next game | end note | PRECISE |
| screen-h2h.js:206 | ${name} 👑 | lobby host chip | AMBIGUOUS — crown ≠ winner here (→ P1-C: "${name} · host") |
| screen-h2h.js:211-217 | lobby statuses (…scan the host's QR to join / n teams ready… / tally · status) | lobby | PRECISE (long chained line → P2 note) |
| screen-h2h.js:268-482 | exploring / LOCKED IN / locked in / 2 / 4 locked in / #2 in / on the map 📍 | panel status chips | "#2 in" → P1-B ("locked in 2nd"); "on the map 📍" → P2 ("picking a spot 📍"); case drift LOCKED/locked *(override: keep — stamp vs chip, rule 3)* |
| screen-h2h.js:556-653 | 3-2-1, place pop, boards | reveal | PRECISE |
| couchscreen.js:61-76 | TV connected ✓ / Offline — you can play on this phone alone. / No TV? No problem — the reveal shows right here. | lobby readiness | PRECISE |
| couchscreen.js:114 | 👑 ${name} wins! | end line | winner semantics — kept under P1-C |
| night.js:111-112 | ${name} ×2 / 👑 {parts} — first to 3 takes the night | night tally | *(override: keep — the "first to 3 takes the night" clause defines the ×n in the same line)* |
| night.js:119-120 | 👑 {parts} — Game 4? | crown hook | AMBIGUOUS — "Game 4?" looks tappable on the TV but is static (→ P2: "…Game 4 next?") |
| night.js:125 | 👑 CHAMPION OF THE NIGHT — ${name} | ceremony | PRECISE — ceremony register |
| revealmap.js:85,91 | SUPER SURE labels / 🎭 decoy chip | reveal map | "— 0" → P1-F; 🎭 *(override: keep — the twist card on screen names the decoy; a labeled chip would crowd the map)* |
| revealmap.js:118 | 👻 3 km | ghost chip on Daily reveals | *(override: keep — on duel runs the intro explainer taught 👻; verify it never renders on non-duel runs — flagged for implementer)* |
| revealmap.js:160,169,201 | Guess / Answer | couch pin tooltips | "Guess" vs team-name tooltips elsewhere → P2 (label it "Your guess") |
| autoadvance.js:84-88 | Final scores in 5… / Next round in 5… / Wrapping up… / Starting the next round… | countdown notes | "Wrapping up…" INCONSISTENT — breaks the "Final scores" promise made one second earlier (→ P2: "Final scores…") |

### 2.6 Consent / report / core formatters (40 strings)

| file:line | string | surface/moment | verdict |
|---|---|---|---|
| consent.js:165 | Analytics consent | dialog aria-label | INCONSISTENT — screen-reader users hear a name the visible copy never uses (→ P1-J: "Sharing anonymous play stats") |
| consent.js:176 | 🌍 Share anonymous play stats? | banner headline | PRECISE |
| consent.js:179-182 | Scores, distances and modes, plus technical diagnostics and an anonymised replay of the screens you see, so we can fix broken imagery. Never your guesses, your names, anything you type, or the street view itself. EU-hosted, change anytime. | banner body | AMBIGUOUS — **verified accurate** (replay masking really does exclude the street view) but reads self-contradictory: "replay of the screens you see" then "never the street view itself" (→ P1-J) |
| consent.js:192,196 | No thanks / Sounds good | banner buttons | first-ask: PRECISE; on the REOPENED settings view "Sounds good" sits under "Currently: on." with no on/off semantics (→ P1-J note) |
| consent.js:208 | 📷 Image not working? Report it | report entry | PRECISE |
| consent.js:224 | Read the full privacy policy on GitHub ↗ | footer link | *(override: keep — an honest, working link beats a pretty dead one; static-site constraint)* |
| consent.js:263 | Currently: on. / Currently: off. | reopened status | AMBIGUOUS — "on" has no subject (→ P1-J: "Sharing is on." / "Sharing is off.") |
| report-ui.js:51,75-80 | Report / Report an image problem / body / Send report / Cancel | consented dialog | PRECISE (Cancel vs "No thanks" drift → P1-J) |
| report-ui.js:83-90 | Send a one-time diagnostic report? / You've said no to analytics — … to debug this image problem… / Send one report / No thanks | one-time dialog | JARGON — "diagnostic report", "debug", "analytics" (the user declined "play stats", not "analytics") (→ P1-J) |
| report-ui.js:92-93 | Couldn't send the report — you may be offline or blocking analytics. No data was collected. | failure line | AMBIGUOUS — "No data was collected" after a *send* failure reads backwards (→ P1-J: "Nothing left your phone.") |
| report-ui.js:103,159-167 | aria / Thanks — sent. / ref-code line / Not sent / Close | outcomes | :161 "Mention it if you get in touch" names no channel (→ P2: "…if you get in touch on GitHub.") |
| viewer-ui.js:610 | Finding your way… | arrows-resolving pill | AMBIGUOUS — reads as geolocation (→ P2: "Loading the arrows…") |
| imagery.js:639 | GP-4K7QMV | support ref code | PRECISE |
| game.js:89,184,192 | 23s / 1m 04s / 3.2 km / 1:37 | formatters | PRECISE |
| game.js:97-106 | SUPER SURE — no pin · 0 / no pin · +0 / 250 km · SUPER SURE — 0 / SUPER SURE ×2 · 3,120 / ⚡23s +140 | TV/host reveal rows | "— 0" family → P1-F; `+0` vs `0` drift → P1-F |
| game.js:128-148 | +3,120 pts · 812 km · Nailed it · ⚡+140 fast (+ SUPER SURE variants) | phone reveal line | PRECISE ("fast" tail *(override: keep — reads naturally)*; 🔥 present on phone, absent on TV → P1-F unifies) |
| game.js:178 | +3,120 → 9,480 | board rows | *(override: keep — the two-column board context anchors it)* |
| game.js:247 | Everyone | default solo team name | PRECISE |
| chrome.js, chrome-ui.js, h2h.js, analytics.js, pool.js, firebase.js | — | — | 0 user-facing strings (verified; pool.js errors are swallowed into callers' toasts — which is why host-ui.js:483 must carry the user copy, → P1-I) |

---

## 3. P0 — the growth-loop fixes (do first, one small change-set)

### 3.1 THE fix: the duel done-screen share button

**Current:** `js/daily-ui.js:825` — `$("btnDShare").textContent = "Challenge them back";`
(overwrites the HTML default "Share your result", daily.html:136).

**OWNER DECISION (2026-08-23, Eduardo): the button is `Share your run back`** —
NOT "Send your run back". The audit's "send = directed, share = broadcast"
framing was wrong for this product: the actual social loop Natha demonstrated
is **posting the result to a group chat**, which is a share, and the share icon
is the trained muscle memory users scan for. "Send" over-indexed on the card's
existing verb at the expense of the affordance. The share icon + "Share" lead
the discoverability fix; "back" keeps the return-challenge reciprocity.

**Card line aligns to the same verb:** `share.js:137` `⚔️ Send your run back:`
→ `⚔️ Share your run back:` (one test sync at `tests/share.test.js:209`). One
verb across the whole loop.

| current (file:line) | proposed | surface/moment | why it's better | testability |
|---|---|---|---|---|
| "Challenge them back" (daily-ui.js:825) | **"Share your run back"** | Daily done screen, primary button on a completed Ghost Duel — the share/Web-Share trigger | Passes the Natha test: he was looking for "share" + the share icon to post to a group chat; the label leads with **Share**. "back" preserves the return-challenge. | Pure copy edit in DOM glue — untestable; **zero test churn** on the button itself. |
| "⚔️ Send your run back: url" (share.js:137) | **"⚔️ Share your run back: url"** | duel card line 3 — what the button copies | One verb across button + card; the card is what gets pasted into the group chat. | **TEST-COUPLED:** update `tests/share.test.js:209` in the same change. |

The argument, in order of force:

1. **It passes the Natha test.** He was looking for "share" or "send"; the
   label leads with **Send**. The user who wants to share sees the send verb;
   the user who wants revenge still sees "your run back". "Challenge them
   back" names the social meaning and hides the mechanics; field evidence
   says the mechanics must be on the button.
2. **It makes the button and the card agree, verbatim.** The card this button
   produces already says `⚔️ Send your run back: url` (`share.js:137`),
   locked by `tests/share.test.js:209`. Aligning the button to the card
   resolves the mismatch in the cheaper, safer direction — one DOM-glue line,
   no formatter change, no test change, and the tap now delivers exactly what
   the button promised.
3. **"Send" beats "share" here.** This is a person-to-person return volley
   (Web Share sheet or copied link into a chat with one friend), which is what
   "send" means in every messaging app. "Share your run back" is not idiomatic
   English, and "Share" alone suggests broadcast. Precedent inside the
   product: our best share labels already use send for directed acts
   ("Send invite link", "Send the TV link") and share for broadcast acts
   ("Share your result"). This button is a directed act.
4. **It stays on-brand.** "Your run" is warm and concrete; the ⚔️/ghost flavor
   lives one line up in the verdict block ("You beat the ghost! 🏆") — the
   moment loses zero playfulness by making its button literal.
5. **The reciprocity Natha's failure disproved is preserved anyway** — the
   *card* line the friend receives still reads as a challenge ("⚔️ Send your
   run back"), and the inbound button remains "Take the challenge". The pair
   the user actually experiences is intro→outro on their own screen, and
   "Take the challenge → Send your run back" reads fine.

Rejected alternates: **"Share your run back"** (unidiomatic; broadcast verb
for a directed act) · **"Challenge them back"** (field-falsified) ·
**"Send your challenge back"** ("challenge" as the object noun is vaguer than
"run", which the intro explainer just defined: "A friend sent you their run").

Note on `share.js:138` "⚔️ Beat my ghost: url": correctly **kept**. It looks
like a third verb, but the speaker differs — the button talks to the sender
("send this"), the card line talks to the recipient ("beat this"). One voice
per speaker, not one verb for two speakers.

### 3.2 The confirmation toast must name what was copied

**Current:** `js/share-ui.js:28` — `toast("Result copied — paste it anywhere 📋")`
fires for every clipboard-fallback share, including duel and challenge cards.
The function already receives `extra.challenge` (`share-ui.js:14`,
`daily-ui.js:1010`) and ignores it for copy.

| current (file:line) | proposed | surface/moment | why | testability |
|---|---|---|---|---|
| "Result copied — paste it anywhere 📋" (share-ui.js:28) | challenge/duel shares: **"Challenge link copied — share it with your friend 📋"**; plain shares: keep current | the last step of the growth loop, right after the P0-1 tap | The user just tapped "Share your run back"; being told a "result" was copied is the third noun in one tap. The toast should confirm the promise the button made and say the next act (share it) — same verb as the button. | One conditional on the already-passed `extra` — a two-line change in DOM glue, but it is behavior-adjacent: **add a case to a new pure helper if reviewers prefer, else state "copy edit + existing prop read" in the summary.** No analytics change — `result_shared` already carries `challenge` + `method`. |

### 3.3 The shared card's tie line speaks as the wrong person

**Current:** `js/share.js:146` — `"You and the ghost tied 🤝"`, while the
sibling outcomes speak in first person: `"I beat the ghost by 1,840 🏆"` /
`"The ghost got me by 620 👻"` (share.js:144-145).

| current (file:line) | proposed | surface/moment | why | testability |
|---|---|---|---|---|
| "You and the ghost tied 🤝" (share.js:146) | **"The ghost and I tied 🤝"** | line 1 of the shared duel card — read by the recipient in chat | The card is the sender speaking. On a tie it suddenly addresses the reader ("You…"), who will misread it as *their* result — a wrong-person bug on the loop's artifact, not a tone issue. | **TEST-COUPLED:** `tests/share.test.js:219` asserts `/You and the ghost tied/` — update the assertion in the same change. Pure formatter, so this is the good kind of coupled: the test locks the fix. |

---

## 4. P1 — one vocabulary for one concept (the consistency sweep)

Each cluster = one decision applied everywhere. All are copy edits unless
marked test-coupled.

**A. The share-verb family — the social verb is "share".**
Rule (owner, 2026-08-23): for a casual audience, **"share" is the familiar
social verb** — the share icon + "share" is the trained muscle memory for
posting to a group chat. Use "share" for every social/outbound act a user
performs. Drop the old "send = directed / share = broadcast" taxonomy; it
over-indexed on an internal distinction a casual user never learns.
- host.html:229 "Share" → **"Share the result"**; player.html:206 "Share" →
  **"Share your result"** (matches daily.html:136). Pure HTML copy.
- Align the invite/TV-link labels to the same verb: player.html:96 "Send
  invite link" → **"Share the invite link"**; host.html:150 / player.html:106
  "Send the TV link" → **"Share the TV link"**. (These are the same social act
  as the done-screen share — one verb across the product.)
- Keep "Share your result" (daily.html:136) as the model.

**B. The lock-in verb never changes mid-round.**
- hints.js:136-138 armed label "Lock in" → **"Lock it in"**; hints.js:156
  armed main → **"🔥 Lock it in ×2"**, aria → "🔥 Lock it in ×2 — or 0".
  **TEST-COUPLED:** hints.test.js:186-188,196 assert the armed strings
  verbatim (§6.1 comment says "verbatim" — sync the spec reference too).
- Submission-order strings say the verb: player-ui.js:1611 "✓ in (#2)" →
  **"✓ locked in 2nd"**; :1621 "#2 to lock in" → **"You locked in 2nd"**;
  :1061 "2/4 in" → **"2/4 locked in"**; screen-h2h.js:425 "#2 in" →
  **"locked in 2nd"**. player.html:158 "Who's in" → **"Who's locked in"**.
- Keep: "LOCKED IN" stamps (ceremony), "N / M locked in" (screen-h2h.js:378),
  "${Team} locked in!" (player-ui.js:692), "Time! Your pin was locked in."

**C. The crown means winning — nothing else.**
Rule: 👑 marks a win (round's closest, game winner, night crowns, champion).
It stops marking the *host role*:
- player-ui.js:750 host suffix " 👑" → **" · host"**; screen-h2h.js:206
  "${name} 👑" → **"${name} · host"**.
- Everything else keeps its crown (host-ui.js:1543,1571; player-ui.js:1840;
  screen-ui.js:782; screen-h2h.js:180,615; couchscreen.js:114; night.js).

**D. Starting and leaving a party — one name per act.**
- Create-the-room CTA: host.html:130 "New game" → **"Start the party"**;
  player.html:279 "Open the room" → **"Start the party"** (echoes the landing
  "Start a party"; the room/lobby is an implementation noun).
- Begin-play CTA: host.html:156 "Start round" and player.html:115
  "Start game" → **"Start the game"** (implementer: verify the couch lobby is
  only entered once per game before renaming its instance).
- Host's destructive exit: host.html:155 + player-ui.js:761 "Abandon" →
  **"Close the room"** — says what happens, and the other players' toast
  already says "The room was closed." (player-ui.js:565, screen-ui.js:121).
  The pairing is free precision.
- player.html:199 "Leave the game" → **"Leave"** (matches :114).
- host.html:230 "New game" (game-over) → **"Play again"** (a different act
  from setup's create-room; naming them apart removes the reuse).

**E. "Make guess" opens the map — say so.**
- daily.html:81, host.html:169, player.html:130 "Make guess" →
  **"Guess on the map"** — names the action *and* reveals that a map opens;
  the commit verb stays "Lock it in", one step later, unambiguous.
- hints.js:51,93,97 "Then Make Guess." → **"Then tap Guess on the map."**
  (also fixes the Make Guess/Make guess casing drift). Check
  hints.test.js/html-contract.test.js for locks; none found in this audit's
  grep, so expected pure copy.

**F. SUPER SURE settles in one notation, and "armed/burned" stay internal.**
- The zero outcome: "SUPER SURE — 0" → **"SUPER SURE ×0"** everywhere
  (supersure.js:94; game.js:97,100,131,145). "×2/×0" is one visual system:
  the multiplier won or the multiplier zeroed you. Distinguish the no-pin
  case: game.js:97 "SUPER SURE — no pin · 0" → **"no pin · SUPER SURE ×0"**.
  **TEST-COUPLED:** supersure.test.js:172-176; game.test.js:288,295,299,413+.
- modifier.js:161 "Arm the bet" → **"Place the bet 🔥"**; :159 "Once armed,
  the bet is on — no backing out this round." → **"Once placed, the bet is
  on — no backing out this round."**
- player-ui.js:1560,1564 "…SUPER SURE burned." → **"…your SUPER SURE bet is
  gone."**
- Unify the 🔥 prefix: phone lines have it (game.js:143-145), TV rows don't
  (game.js:100-103) — add 🔥 to the TV rows or drop it from phones; recommend
  **add to TV** (the flame is the bet's brand). TEST-COUPLED as above.

**G. Ghost vocabulary meets its audience.**
- daily-ui.js:282 → **"This challenge was built on an older Daily — playing
  today's five solo instead."** (drops "the ghost" on the one path where it
  was never explained).
- daily-ui.js:1012 → **"This run has no saved pins — sharing your score card
  without the challenge link."**
- Keep everywhere the explainer has run: "ghost pin", "You beat the ghost!",
  "Beat my ghost".

**H. One name for each mode, and the TV feature.**
- Mode names are the chooser's: **"Everyone on their own phone"**, **"One
  phone + the TV"**. Kill user-facing "head-to-head": player-ui.js:787 invite
  text → **"Join my GeoParty — room {CODE}"**; screen.html:93 H1 tag
  "head-to-head" → **"everyone on their own phone"**; player-ui.js:499 →
  **"That code is for a one-phone party — nothing to join from your phone."**
- TV feature name: **"Add a TV"** (the disclosure), instruction verb **"put
  GeoParty on the TV"**. index.html:96 "Add a TV. Optional." → **"Add a TV —
  optional"** (matches player.html:102); host.html:146 "📺 Put it on a TV" →
  **"📺 Add a TV — optional"**; align host.html:148 to player.html:104's
  device wording ("any phone or tablet, then cast or AirPlay it to the TV").
  howto.html:65 keeps "Put it on the TV" (instruction register — correct).

**I. Errors never dead-end a party guest.**
- host-ui.js:483 + player-ui.js:481 "Could not create game — see console" →
  **"Couldn't start the party — check your connection and try again."**;
  player-ui.js:2170 aligns: **"Couldn't set up the next game — try again."**
- host-ui.js:675 + player-ui.js:852 "Location pool exhausted!" →
  **"We're out of new places — final scores!"** (true: the game
  force-finishes; the copy now says what happens next).
- player-ui.js:506 "That game already started." → **"That game already
  started — ask for a new code when the next one begins."**

**J. Consent and report copy: same words the banner taught.**
All wording-only; the flow, buttons' behavior, storage and PRIVACY.md promise
are untouched (CLAUDE.md consent rules; PRIVACY.md should be checked for
matching phrasing in the same review).
- consent.js:179-182 body, replay clause → **"…plus technical diagnostics and
  an anonymised replay of the menus and score screens (the street view and
  maps are blanked out), so we can fix broken imagery. Never your guesses,
  your names, or anything you type. EU-hosted, change anytime."** — removes
  the apparent self-contradiction while keeping the promise identical.
- consent.js:165 aria-label "Analytics consent" → **"Share anonymous play
  stats?"** (say to screen readers what the banner says to everyone).
- consent.js:263 " Currently: on./off." → **" Sharing is on." / " Sharing is
  off."**
- report-ui.js:83 "Send a one-time diagnostic report?" → **"Send one report
  about this image?"**; :84-88 "You've said no to analytics" → **"You said no
  to sharing play stats"**; "To debug this image problem" → **"To fix this
  image problem"**; :92-93 failure tail "No data was collected." → **"Nothing
  left your phone."**; :80 "Cancel" → **"No thanks"** (match :90).

**K. Round labels: compact form in HUDs, spoken form in headings.**
- Rule: corner HUDs say **"Round 3/5"** (host-ui.js:747, player-ui.js:1022,
  daily-ui.js:368, screen-* — normalize screen-ui.js:379's spaced "3 / 5" to
  "3/5"); headings say **"Round 3 of 5"** (host-ui.js:1515,
  player-ui.js:1802, daily-ui.js:531); recap.js:105 "Round 2" →
  **"Round 2 of 5"**. Two registers, each used consistently, documented here.

**L. Twist tags match their cards.**
- twist.js HUD tags get their spaces and full names: "⚡BLITZ" → **"⚡ BLITZ"**,
  "🧊FROZEN" → **"🧊 FROZEN"**, "🔒BLIND" → **"🔒 BLIND DUEL"**,
  "🌍LONGHAUL" → **"🌍 LONG HAUL"**. Reveal tags stop being bare emoji:
  "🧊" → **"🧊 ×1"**-style is wrong — use the card noun: **"🧊 FROZEN"**,
  **"🔒 BLIND DUEL"**, **"🌍 LONG HAUL"**; keep "×1.5 ⚡" but as
  **"⚡ ×1.5"** to match the BLITZ brand order.
- twist.js:24 "No moving — read the frame" → **"No moving — read the
  scene"**; :26 "Gentler curve — go bold" → **"Far-off pins score kinder —
  go bold"**.
- "BLIND DUEL" is the last user-facing "duel" outside the Daily; it names a
  *different* mechanic than Ghost Duel. Either rename the twist card to
  **"🔒 BLIND ROUND"** (recommended — frees "duel" entirely) or accept the
  collision knowingly. **TEST-COUPLED:** twist.test.js:200,211 assert card
  strings; :183 is structural (any non-empty hud/revealTag passes).

---

## 5. P2 — tone, polish, capitalization (batch when touching these files)

| # | current (file:line) | proposed | why |
|---|---|---|---|
| 1 | WIN_LINES (fx.js:139-145) | adopt v1 §4's rewrite: keep "own the map", "The room belongs to", "that's the game" slots; replace "take the room" → "locked it down", "run the table" → "read the map" | still unshipped; kills the "run the table" double-meaning with player-ui.js:2063. fx.test.js:342-344 is structural — survives. |
| 2 | "Daily #N done!" (daily-ui.js:767) | "Daily #N — you did it! 🎉" (fresh only) | the signature solo win deserves a celebration (v1 §4). |
| 3 | hard-mode `*` (daily-ui.js:766,767,1050,1085; share.js:128,134) | keep the star, add one gloss where it's born: intro day badge "#142*" gains a title/aria "hard mode"; done title keeps ⚡ next to the star or swaps `*` → `⚡` everywhere | the only unglossed symbol in the product; ⚡ is already taught. |
| 4 | "by 440" (daily-ui.js:862; share.js:144-145) | "by 440 pts" | margins get a unit. share.test.js may match leads — sync if locked. |
| 5 | "👻 takes the round" (daily-ui.js:554) | "the ghost takes the round" | emoji as sentence subject; screen readers get nothing. |
| 6 | ∞ (host-ui.js:810; player-ui.js:1685) | "No timer" | unlabeled math symbol in the clock slot. |
| 7 | "—" for unnamed reveal places (host-ui.js:1517; player-ui.js:1803; daily fallbacks) | "Somewhere mysterious" | an em dash where the answer belongs reads as a bug; this reads as the game. |
| 8 | "Give up" (player.html:129,146) | "Give up this round" | scopes the damage; stays honest. |
| 9 | "✋ Hold" (host.html:203; player.html:179) + "Holding — advance whenever you're ready" (host-ui.js:1390; player-ui.js:1920) | keep "✋ Hold"; toast → "Holding — tap Next round whenever you're ready." | the toast names the button the user will actually tap. |
| 10 | "Wrapping up…" (autoadvance.js:88) | "Final scores…" | keeps the promise "Final scores in 5…" just made. autoadvance.test.js may lock — sync. |
| 11 | "Final standings" (host.html:213) | "Game over!" | one name for the end screen (player.html:189, screen.html:130). |
| 12 | "Leaderboard" (screen.html:116) | "Totals" | one name for the running score list (screen-ui.js:747). |
| 13 | "GeoParty — Screen" (screen.html:6) | "GeoParty — TV" | the product says TV everywhere else. |
| 14 | "KWPFRT" (screen.html:38) | "CODE" | placeholder that looks like a real code; every other field says CODE. |
| 15 | "reconnecting…" (host.html:31; player.html:32; screen.html:30) | "Reconnecting — hang tight…" | capitalize + reassure; the game does survive. |
| 16 | © line ×4 (index.html:109 etc.) | "© 2026 · A game by Eduardo Ariño de la Rubia" | name once. |
| 17 | "← GeoParty" (daily.html:68,162) | "← Home" | destination, not brand. |
| 18 | "Add a TV" footer link (index.html:103) | "TV screen" or route text "Put GeoParty on a TV" | the page it opens asks for a code. |
| 19 | caps/punctuation batch | "daily challenge" tag (daily.html:42) → "Daily Challenge"; "Play Hard Mode ⚡" (daily-ui.js:1063) → "Play hard mode ⚡"; og:title casing (howto:17, host:18); "Guessing…"/"waiting for a pin…" (screen.html:66-67) same case; straight→curly apostrophes (daily-ui.js:296, player-ui.js copies); "Give your team a name first" one literal with period; duel headline period drift (daily-ui.js:856-857); "ace"→"ACE" (daily-ui.js:817); 🔥 streak format (daily-ui.js:806 vs 1075 vs share.js:132 — pick "🔥 5 — day streak" on screens, "🔥5" on cards) | one sweep, zero risk. |
| 20 | "no guess" (recap.js:110) | "no pin" | matches every other forfeit string. recap.test.js may lock — sync. |
| 21 | "Imagery…" (player-ui.js:184,1014; host-ui.js:1844) | "street view" ("Couldn't load the street view.", "Street view didn't load — guess from the map.") | the pipeline's word; players see a street. (Note: consent copy J already avoids over-promising around "street view" — keep the two consistent.) |
| 22 | "No TV attached" (hints.js:74) | "No TV connected" | matches couchscreen.js:61 "TV connected ✓". hints strings may be test-locked — check. |
| 23 | "Finding your way…" (viewer-ui.js:610) | "Loading the arrows…" | it's the arrows, not geolocation. |
| 24 | "on the map 📍" (screen-h2h.js:447) | "picking a spot 📍" | says the act, not the location. |
| 25 | "Scan the host's QR to join" (tvlink.js:61; screen-h2h.js:211) | "Scan the QR on the host's phone to join" | which screen has the QR. tvlink.test.js locks phoneJoinLine — sync if matched. |
| 26 | "(2/4)" (host-ui.js:993) | "(2 of 4)" | showdown pass-around count reads as a score. |
| 27 | "…thinking" vs "exploring" chips | keep both (they're different states) — but capitalize consistently with sibling chips | polish only. |
| 28 | "Room" (player.html:91) | "Room code" | matches host.html:141; says what the big code is. |
| 29 | "Auto-lock pins" (player.html:263) | "Lock in dropped pins" | de-jargons the timeout setting; pairs with "Wait for players". |
| 30 | "ready" roster tag (player-ui.js:753) | drop it (or bind it to a real state) | verified unconditional — it's noise wearing a status costume. |
| 31 | "This challenge needs a newer GeoParty…" (daily-ui.js:1131) | "…— reload this page, then open the link again." | gives the action that actually gets a newer build. |
| 32 | "Your reference code is GP-XXXX. Mention it if you get in touch." (report-ui.js:161) | "…if you get in touch on GitHub." | names the only channel that exists. |
| 33 | "Game 4?" (night.js:119-120) | "Game 4 next?" | stops reading as a button. |
| 34 | howto.html:55 alt | "The scoring rules card" | matches the universal step it illustrates. |
| 35 | og:description duplication check + missing meta descriptions (host/player/screen.html) | add plain one-liners | store-window completeness; pure additive HTML. |

---

## 6. Testability + instrumentation (per repo rules)

**String-locking tests found (sync in the same change as the copy):**

| change | test lock |
|---|---|
| P0-3 tie person-flip (share.js:146) | tests/share.test.js:219 `/You and the ghost tied/` |
| P1-B armed lock labels (hints.js:156) | tests/hints.test.js:183-196 ("🔥 Lock in ×2 — or 0" verbatim, incl. the §6.1 comment) |
| P1-B idle labels (hints.js:136-138) | tests/hints.test.js:163,166,171,172,200 assert "Lock it in" — **unchanged**, they already lock the keep |
| P1-F "SUPER SURE ×0" | tests/supersure.test.js:172-176; tests/game.test.js:281-299,413+ |
| P1-L twist cards/tags | tests/twist.test.js:200,211 (cards); :183 structural (tags free) |
| P2-1 WIN_LINES | tests/fx.test.js:328-344 structural — survives rewording; keep the position-2/4 special-case slots |
| P2-4 margin units | share.test.js verdict-lead matchers — check and sync |
| P2-10 autoadvance / P2-20 recap / P2-22 hints / P2-25 tvlink | check autoadvance.test.js / recap.test.js / hints.test.js / tvlink.test.js for literal matches; sync any hits |
| P0-1, P1-A/C/D/E/G/H/I/J/K and most of P2 | **pure copy edits** in HTML or DOM glue — untestable by design; say so explicitly in the change summary. html-contract.test.js locks ids/masks, not copy — HTML label edits are safe. |

**Instrumentation: no new PostHog events are needed, and none should be
added.** Copy changes ask no product question the existing schema doesn't
answer:

- Share-button relabel (P0-1/P0-2): conversion is already measured —
  `result_shared` carries `mode`, `method`, `challenge`;
  `ghost_duel_completed` marks the funnel's top. Before/after relabel
  comparison is a PostHog query on existing events, not a schema change.
  *Optional* idea, flagged as such: a `label_variant` property on
  `result_shared` if the owner ever wants an A/B; **not recommended now** —
  ship the fix, read the trend.
- Everything else is vocabulary; decision points are unchanged.

**Consent-copy caution (P1-J):** wording changes only; do not touch flow,
buttons' behavior, storage keys, `POSTHOG_INIT_OPTIONS`, or the §10.4
exception's mechanics. Keep PRIVACY.md's phrasing in agreement in the same
review. Owner sign-off on the consent body rewrite before shipping.

---

## 7. What NOT to touch (anti-churn)

- **"Round", "hard mode", "ACE!", "Nailed it"/"Right region"/"Right
  continent" medal copy** — strong, felt-tier, partially test-locked. Keep.
  ("ACE" on the TV stamp is deliberately learnable brag vocabulary — the
  medal caption teaches it; do not gloss it into blandness.)
- **Party/join error copy** (player-ui.js:492-530 core, landing-ui.js:51,70)
  — the model family. Keep (except the two dead-ends fixed in P1-I and the
  :506 next-step in P2).
- **Ceremony caps** — "LOCKED IN", "FINAL SHOWDOWN", "ALL TEAMS LOCKED IN",
  "⚔️ CHALLENGE —", "👑 CHAMPION OF THE NIGHT". Register rule 3; keep.
- **Marketing poetry** — "Phones in, pins down.", "rival pins in plain
  sight", "geoguessing" in search copy. Register rule 4; keep.
- **"Take the challenge", the duel intro explainer (daily-ui.js:1053), "⚔️
  Beat my ghost", "Beat me:"** — correct speaker, correct verb. Keep.
- **Settings vocabulary** — Casual/World tour/Expert, Twists
  Off/Occasional/Chaos, 🎲 Surprise me. Playful and context-carried; a
  descriptions row would be a UI change, out of scope.
- **Code identifiers and event names** — `duelVerdict`, `isExhibition`,
  `poolDiagId`, `arm`/`burned` enums, `h2h` module names, every
  `EVENT_SCHEMA` name: never rename; they just stop being *spoken* (P1-F/G/H
  do exactly that).
- **GEO_PUNS** (team-names.js) — owner's content surface; the 4 edgy entries
  (lines 18, 36, 50, 66) are flagged for an owner decision, not edited.
- **OSM attribution, ref-code format GP-XXXX, formatters** (km/times/counts)
  — legal/functional. Keep.

---

## 8. What the prior pass (v1) missed — and what it got wrong

v1 (`docs/content-strategy-plan.md`) audited the Daily/duel path well and
shipped a real improvement, but it sampled the rest of the product. This pass
read everything. New findings v1 never surfaced:

1. **The P0 itself:** v1's chosen label caused the field failure this audit
   fixes; its own runner-up ("Send your run back") is the correct call. Meta
   lesson recorded in §1: *function-naming beats brand symmetry on controls.*
2. **The share path's four-verb chain** (button → card → toast → alt-card),
   including the toast `share-ui.js:28` calling a challenge link a "result".
3. **The person-flip bug** on the shared card's tie line (share.js:146) —
   v1 table row 78 looked straight at these lines and missed it.
4. **"Make guess"** — the most-tapped mislabeled control in the product
   (3 pages), absent from v1.
5. **The 👑 overload** — five meanings across seven surfaces.
6. **The whole settings/lobby/exit family** — "Abandon", "Open the room",
   four names for create-a-game, "Start round" vs "Start game"; v1 declared
   "no P0/P1 in party modes."
7. **SUPER SURE's "— 0"**, "Arm the bet", "burned" leaking, and the phone/TV
   🔥 drift — the modifier surface was uninventoried.
8. **Twist tag drift** (card vs HUD vs reveal) and "read the frame"/"gentler
   curve" jargon.
9. **Consent + report cluster** — the apparently-self-contradicting replay
   clause, the aria-label mismatch, "Currently: on." with no subject,
   "diagnostic report"/"debug"/"analytics" vocabulary; v1 said "no change,
   already clear + kind."
10. **The dead-end errors** — "see console" ×2, "Location pool exhausted!" ×2.
11. **The head-to-head leak** to the TV H1, the invite text, and a join error.
12. **The armed-state lock-label drift** ("Lock it in" → "Lock in" the moment
    a bet is armed) — v1 knew only the couch/h2h "Confirm guess" split (since
    fixed, commit 29803e4; hints.test.js now locks "Lock it in" everywhere).
13. **Whole-file misses:** screen-ui.js, screen-h2h.js, couchscreen.js,
    night.js, revealmap.js, autoadvance.js, viewer-ui.js, consent.js,
    tvlink.js, team-names.js, and all six HTML pages' full text (v1 sampled
    landing + daily).
14. **Structural gaps:** no meta descriptions on 3 pages; the QR that
    vanishes silently when a link overflows (qr.js:166); no
    countdown-to-next-Daily anywhere; "ready" as an unconditional roster tag.
15. **Corrections to v1's record:** v1 cited the done headline at
    daily-ui.js:821/:825 and "hints.test.js:178,191" — the shipped reality is
    :856-857 and hints.test.js:163-200; v1's claim that fx WIN_LINES "does
    not lock literal strings" was re-verified and stands.

---

## 9. Suggested rollout order

1. **P0 change-set** (3 strings + 1 test sync + 1 conditional) — one small
   PR; measure `result_shared` rate on duel runs before/after in PostHog.
2. **P1-A/B/C/D/E** — the visible-surface consistency sweep (HTML + glue +
   hints tests).
3. **P1-F/L** — the modifier/twist sweep (heaviest test sync: supersure,
   game, twist).
4. **P1-G/H/I/K** — vocabulary + errors.
5. **P1-J** — consent/report wording, with owner sign-off and PRIVACY.md
   check.
6. **P2** — batch opportunistically per file.

*Every item in this plan is a copy decision. None requires new analytics,
none touches game logic, and the ~10 test-coupled strings are enumerated in
§6 so each change ships green.*
