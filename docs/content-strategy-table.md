# GeoParty — Complete User-String Content Strategy Table

Every user-visible string, current → proposed, after the content-strategy fix.
Governing principle (owner, 2026-08-23): the cleanest word that gives the best
affordance for our audience — casual users who play a few minutes a week. The
most conventional, familiar word wins. "Share" is the social verb (share icon +
"share" = trained muscle memory for posting to a group chat). Consistency
serves affordance; it never overrides it.

Legend: **keep** = no change (already precise/on-brand). All changes are pure
copy unless marked **[test]** (a test locks the string and must be synced in
the same change).

---

## 1. Landing (index.html)

| Current | Proposed |
|---|---|
| GeoParty (tab title) | keep |
| Jackbox-style geoguessing party game. Guess where in the world you are — phones in… (meta) | keep |
| GeoParty (og:site_name) | keep |
| GeoParty — the geoguessing party game (og:title) | keep |
| Guess where in the world you are. Phones in, pins down. Free in the browser — no app… (og:desc) | keep |
| GeoParty (hero H1) | keep |
| Guess where in the world you are. Phones in, pins down. (tagline) | keep |
| Start a party (primary CTA) | keep |
| Have a code? Join (secondary CTA) | keep |
| Everyone on their own phone (chooser 1) | keep |
| Same spot, same clock — rival pins in plain sight. (subline) | keep |
| One phone + the TV (chooser 2) | keep |
| One phone drives, everyone shouts directions. (subline) | keep |
| ← Back | keep |
| CODE (join placeholder) | keep |
| Join | keep |
| Daily Challenge — five mystery places, the same for everyone today. No party needed. | keep (title case is correct; daily.html tag fixed below) |
| How it works (aria) | keep |
| One phone starts a party (step 1) | keep |
| Friends join — QR or link (step 2) | keep |
| Add a TV. Optional. (step 3) | **Add a TV — optional** |
| How to play (footer) | keep |
| Add a TV (footer link) | **TV screen** |
| Privacy (footer) | keep |
| GitHub (footer) | keep |
| © 2026 Eduardo Ariño de la Rubia · A game by Eduardo Ariño de la Rubia | **© 2026 · A game by Eduardo Ariño de la Rubia** |

## 2. Daily Challenge (daily.html + daily-ui.js)

| Current | Proposed |
|---|---|
| GeoParty — Daily Challenge (tab) | keep |
| Five mystery places, the same for everyone today. One run per day… (meta) | keep |
| GeoParty · daily challenge (intro H1 + tag) | **GeoParty · Daily Challenge** |
| Today · #— (stat card + placeholder) | **Today · #—** (placeholder class; keep) |
| Five mystery places — the same five for everyone today. / One run per day. Closer + faster = more points. | keep |
| ⚡ Hard mode — no moving, 30 seconds / Try hard mode | keep |
| ← GeoParty (back link) | **← Home** |
| Play today's Daily (intro CTA) | keep |
| Round 1/5 · 1:00 (HUD skeleton) | keep |
| Make guess (round primary — opens the map) | **Guess on the map** |
| Tap the map to drop your pin | keep |
| Back to street | keep |
| Lock it in | keep |
| Round 1 · — · — · Total so far · — (reveal skeletons) | keep (placeholder class) |
| Next round | keep |
| Daily done! (done headline skeleton) | keep (JS overwrites) |
| Your score · — | keep |
| New personal best! 🏆 | keep |
| Share your result (done share, non-duel default) | keep (model) |
| Your five places (recap title) | keep |
| Fresh five tomorrow — or start a party with friends. | keep |
| How to play · © line | **© 2026 · A game by Eduardo Ariño de la Rubia** |
| This challenge was built on an older Daily — playing without the ghost. (boot toast) | **This challenge was built on an older Daily — playing today's five solo instead.** |
| Couldn't load today's places — try again. | keep (apostrophe normalized) |
| Round ${n}/5 ⚡ (HUD) | keep |
| Lock it in / Lock in (armed-state drift) | **Lock it in** (both states) **[test]** |
| Time! Your pin was locked in. / Time! No pin — no points this round. | keep |
| Round ${n} of 5 (reveal heading) | keep (spoken form) |
| You +12,340 · 👻 +11,500 — you take the round / 👻 takes the round / you and the ghost tied | **…the ghost takes the round** (emoji not a subject) |
| See my score / Next round | keep |
| This challenge was built on an older Daily — showing your result. | keep |
| You played Daily #142* ✓ / Daily #142* done! | **Daily #142 — you did it! 🎉** (fresh); gloss the `*` as hard mode |
| Missed a day — your streak survived. 🔥 5 / 🔥 5 — day streak | keep (format normalized) |
| 🎯 3rd ace this month | **🎯 3rd ACE this month** |
| **Challenge them back** (duel done primary — the share trigger) | **Share your run back** |
| That was another day's five… / One run per day keeps scores honest… | keep |
| You beat the ghost! 🏆 / The ghost got you 👻 / You and the ghost tied. | keep (period normalized) |
| 12,340 apiece / 12,340 to 11,900 — by 440 | **…by 440 pts** |
| This run has no saved pins — sharing a plain card, no ghost challenge. | **This run has no saved pins — sharing your score card without the challenge link.** |
| ⚔️ CHALLENGE — Daily #142* ⚡ (intro eyebrow) | keep (gloss the `*`) |
| A friend sent you their run. Their ghost pin appears at every reveal — same five places, same rules. | keep (model string) |
| Take the challenge | keep |
| Play Hard Mode ⚡ / Play Today's Daily | **Play hard mode ⚡** / keep |
| This challenge needs a newer GeoParty… (toast) | **…— reload this page, then open the link again.** |
| Loading your challenge… | keep |

