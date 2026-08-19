# GeoParty — design review & product roadmap

*Status: spec / roadmap only. Nothing in this document is implemented by the
change that adds it; each recommendation is a separate future task. Written
against the codebase as of 2026-08 (couch + head-to-head, 5,312-location
pool, GDPR-gated PostHog analytics live).*

The brief: turn a working prototype into a Wordle-grade "game juggernaut" —
a game a room full of people picks up in seconds and comes back to. This
review looks at the game as a product (loop, modes, scoring, friction), then
at the landing page and user education, and ends with a prioritized roadmap
tied to the PostHog KPIs we already collect (`docs/analytics.md`).

---

## 1. Overall design review

### 1.1 What already works — protect these

- **Head-to-head's core loop is genuinely strong.** Simultaneous play, the
  explore↔map flip, visible rival pins (bluffing/copying with a time-bonus
  tax), "Team X locked in!" race toasts, the 3-2-1 all-pins reveal drawn
  farthest-first, and the winner-takes-the-crown host rotation form a tight,
  legible loop with real social texture. This is the game's future.
- **The scoring design is smart**: exponential distance decay plus a time
  bonus that scales with *both* speed and accuracy (slamming a random pin
  fast earns nothing; copying a rival's pin costs the time they spent
  placing it). The problem is legibility, not design (§1.4).
- **Zero-install, zero-account architecture** is the right foundation for a
  party game: a URL and a 6-letter code is Jackbox's exact onboarding
  contract. Don't compromise it.
- **Resilience details** (resume banners, deadlock guard, forfeit sweeps,
  offline degradation) are above prototype grade and directly protect the
  funnel's `round_started → reveal_shown` step.

### 1.2 Game loop & pacing

**Couch mode** — the loop is: host configures teams → waits for a TV →
drives the pano while the couch shouts → opens the map → confirms → reveal.
Issues:

- **Solo-round downtime is the biggest pacing flaw.** With 3–4 teams, each
  team is passive for 2–3 consecutive rounds. The Showdown fixes this only
  in the final round. The shouting-at-the-driver dynamic papers over it for
  small groups but not for competitive ones. (Measure: couch
  `game_abandoned.rounds_played` and the couch funnel drop between
  `round_started` and `game_completed`.)
- **The TV is a hard gate**: `Start Round` is disabled until a screen
  heartbeat arrives (unless offline). That's one more device, one more URL,
  one more code entry before anyone plays. H2H treats the TV as optional;
  couch should learn the same trick where possible.
- Pass-the-phone during the Showdown is a fun ritual but is explained only
  by a HUD label; first-time groups fumble it.

**Head-to-head** — pacing is strong. Remaining rough edges:

- The **reveal is thin on the phone** when no TV is present: text rows, no
  map, so the payoff moment ("*that's* where it was?!") only exists on the
  TV. (Being addressed by the remote-play work.)