## 3. Ghost Duel share (share.js, share-ui.js)

| Current | Proposed |
|---|---|
| We were 3.2 km from Kyoto… beat us: url (party card) | keep |
| 🎯 Your ACE pin — 0.4 km / Your closest pin — … | keep |
| Nailed it / Right region / Right continent / Lost (medal captions) | keep |
| GeoParty Daily #37 — I beat the ghost by 1,840 🏆 (card lead) | keep (add "pts" to margin) |
| **⚔️ Send your run back: url** (duel card line 3) | **⚔️ Share your run back: url** **[test]** |
| ⚔️ Beat my ghost: url (fresh-run card) | keep |
| Beat me: url (plain card) | keep |
| I beat the ghost by 1,840 🏆 / The ghost got me by 620 👻 | keep (add "pts" to margin) |
| **You and the ghost tied 🤝** (card tie line) | **The ghost and I tied 🤝** **[test]** |
| **Result copied — paste it anywhere 📋** (toast) | **Challenge link copied — share it with your friend 📋** (duel); keep for plain |
| Round 2 · Kyoto, Japan · 3 km · 1,240 pts / no guess (recap) | **Round 2 of 5**; **no pin** |

## 4. Player + modifiers (player.html, player-ui.js, hints, modifier, supersure, twist)

| Current | Proposed |
|---|---|
| reconnecting… | **Reconnecting — hang tight…** |
| Your team name / The Atlas Cats | keep |
| 🎲 Surprise me | keep |
| Have a code? / CODE / Join | keep |
| Start a new game → | **Start the party** |
| Room · ······ | **Room code** |
| Send invite link | **Share the invite link** |
| 📺 Add a TV — optional / Scan with any phone or tablet, then cast or AirPlay it… | keep |
| Send the TV link | **Share the TV link** |
| Teams | keep |
| Leave (JS swaps to Abandon for host) | **Leave** (host: **Close the room**) |
| Start game | **Start the game** |
| Give up | **Give up this round** |
| Make guess | **Guess on the map** |
| map hint / Back to street / Lock it in | keep |
| LOCKED IN | keep (ceremony) |
| Eyes on the TV 📺 | keep |
| Who's in | **Who's locked in** |
| ✋ Hold | keep |
| Game over! | keep (canonical) |
| Leave the game | **Leave** |
| Share | **Share your result** |
| Set up the next game | keep |
| Auto-lock pins | **Lock in dropped pins** |
| Open the room | **Start the party** |
| Some images wouldn't load — we skipped ahead. | keep |
| Couldn't load the imagery… / Retry | **Couldn't load the street view.** / keep |
| 👑 Your game now / Start a new game / Same teams, fresh scores… | keep |
| Give your team a name first(.) | keep (one literal, punctuation normalized) |
| Could not create game — see console | **Couldn't start the party — check your connection and try again.** |
| That's not a room code. / Room not found — check the code. / That game already started. / Room is full (4 teams max). / Could not join — try again. | keep (model family); "That game already started." → **…— ask for a new code when the next one begins.** |
| That room is a couch game — this page is head-to-head. | **That code is for a one-phone party — nothing to join from your phone.** |
| The room was closed. / Room not found. | keep |
| Couldn't follow into the next game. | **…ask the winner for the new code.** |
| You're no longer in this room. | keep (add next step) |
| ${Team} locked in! | keep |
| " (you)" / " 👑" (lobby roster) | **" (you)"** / **" · host"** |
| ready (roster tag) | **drop** (unconditional noise) |
| Abandon / Leave | **Close the room** / **Leave** |
| Start solo, or wait for rivals… / n teams in… / Waiting for {host}… / · TV ✓ | keep |
| Join my GeoParty head-to-head — room CODE / Invite link copied / Send this link: url | **Join my GeoParty — room {CODE}** / **Invite link copied** / keep |
| Location pool exhausted! | **We're out of new places — final scores!** |
| Could not start the round | **Couldn't start the round — try again.** |
| Imagery didn't load — guess from the map. | **Street view didn't load — guess from the map.** |
| Round 3/5 vs Round 3 of 5 | keep (HUD compact / heading spoken) |
| 2/4 in (locked HUD chip) | **2/4 locked in** |
| Drop your pin / Raise the stakes? | keep |
| Your next tap plants the decoy — then tap again for your real pin. | keep |
| You gave up — SUPER SURE burned. / Time! No pin — SUPER SURE burned. | **…your SUPER SURE bet is gone.** |
| Time! Your pin was locked in. | keep |
| ✓ in (#2) / #2 to lock in (locked screen) | **✓ locked in 2nd** / **You locked in 2nd** |
| Eyes on the TV 📺 / Results land right here when everyone's in / Everyone's in! / Reveal in 3… | keep |
| ∞ (no-limit timer) | **No timer** |
| — (unnamed place at reveal) | **Somewhere mysterious** |
| ACE stamp / 👑 board prefix / (you) | keep |
| Finish game / Next round / {host} wraps up… / …starts the next round… | keep |
| Holding — advance whenever you're ready | **Holding — tap Next round whenever you're ready.** |
| 🏆 You won! / winLine / Game over! / Winner runs the table… / {winner} won — their phone is the host now… | keep (WIN_LINES rewritten below) |
| Could not create the next game / That room is gone | **Couldn't set up the next game — try again.** / keep |
| Where are you? / Look around 👀… / How points work / FINAL SHOWDOWN | keep |
| Then Make Guess. (hint) | **Then tap Guess on the map.** |
| This phone is the big screen / No TV attached — the reveal lands right here. | keep / **No TV connected — the reveal lands right here.** |
| Closer = more points. Faster = bonus. / Rivals see your pin move — bluff away. | keep |
| Lock it in / Lock in (×3 modes) | **Lock it in** (all) **[test]** |
| 🔥 Lock in ×2 / or 0 (armed) | **🔥 Lock it in ×2** / **or 0** **[test]** |
| ≈ +3,240 (estimate sublabel) | keep |
| Got it | keep |
| Raise the stakes? / 🔥 Double or nothing · 🎭 Decoy pin | keep |
| Are you SUPER SURE? Tap for double or nothing 🔥 / Feeling sneaky? Tap to plant a decoy pin 🎭 | keep |
| SUPER SURE / Double or nothing, once per game. Closest pin this round: your points ×2… | keep |
| Once armed, the bet is on — no backing out this round. | **Once placed, the bet is on — no backing out this round.** |
| Arm the bet | **Place the bet 🔥** |
| Not now | keep |
| 🎭 Decoy / Plant a fake pin for rivals to see. Your real pin goes dark. / Once per game. / Plant the decoy | **…rivals stop seeing your real pin.** |
| SUPER SURE ×2 / SUPER SURE — 0 (reveal badges) | **SUPER SURE ×2** / **SUPER SURE ×0** **[test]** |
| ⚡ BLITZ / 20-second clock · round ×1.5 / ⚡BLITZ / ×1.5 ⚡ (twist) | **⚡ BLITZ** / keep / **⚡ BLITZ** / **⚡ ×1.5** **[test]** |
| 🧊 FROZEN / No moving — read the frame / 🧊FROZEN / 🧊 | **🧊 FROZEN** / **No moving — read the scene** / **🧊 FROZEN** / **🧊 FROZEN** **[test]** |
| 🔒 BLIND DUEL / Rival pins are hidden / 🔒BLIND / 🔒 | **🔒 BLIND ROUND** / keep / **🔒 BLIND ROUND** / **🔒 BLIND ROUND** **[test]** |
| 🌍 LONG HAUL / Gentler curve — go bold / 🌍LONGHAUL / 🌍 | **🌍 LONG HAUL** / **Far-off pins score kinder — go bold** / **🌍 LONG HAUL** / **🌍 LONG HAUL** **[test]** |

## 5. Host / landing / TV-link (host.html, host-ui.js, landing-ui.js, tvlink.js, team-names.js)

| Current | Proposed |
|---|---|
| reconnecting… | **Reconnecting — hang tight…** |
| Game in progress / Room CODE — resume as host? / Resume | keep |
| Difficulty: Casual / World tour / Expert | keep |
| Rounds/Teams + numerals | keep |
| 🎲 Surprise me | keep |
| More options / Seconds per round / 60/120/180/No limit | keep |
| Movement: Allowed / No moving | keep |
| Twists: Off / Occasional / Chaos | keep |
| Past games | keep |
| New game | **Start the party** |
| Room code · ······ · No TV? No problem — the reveal shows right here. | keep |
| 📺 Put it on a TV / Scan with any spare phone or tablet, then cast it to the TV. | **📺 Add a TV — optional** / align device wording |
| Send the TV link | **Share the TV link** |
| Abandon | **Close the room** |
| Start round | **Start the game** |
| Make guess | **Guess on the map** |
| map hint + Lock it in | keep |
| ✋ Hold | keep |
| Next round | keep |
| Final standings | **Game over!** |
| © line | **© 2026 · A game by Eduardo Ariño de la Rubia** |
| Share | **Share the result** |
| New game (game-over) | **Play again** |
| Could not create game — see console | **Couldn't start the party — check your connection and try again.** |
| Location pool exhausted! | **We're out of new places — final scores!** |
| Round 3/5 vs Round 3 of 5 | keep (HUD compact / heading spoken) |
| FINAL SHOWDOWN vs Final Showdown | keep (ceremony caps) |
| ∞ | **No timer** |
| Time's up! | keep |
| …drop your pin (2/4) | **…drop your pin (2 of 4)** |
| Raise the stakes? (couch sheet) | keep |
| LOCKED IN stamp / Pass the phone — ${name} is up! | keep |
| Holding — advance whenever you're ready | **Holding — tap Next round whenever you're ready.** |
| SUPER SURE ×2 / SUPER SURE — 0 / Answer | **SUPER SURE ×2** / **SUPER SURE ×0** / keep **[test]** |
| — (unnamed place) | **Somewhere mysterious** |
| 👑 prefixes (showdown + board) | keep (round-winner) |
| Finish / Next round | keep |
| Saved to your past games ✓ / That room is gone | keep |
| Finding your room… / Room not found — check the code. / Codes are 6 letters — check the TV or the invite. | keep (model error copy) |
| TV typing fallback / Join on your phone: {site} — code {code} | keep |
| Scan the host's QR to join | **Scan the QR on the host's phone to join** |
| GEO_PUNS (102 puns) | keep (4 edgy entries flagged for owner decision) |

## 6. TV screens / fx / night / reveal (screen.html, screen-ui.js, screen-h2h.js, couchscreen.js, fx.js, night.js, revealmap.js, autoadvance.js)

| Current | Proposed |
|---|---|
| 🔊/🔇 + Sound on — tap to mute / Sound off — tap to unmute | keep |
| WIN_LINES: take the room / run the table / The room belongs to / own the map / that's the game | **locked it down** / **read the map** / keep / keep / keep |
| The room was closed. / Room not found — check the code. | keep |
| Round 3 / 5 · HUD, FINAL SHOWDOWN (— every team plays!), {name} is guessing · 2/4 | **Round 3/5**; keep showdown; **2/4 locked in** |
| place-name pop / distance · caption / points | keep |
| 🎯 ACE — 0.4 km | keep |
| This round / Totals | keep (Totals everywhere) |
| 👑 ${name} (closest-team crown) | keep (round-winner) |
| answered in 23s (⚡+140) / 🔥 SUPER SURE ×2 / — 0 | keep / keep / **SUPER SURE ×0** **[test]** |
| count-ups, standings, podium | keep |
| 👑 ${winner} won — their phone runs the next game | keep |
| ${name} 👑 (lobby host chip) | **${name} · host** |
| …scan the host's QR to join / n teams ready… / tally · status | **…scan the QR on the host's phone to join** / keep / keep |
| exploring / LOCKED IN / locked in / 2 / 4 locked in / #2 in / on the map 📍 | keep / keep / keep / keep / **locked in 2nd** / **picking a spot 📍** |
| 3-2-1, place pop, boards | keep |
| TV connected ✓ / Offline — you can play on this phone alone. / No TV? No problem — the reveal shows right here. | keep |
| 👑 ${name} wins! | keep |
| ${name} ×2 / 👑 {parts} — first to 3 takes the night | keep |
| 👑 {parts} — Game 4? | **…Game 4 next?** |
| 👑 CHAMPION OF THE NIGHT — ${name} | keep (ceremony) |
| SUPER SURE labels / 🎭 decoy chip (reveal map) | **SUPER SURE ×0** **[test]** / keep |
| 👻 3 km (ghost chip) | keep (verify non-duel never renders) |
| Guess / Answer (couch pin tooltips) | **Your guess** / keep |
| Final scores in 5… / Next round in 5… / Wrapping up… / Starting the next round… | keep / keep / **Final scores…** / keep |
| GeoParty — Screen (tab) | **GeoParty — TV** |
| Enter the room code from the host's phone | keep |
| KWPFRT (code placeholder) | **CODE** |
| Waiting for the host… | keep |
| Guessing… / waiting for a pin… | keep (case normalized) |
| head-to-head (H1 mode tag) | **everyone on their own phone** |
| Leaderboard | **Totals** |
| ALL TEAMS LOCKED IN · 3 | keep (ceremony) |
| Game over! / Start a new game on the host's phone — this screen follows. / Enter a code | keep |
| © line | **© 2026 · A game by Eduardo Ariño de la Rubia** |

## 7. Consent / report / core (consent.js, report-ui.js, viewer-ui.js, game.js)

| Current | Proposed |
|---|---|
| Analytics consent (dialog aria-label) | **Share anonymous play stats?** |
| 🌍 Share anonymous play stats? (banner headline) | keep |
| Scores, distances and modes, plus technical diagnostics and an anonymised replay of the screens you see, so we can fix broken imagery. Never your guesses, your names, anything you type, or the street view itself. EU-hosted, change anytime. | **…plus technical diagnostics and an anonymised replay of the menus and score screens (the street view and maps are blanked out), so we can fix broken imagery. Never your guesses, your names, or anything you type. EU-hosted, change anytime.** |
| No thanks / Sounds good | keep (first-ask); "Sounds good" under reopened settings → **Sharing is on/off** context |
| 📷 Image not working? Report it | keep |
| Read the full privacy policy on GitHub ↗ | keep |
| Currently: on. / Currently: off. | **Sharing is on.** / **Sharing is off.** |
| Report / Report an image problem / body / Send report / Cancel | keep / keep / keep / keep / **No thanks** |
| Send a one-time diagnostic report? | **Send one report about this image?** |
| You've said no to analytics — … to debug this image problem… | **You said no to sharing play stats** / **To fix this image problem** |
| Send one report / No thanks | keep |
| Couldn't send the report — you may be offline or blocking analytics. No data was collected. | **…Nothing left your phone.** |
| Thanks — sent. / ref-code line / Not sent / Close | keep / **…if you get in touch on GitHub.** / keep / keep |
| Finding your way… (arrows pill) | **Loading the arrows…** |
| GP-4K7QMV (support ref code) | keep |
| 23s / 1m 04s / 3.2 km / 1:37 (formatters) | keep |
| SUPER SURE — no pin · 0 / no pin · +0 / 250 km · SUPER SURE — 0 / SUPER SURE ×2 · 3,120 / ⚡23s +140 | **no pin · SUPER SURE ×0** / **no pin · +0** / **SUPER SURE ×0** / keep / keep **[test]** |
| +3,120 pts · 812 km · Nailed it · ⚡+140 fast (+ SUPER SURE variants) | keep (add 🔥 to TV rows for consistency) |
| +3,120 → 9,480 (board rows) | keep |
| Everyone (default solo team name) | keep |

---

## Summary

- **~670 strings audited** across all 6 HTML pages + 42 JS modules.
- **~435 keep** (already precise/on-brand).
- **~235 change** — 3 P0 (growth-loop), 12 P1 consistency clusters (~45 strings), ~70 P2 line edits.
- **~10 strings are test-locked** and must be synced in the same change (marked **[test]** above).
- **No new analytics events.** Share conversion is already readable from the existing `result_shared` event.
- **P0 change-set** (one small PR): "Share your run back" button + card line, the "Challenge link copied — share it" toast, and the tie-line person-flip.