- **No comeback mechanic.** Couch has the Showdown; h2h is a flat sum of
  identical rounds, so a 2,000-point lead by round 3 of 5 kills tension.
  H2H needs its own final-round stakes (see roadmap: "Final round counts
  double" or an h2h Showdown variant).
- Between-round dead air: only the host phone can advance past the reveal;
  if the host is chatting, everyone else stares at "X starts the next
  round…". A soft auto-advance timer (host can cancel) would keep tempo.

### 1.3 Are two modes the right structure? — Recommendation

**Recommendation: keep both play styles, but kill the two-front-doors
structure. Present ONE game with one join flow; "couch" becomes a table
setting, not a separate product.**

Rationale:

- The modes genuinely serve different rooms: couch is co-op-ish and works
  with one phone + a TV (grandparents, big groups, low phone-tolerance);
  h2h is the competitive flagship. Deleting couch would burn a real use
  case for structural tidiness.
- But the *presentation* — two different HTML entry pages ("Host" vs
  "Head-to-Head") plus a third ("Screen"), each with its own lobby — is the
  single largest source of confusion. A new user must understand GeoParty's
  architecture before playing it. Jackbox's rule: players never choose a
  mode; they go to one URL and type a code. The host chooses everything.
- Structurally, h2h already generalizes couch: it supports 1 team, embeds
  truth in the round, and treats the TV as optional. Long-term, couch can
  be re-expressed as an h2h configuration ("one driving phone, turn
  rotation on, TV required off/on"), collapsing `game.js` vs `h2h.js`
  duplication (two phase machines, two reveal renderers). That's a later
  refactor; the near-term win is purely a front-door/UX unification:
  - One landing CTA: **"Start a party"** → host picks *"Everyone on their
    own phone"* (h2h, default) or *"One phone + the TV"* (couch).
  - One join path: `?room=CODE` link/QR routes to the right experience
    automatically (the room already knows its `mode`).
  - "Screen" stops being a peer-level choice and becomes an optional
    *"Put it on a TV"* affordance inside the lobby.
- KPI to validate: Mode Adoption (`game_created` by `mode`) before/after;
  funnel entry (`game_created` per landing `$pageview`) should rise.

### 1.4 Scoring clarity

Nobody is ever told the rules. The formula (5000·e^(−km/1492), plus a bonus
up to +20% scaled by speed² and accuracy) is good; its opacity costs tension
— players can't feel "a close pin NOW beats a perfect pin later".

- The reveal breakdown (`812 km · ⚡23s +140 · +2,940`) is the only teacher,
  and it arrives after the decisions were made.
- Fixes, cheapest first: a one-line rule on the guess map the first round
  ("Closer = more points. Faster = bonus."); a live "if you locked in now"
  point hint while aiming (couch host already has live distance internally);
  a scoring line in the lobby. Full formula belongs in a "?" sheet, not the
  main flow.
- KPI: `guess_submitted.time_bonus` distribution — if education works, the
  share of guesses earning a non-zero bonus rises.

### 1.5 Location pool difficulty & balance

5,312 locations sampled uniformly by a seeded cursor means difficulty is a
coin flip: Tokyo intersection one round, an unnamed rural road the next.
That randomness is charming *within* a party but makes games incomparable
and can bury a new group in three unguessable rounds.

- Add a difficulty score per location offline (population of the nearest
  city is already in the build pipeline; imagery density is a proxy too)
  and let the host pick *Casual / World tour / Expert* — a pool-tools task,
  explicitly out of scope until then.
- Guard the first round of a room toward the easy tier: first impressions
  decide the funnel's `round_started → reveal_shown` survival.
- KPI: Average Guess Distance (`guess_submitted.distance_km`) by
  `round_number` — today's spread is the baseline; tiers should compress it
  within a chosen difficulty.

### 1.6 Team model, reveal, comeback

- **Team model**: slots-as-identity (device id ↔ `t1..t4`) is robust and
  survives refreshes; keep. For 1v1 remote play the word "team" reads
  heavy — cosmetic copy fix ("player or team"), not a model change.
- **Reveal**: the TV animation (farthest-first elimination, truth lands
  last, crown) is the best moment in the game. The phone deserves a version
  of it; the couch host phone too.
- **Comeback**: the Showdown (leader guesses blind, underdog reacts last)
  is a genuinely clever couch mechanic and is invisible until it happens —
  a "FINAL SHOWDOWN" interstitial with one line of rules would sell it.
  H2H's equivalent gap is §1.2. Keep the mechanic; explain it and export it.

### 1.7 Friction & lost-player moments (ranked)

1. Landing page asks the user to self-select among Host/Head-to-Head/Screen
   before explaining anything (§2).
2. Couch can't start without a TV; h2h buries "the TV is optional".
3. First reveal is the first time scoring is explained — too late.
4. Consent banner is the first thing every new device sees, ahead of any
   game value. Correct legally; worth softening visually (it currently sits
   over the join form on phones).
5. Mid-game joiners are rejected ("That game already started") with no next
   step — offer "watch this game" (screen view) or "join next game".
6. Mapillary image failures degrade politely on phones (toast) but a
   host whose *first* round fails to load gets silence while the pool
   skips — needs a visible "finding a good spot…" state.
7. No sound/haptics anywhere: lock-ins, countdowns, and reveals are silent,
   which reads as unfinished on a TV at a party.

---

## 2. Landing page & user education

### 2.1 How people arrive today

- **Joiners** (the majority of humans who ever touch GeoParty) arrive via
  QR deep-link → `player.html?room=CODE` with the code prefilled; they type
  a team name and tap Join. This flow is already Jackbox-grade. The only
  gap is *remote* joiners, who need a shareable link rather than a QR.
- **Hosts** arrive at `index.html`: three paragraphs of prose, then three
  equally-weighted links labeled by *system role* (Host / Head-to-Head /
  Screen), not by intent. The copy explains architecture ("open the host
  page on a phone, the screen page on the TV") — accurate, and exactly what
  a landing page shouldn't make you read.
- **TVs** need a human to open `screen.html` and type the code with a TV
  keyboard, or to visit the URL from the host's lobby. Workable; the QR the
  host lobby shows is the *join* QR in h2h, so pointing a TV is the
  worst-documented step.

### 2.2 Landing page: concrete redesign

Wordle's landing is the game. Jackbox's is "everyone go here, type this".
Target composition, top to bottom:

1. **Hero**: logo + one sentence ("Guess where in the world you are. Phones
   in, pins down.") over a slowly-drifting street-level pano (delight +
   instantly communicates the game's substance).
2. **One primary CTA: "Start a party"** → the unified host setup (§1.3).
   **One secondary: "Have a code? Join"** → code entry. Nothing else above
   the fold.
3. A **three-step visual strip** (host phone → friends' phones via QR/link →
   optional TV), pictures over paragraphs, ≤6 words per step.
4. Footer: "Add a TV", privacy, GitHub.

Copy rules: name the modes by player experience ("Everyone on their own
phone" / "One phone + the TV"), never by page name; never use the words
host/screen/mode above the fold.

### 2.3 In-game education (progressive disclosure)

Principle: teach exactly one thing at the moment it's needed, once per
device (localStorage flag), never a tutorial screen.

- Lobby (host): "Friends scan this — or send them the link." / (joiner):
  "Waiting for ⟨host⟩ to start" — already good.
- First pano: one-shot overlay, 2 lines: "Look around 👀 — figure out where
  you are. Then *Make Guess*."
- First guess map: existing hint, plus the scoring line ("Closer = more
  points. Fast = bonus.") and — h2h — "Rivals can see your pin move.
  Bluff away."
- First reveal: label the breakdown ("distance + ⚡speed bonus") the first
  time only.
- Showdown: interstitial card with the one rule that matters ("Leader
  guesses first. Everyone plays. Last chance to catch up.").
- The TV already narrates itself well (lobby join line, lock-in statuses,
  "ALL TEAMS LOCKED IN"); add the room code persistently in a corner
  during rounds so latecomers can join the *next* game (couch) or know
  where to look.

### 2.4 The polish gap (Wordle-grade ≠ feature-grade)

What separates this from a product people screenshot:

- **Identity & shareability**: no favicon/app icon, no `og:` / social meta,
  no PWA manifest ("Add to home screen" is the retention surface for a
  no-account game).
- **A share artifact**: Wordle's emoji grid is the growth engine. GeoParty
  post-game share card writes itself: `GeoParty 🌍 We were 3 km from
  Kyoto 🏆 4,890 pts — beat us: <link>`. Pure copy-to-clipboard, no backend.
- **Motion & sound**: phones are static (screens toggle `hidden`); the
  reveal animation exists only on the TV. Lock-in stamp, countdown pulse,
  and reveal deserve motion everywhere; one tasteful tick + reveal sting
  (muted by default on phones, on by default on the TV) changes the felt
  quality disproportionately.
- **States**: pano loading (black box today), pool-skip ("finding a good
  spot…"), room-not-found (exists, fine), reconnecting pill (exists, fine),
  empty lobby (fine). Mostly loading states are the gap.
- **Accessibility**: muted-on-dark text runs below AA in places; no
  `prefers-reduced-motion` handling on the TV animations; touch targets on
  the segmented controls are tight.

---

## 3. Prioritized roadmap

Effort: S ≤ ½ day · M ≈ 1–2 days · L ≈ 1 wk+. Lens: 🚪 onboarding /
🎉 gameplay / 🔁 retention. Every item names the KPI that judges it.

### MUST

| # | Item | Lens | Why (one line) | Effort | KPI |
|---|---|---|---|---|---|
| M1 | **One front door**: single landing CTA + unified join; modes renamed by experience; "Screen" demoted to an in-lobby "Add a TV" | 🚪 | The #1 confusion is choosing a page, not playing the game | M | `game_created` per landing `$pageview`; Mode Adoption |
| M2 | **Remote h2h without a TV** (phone reveal map, shareable invite link, TV-optional copy) | 🚪🎉 | Doubles the addressable occasions (distance play); TV was never load-bearing in h2h | M | `team_joined` w/o `screen_joined` in same room; `invite_shared` |
| M3 | **Scoring one-liners** at guess time + labeled first reveal | 🎉 | The best mechanic in the game is currently a secret | S | `time_bonus` > 0 share of `guess_submitted` |
| M4 | **Landing rewrite** per §2.2 (hero, 3-step visual, one CTA) | 🚪 | Prose-wall → 5-second comprehension | S–M | Funnel entry rate |
| M5 | **First-time hints** (one-shot pano/map overlays, localStorage-flagged) | 🚪 | First round decides whether the room comes back | S | Round-1 `guess_submitted.distance_km`; funnel `round_started → reveal_shown` |

### SHOULD

| # | Item | Lens | Why | Effort | KPI |
|---|---|---|---|---|---|
| S1 | **Share artifact**: post-game emoji/result card, copy-to-clipboard | 🔁 | The Wordle growth loop; zero backend | S | New-room creations from shared links (UTM-tagged) |
| S2 | **Daily Challenge**: date-seeded 5-location run (PoolSampler is already seed-based), same for everyone, shareable score | 🔁 | The Wordle *retention* loop: a reason to return alone, recruit friends | M | PostHog Retention on `game_created`; daily actives |
| S3 | **H2H comeback stakes**: final round counts double (or h2h Showdown) | 🎉 | Flat scoring kills late-game tension | S | `game_completed` margin distribution; abandonment at late rounds |
| S4 | **Difficulty tiers** for the pool + easy-tier first round (pool-tools task) | 🎉 | Uniform sampling makes first impressions a coin flip | L | `distance_km` spread by tier |
| S5 | **Sound + motion pass** (lock-in, countdown, reveal; respects reduced-motion) | 🎉 | The felt-quality gap between prototype and product | M | Session length; `game_completed` rate |
| S6 | **PWA + social meta + icons** | 🔁 | Home-screen presence is the no-account retention surface | S | Return sessions (device retention) |
| S7 | **Soft auto-advance** after reveal (host can hold) | 🎉 | Removes dead air between rounds | S | Time between `reveal_shown` and next `round_started` |
| S8 | **Couch without a TV** (host phone becomes the shared screen) | 🚪 | The last hard device-gate in the product | M | Couch `game_created → round_started` conversion |

### COULD

| # | Item | Lens | Why | Effort | KPI |
|---|---|---|---|---|---|
| C1 | Unify couch as an h2h configuration internally (one phase machine, one reveal renderer) | — | Halves surface area; enables mixed rooms | L | (engineering health) |
| C2 | Late joiners: "watch" or "queue for next game" instead of rejection | 🚪 | Converts turned-away players into next-game players | M | `team_joined` on rooms ≥ round 2 |
| C3 | Themed pools (capitals, landmarks, one country) as host options | 🔁 | Variety for repeat groups | L | Rounds per game, repeat `game_created` |
| C4 | Spectator link for remote watchers of a couch party | 🎉 | Cheap — the screen page already is this; just market it | S | `screen_joined` per room > 1 |
| C5 | Mid-game "point pace" hint (live "locking now ≈ +3,200") | 🎉 | Makes the time bonus viscerally legible | M | `time_bonus` distribution |

### The single most important product change

**S2 + S1 together: the date-seeded Daily Challenge with a shareable result
card.** Everything in MUST makes the party experience frictionless, but a
party game gets played when there's a party; Wordle-grade gravity comes from
a solo-friendly daily ritual that doubles as an invitation. The seeded
sampler means the hard part is already built — what's missing is a date
seed, a score summary, and a clipboard string.

### Measurement plan (all pre-instrumented unless noted)

- Funnel: `game_created → round_started → reveal_shown → game_completed`
  per mode — the scoreboard for M1–M5.
- Mode Adoption + `screen_joined`-per-room — validates M1/M2/S8.
- `guess_submitted` (`distance_km`, `time_seconds`, `time_bonus`) — M3, M5,
  S4, C5.
- Retention insight on `game_created` — S1/S2/S6 (S2 needs one new event,
  e.g. `daily_challenge_started`, added per `docs/analytics.md` process).
- `invite_shared` (added with M2) — remote-play adoption.
