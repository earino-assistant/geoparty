# Daily mid-run persistence — resume at round N after a reload

> **STATUS: PROPOSED (2026-08-28) — design only, unimplemented.**
> Implement **after** the iOS blackout render-recovery build
> (docs/ios-blackout-review.md §18) lands — this design layers on top of it
> and touches none of the same seams (§9). Positions are taken, not offered
> as menus; the two genuinely owner-level calls are isolated in §12.

Field incident, 2026-08-28: an iOS player hit a black canvas at Daily
round 3, reloaded in frustration, and lost rounds 1–2 — a reload restarts
the run from round 1. The render-death probe + auto-rebuild (in flight)
covers in-page recovery; this spec is the safety net for the paths no
in-page fix can cover: reload, tab kill, phone lock long enough to evict
the page, browser crash.

Scope: **solo Daily runs only — normal and hard mode.** Ghost Duel runs are
deliberately excluded (§5.4). Party games, h2h, and couch are out of scope
(their state is Firebase-backed and multiplayer; different problem).

---

## 1. Verified mechanics this design stands on

All verified against the working tree, 2026-08-28:

- **The day's round order is fully derived from the local calendar date.**
  `dailyKey(new Date())` → `"YYYYMMDD"` (local date, Wordle's rule —
  daily.js:46) → `dailySeed(key)` = `"daily-YYYYMMDD"` (daily.js:54) →
  `new PoolSampler(pool, seed)` (daily-ui.js:264) yields a deterministic
  shuffled order of the whole pool. Nothing else feeds the order. The
  date also scopes the replay-lock slots (`geoparty_daily_result[.hard]`
  validate `parsed.key === key`, daily.js:186) and the streak fold.
- **Dead-image skips are deterministic — but they consume seeded entries.**
  `loadRoundImage` (viewer-ui.js:1485) advances the sampler past *provably
  dead* entries only ("every device on the same seed skips the same entry
  to the same next spot", viewer-ui.js:1533); transient/environmental
  failures do **not** advance (viewer-ui.js:1517). Consequence: after two
  rounds the sampler cursor is `2 + (dead skips so far)`, not `2`. The
  brief's assumption "a round index is sufficient" is therefore *almost*
  right: replaying the skip loop from index 0 would land in the same place,
  but only by re-probing the network for every previously skipped entry.
- **`PoolSampler` already supports resuming from a persisted cursor.**
  `constructor(pool, seed, cursor = 0)` (pool.js:145) — the party host
  persists exactly this cursor in Firebase. We reuse the mechanism, not
  invent one: persist the cursor, rebuild the sampler at it.
- **A round is *committed* at lock-in.** `lockIn()` (daily-ui.js:501) folds
  the round via `recordDailyRound` and pushes the shown truth onto
  `playedPlaces`. Everything after (reveal, next-round tap) is display.
  Between a round's start and its lock-in, nothing advances the sampler —
  including the §18 render-rebuild, which re-targets the current image
  inside the viewer-ui wrapper and never touches the sampler.
- **The run object is already the persistence-shaped value.**
  `newDailyRun` / `recordDailyRound` (daily.js:107/118) build
  `{key, score, rounds, hard}` — the exact object `saveDailyResult`
  writes to localStorage at completion today, per-round pins included
  (the owner-approved v2 shape, §5.2 of the G1–G8 spec).

---

## 2. What persists — the payload

One localStorage slot, one JSON object:

```js
// key: "geoparty_daily_inflight"
{
  v: 1,                     // INFLIGHT_VERSION — bump on any shape change
  poolCheck: "ab3f",        // ghost.js poolCheck() over the day's first
                            // DAILY_ROUNDS seeded skip-free image ids —
                            // a 16-bit hash, NOT an id (see §6, drift guard)
  cursors: [1, 2, 4],       // sampler cursor AFTER each played round's
                            // advance, strictly increasing ints. Encodes
                            // both resume position (last element) and,
                            // via order[cursors[i] - 1], the exact truth
                            // each round showed (rebuilds playedPlaces)
  run: { key, score, rounds, hard },   // the recordDailyRound object,
                            // verbatim — same bytes that land in
                            // geoparty_daily_result at completion
}
```

Decisions inside that shape:

- **Completed rounds' aggregates persist — the recap must not lie.** The
  brief's leaning is confirmed and strengthened: `run.rounds` carries each
  round's `distanceKm / distancePoints / timeBonus / points / elapsedMs`,
  so the done-screen score, emoji row, medals, ACE count, best-distance,
  and the `daily_challenge_completed` properties are identical whether or
  not a reload happened mid-run.
- **`cursors` (plain ints) replaces persisting places or ids.** The
  done-screen recap needs the truths *actually shown* (skip-adjusted play
  order, `playedPlaces`). Rather than persist names/coordinates/image ids,
  persist each round's post-advance cursor: `order[cursors[i] - 1]` in the
  re-derived seeded order *is* round i's entry. Resume rebuilds
  `playedPlaces` exactly, for free, from integers. Gaps between consecutive
  cursors are the dead skips. No truth coordinate, no image id, no user
  text is ever written by this feature's new code.
- **The run's per-round guess pins persist inside `run`, unchanged.** This
  is the one place the spec diverges from the brief's letter ("no
  coordinates") — deliberately, and it is flagged as owner call §12.1. The
  short version: these exact bytes already land in
  `geoparty_daily_result` (owner-approved, device-local) minutes later at
  completion; stripping them from the in-flight copy adds zero privacy
  (same storage, same device, strictly shorter-lived) while making three
  things lie after a resume: the recap's guess pins vanish for pre-reload
  rounds, the outgoing Ghost Duel link encodes those rounds as forfeits (a
  dishonestly weak ghost — worse than no link), and `runHasPins`-style
  gates need new partial-run special cases. Persisting `run` verbatim is
  simpler *and* more truthful. Nothing in this slot is ever transmitted —
  test-enforced (§11).
- **No timer state.** An interrupted round restarts with a full clock
  (§5.2). No `endsAt`, no `roundStartedAt`.
- Optional `savedAt` debug timestamp is *not* included: it would be the
  only field validation ignores, and day-scoping via `run.key` already
  answers "is this stale".

---

## 3. Module placement — pure core, thin glue

Per the repo contract, the decision logic is pure and tested; storage
access sits behind the same `{getItem,setItem,removeItem}` seam
`loadDailyResult` already uses.

**`js/daily.js` additions (pure, no DOM/network):**

```js
export const DAILY_INFLIGHT_KEY = "geoparty_daily_inflight";
export const INFLIGHT_VERSION = 1;

// Payload builder. Pure: (run, cursors, poolCheck) -> payload object.
export function buildInflight(run, cursors, poolCheck)

// Total validator: raw JSON string -> { run, cursors, poolCheck,
// complete } | null. Never throws. Checks: parseable; v ===
// INFLIGHT_VERSION; run passes the loadDailyResult structural checks
// (key/score/rounds) AND run.key === todayKey; every rounds[i] has
// numeric points/distancePoints/timeBonus (score integrity);
// cursors is an array of strictly increasing positive ints with
// cursors.length === run.rounds.length; 1 <= rounds.length <=
// DAILY_ROUNDS. `complete` = rounds.length >= DAILY_ROUNDS.
export function parseInflight(raw, todayKey)

// Pool-drift guard, applied at resume time once the pool is loaded
// (poolCheckNow = ghost.js poolCheck over the re-derived day ids):
export function inflightMatchesPool(inflight, poolCheckNow)  // boolean

// playedPlaces reconstruction: (order, cursors) ->
// [{name, lat, lng}] — order is the sampler's seeded order array;
// entry i is order[cursors[i] - 1]. Returns null if any cursor
// exceeds order.length (pool shrank; caller discards — the poolCheck
// guard normally catches this first).
export function placesFromCursors(order, cursors)

// Boot arbitration between the inflight slot and a completed saved
// result for the same day+mode (see §6 for why both can exist):
// -> "resume" | "finalize" | "discard"
export function resolveInflight({ inflight, hasSavedResult })

// Thin storage glue, house style (try/catch, degrade to null/no-op):
export function loadInflight(storage, todayKey)   // -> parsed | null
export function saveInflight(storage, payload)    // swallow quota/private
export function clearInflight(storage)            // swallow errors
```

**`js/ghost.js`:** extend `dailyEntryRoute` (the existing pure boot
router) with the inflight inputs — it already arbitrates
saved-result/duel/exhibition and is the tested home for route precedence:

```js
dailyEntryRoute({ hasSaved, isExhibition, isDuel, ghostOk,
                  inflight: null | "partial" | "complete" })
  -> "play" | "done" | "instant-verdict" | "resume" | "finalize"
```

**`js/daily-ui.js`:** glue only — one save call site, one resume path, one
clear call site, the intro relabel (§7). No decision logic.

**`js/analytics.js` + `docs/analytics.md`:** the `daily_resumed` schema
entry and doc row (§10).

Files touched: `js/daily.js`, `js/ghost.js`, `js/daily-ui.js`,
`js/analytics.js`, `tests/daily.test.js`, `tests/ghost.test.js`,
`tests/analytics.test.js`, `docs/analytics.md`,
`docs/replay-mask-checklist.md` (no-change note, §7). **Not touched:**
`js/viewer-ui.js`, `js/imagery.js`, `js/pool.js` — the blackout build owns
those seams and this design needs nothing from them.

---

## 4. Lifecycle

| Moment | Action |
|---|---|
| Round lock-in (`lockIn`, right after `recordDailyRound` + `playedPlaces.push`) | If solo (`!isDuel && !isExhibition`): `cursors.push(sampler.cursor)`; `saveInflight(localStorage, buildInflight(run, cursors, inflightPoolCheck))`. ≤ 5 writes/day. |
| Run start (`startChallenge`, after the sampler is built) | Compute `inflightPoolCheck = poolCheck(first DAILY_ROUNDS skip-free seeded ids)` synchronously from the in-memory pool (the same `peekDayPlaces` walk, no network). Stash it for the save sites. |
| Run completion (`finishRun`) | If solo: `clearInflight` **after** `saveDailyResult` + records fold succeed, so a crash inside `finishRun` leaves a *complete* inflight that finalization (§6) can still rescue. Duel/exhibition finishes never touch the slot (they never wrote it; stale overlap resolves at next boot via `resolveInflight`). |
| "Start over" tap (§7) | `clearInflight`, then the normal fresh `startChallenge`. |
| Stored day ≠ today | `parseInflight` returns null (`run.key !== todayKey`); loader also removes the item. Yesterday's half-run never restores — the pool order it indexed belongs to yesterday's seed. |
| Hard mode | One slot serves both boards: only one solo run can ever be in flight (hard entry exists only on the done screen, i.e. after the normal run completed and cleared its state). `run.hard` records which board; resume restores the mode from it. |

The clock: an interrupted round resumes at **round start with a full
timer** — the sampler cursor persisted at the *previous* lock-in means
`startRound` re-derives and re-shows the same image the player was on.
Yes, this technically lets a player reload for a fresh 60s (and a fresh
time-bonus window) on a round they've already scouted. Accepted
explicitly: daily.js:168 already states "devtools-grade honesty is not a
threat model we carry", and the alternative — persisting `endsAt` so the
clock burns while the phone is locked — punishes precisely the
crash/lock victim this feature exists to rescue. (Forfeiting the
interrupted round is worse still, for the same reason.)

---

## 5. Validation, precedence, and the excluded cases

### 5.1 Boot precedence (top wins)

1. **Usable ghost link → duel routes, unchanged.** A tapped challenge is
   explicit intent; the inflight slot is left alone (not cleared —
   an exhibition of another day's board must not destroy today's
   half-run). If the duel completes and saves today's board, rule 2
   discards the now-stale inflight at the next boot.
2. **Completed saved result for the inflight's day+mode → inflight
   discarded** (`resolveInflight` → "discard"). This is the double-fold
   guard: a crash after `saveDailyResult` but before `clearInflight`
   must not re-fold the streak/records via finalization.
3. **Complete inflight (5 rounds) → "finalize"** (§6).
4. **Partial inflight → "resume"** intro (§7).
5. Existing routes (done / instant-verdict / fresh intro), unchanged.

### 5.2 Resume-tap sequence

Resume tap → `loadPool` → recompute the day's `poolCheck` →
`inflightMatchesPool`? If no: discard, toast "Couldn't restore your
earlier rounds — starting today's five fresh.", fire
`daily_resumed {action:"discarded"}`, fall into the normal fresh path.
If yes: `run = inflight.run`; `sampler = new PoolSampler(pool,
dailySeed(run.key), cursors.at(-1))`; `playedPlaces =
placesFromCursors(sampler.order, cursors)` (null → discard, same as
drift); restore `mode` from `run.hard`; fire `daily_resumed
{action:"resume"}`; **do not re-fire `daily_challenge_started`** (it fired
before the reload; the funnel stays 1 started : 1 completed); `startRound()`.

`iv.beginRound(run.rounds.length + 1)` and the "Round N/5" HUD are
automatically correct because `run` is restored before `startRound` runs —
the blackout build's per-round `pano_session` folds stay truthfully
numbered on a resumed run.

### 5.3 Why `poolCheck` and not nothing

`cursors` are indices into the seeded order; if the pool file deploys
mid-day, that order reshuffles and the indices point at different entries
(worst case: re-showing an already-guessed image). The ghost feature
already ships the exact guard: `poolCheck(imageIds)` (ghost.js:106), a
16-bit fold over the day's first-five skip-free ids — pure, tested,
computable synchronously from the in-memory pool, and **a hash, not an
image id**. Mismatch → discard, fresh run. Same posture as ghost links'
"built on an older Daily" degrade.

### 5.4 Ghost Duel runs never persist

A duel's ghost payload lives only in the URL fragment, which is parsed
and stripped at module eval (daily-ui.js:85) and — CLAUDE.md hard
boundary — may never touch storage. So a mid-duel reload cannot restore
the *duel* (the ghost is gone by design), and resuming the player's half
as a suddenly-solo run would silently change what the run means. The
recovery path for duels already exists: re-tap the link (re-tappable any
number of times; the completed-duel fold is idempotent via
`duelAlreadyResolved`). Exhibitions save nothing today and continue to
save nothing. The save/clear sites are guarded on
`!isDuel && !isExhibition`; a test pins it.

### 5.5 Multi-tab

Two same-day tabs race last-writer-wins on one slot. The read happens
once at boot, writes at lock-ins. Worst case is one tab's rounds
shadowing the other's — a solo, casual, same-device scenario the replay
lock already tolerates (its slot has the same property). Accepted; noted,
not engineered around.

---

## 6. Finalization — the crash-at-the-finish-line rescue

Round 5's lock-in writes a 5-round inflight; `clearInflight` runs only
after `saveDailyResult` inside `finishRun`. A crash on the round-5 reveal
(or inside `finishRun` before the save) therefore leaves a *complete*
inflight and no saved result — without this rule, validation would
discard it and the whole day's run would vanish at the finish line.

Boot route "finalize": fold the completed run exactly as `finishRun`
does — `saveDailyResult`, `applyDailyResult` records/streak fold,
`saveRecords`, fire `daily_challenge_completed` (it never fired) and
`daily_resumed {action:"resume", rounds_done: 5}` — clear the slot, and
`renderDone(run, false, …)` with the full fresh-completion celebration
(they did finish it). Implementation note: extract the solo fold from
`finishRun` into a function both paths call; rule 5.1-2 (a saved result
discards the inflight) is what makes this fold un-repeatable.

---

## 7. Restore UX — one tap on the calm surface, zero ceremony

**Recommendation: not silent auto-resume — a one-tap resume on the intro
screen.** The brief's default (silent auto-resume + indicator) was weighed
against docs/ui-ux-design-review.md §4 and loses on four points:

- The intro is the Daily's designated calm state (§4.1 utility-corners
  row: "daily intro/done"); it is where a choice belongs. Auto-resume
  drops the player into a *running 60-second round* the moment a possibly
  slow reload finishes rendering — a timer starting while nobody is
  looking is the opposite of calm.
- The tap preserves the user-gesture the page's boot already leans on
  (sound unlock, viewer/WebGL creation are gesture-fed today via "Play
  Today's Daily"); auto-starting them from `load` is new iOS-Safari
  surface area in exactly the release where we're stabilizing WebGL.
- "Start over" needs a home. §4.1's action-bar rule (1 primary + ≤ 1
  ghost secondary; destructive actions are ghost buttons) gives it one on
  the intro for free. Mid-round there is no compliant slot for it.
- The indicator comes free: the button label *is* the indicator.

Concretely, when boot routes to "resume", the intro renders unchanged
except:

- Primary button: **"Resume — round 3 of 5"** (from
  `run.rounds.length + 1`).
- Ghost-style secondary text button below it: **"Start over"** → clears
  the slot, fires `daily_resumed {action:"restart"}`, runs the normal
  fresh path (which re-fires `daily_challenge_started` — a real second
  start, honest in the funnel).
- After the resume tap, one toast: **"Picked up where you left off —
  round 3 of 5."** Past-tense status, ≤ 2 lines — §4.4-conformant. The
  round HUD ("Round 3/5") and the next reveal's "Total so far" carry the
  proof that nothing was lost.

No new screens, pills, sheets, or HUD items. Replay masking: the resume
surfaces show a round number and a score — no team name, room code,
place name, or map — so `docs/replay-mask-checklist.md` gets a one-line
"Daily resume intro: nothing to mask (round index + score only)" entry
and no selector changes.

---

## 8. Failure modes — broken persistence must never break the game

| Failure | Behavior |
|---|---|
| Corrupted / truncated JSON | `parseInflight` → null → fresh run. |
| `v` ≠ `INFLIGHT_VERSION` | Discard (never migrate a mid-run save — it's worth at most 4 rounds). |
| Structural lies (cursors not increasing, length mismatch, rounds > 5, non-numeric points) | Discard. |
| Stored day ≠ today | Discard + remove. |
| Pool drift (`poolCheck` mismatch) or cursor beyond pool | Discard at resume-tap, toast, fresh run. |
| `setItem` quota / private mode | `saveInflight` swallows; run continues un-persisted (same posture as `saveDailyResult`, daily.js:201). |
| `removeItem` throws | Swallow; the day-scope check neutralizes the leftover tomorrow. |
| Any unexpected throw in the resume path | The glue wraps restore in try/catch → discard → fresh run. The player's worst case is exactly today's behavior. |

---

## 9. Interplay with the blackout build (sequencing)

This design was written against the render-recovery design
(docs/ios-blackout-review.md §18, Opus build in flight). Constraints,
stated for the implementer:

1. **Build order: persistence branches from the landed blackout commit.**
   The only shared file is `js/daily-ui.js`; the persistence anchor
   points ("immediately after `recordDailyRound` in `lockIn`", "after
   `saveDailyResult` in `finishRun`", "after the sampler is built in
   `startChallenge`") are stable under that build's changes (it works
   inside `createViewer`/`loadRoundImage`, not the run fold).
2. **The rebuild path never touches persistence.** The §18 in-place
   rebuild re-targets the *current* image inside the viewer-ui wrapper
   and never advances the sampler — so the persisted cursor cannot be
   moved by a recovery, and no save site exists anywhere in the recovery
   path. No double-persist is possible: writes happen at lock-in only.
3. **Restore never runs mid-round.** The inflight slot is read exactly
   once, at boot, before any viewer exists. A rebuild mid-round therefore
   can never race a restore or resurrect stale state.
4. **Resume composes with the probe automatically.** The resume path
   re-enters the ordinary `startRound` → `beginRound(N)` →
   `loadRoundImage` flow with `run` already restored, so round numbering
   in `pano_session` folds and recovery telemetry stays correct with no
   blackout-side changes.
5. Update the now-stale comment at daily.js:167 ("A mid-run refresh
   restarts the run") in the same change.

---

## 10. Instrumentation — one event

Product question: does persistence move Daily completion (especially the
iOS funnel the incident came from)?

`EVENT_SCHEMA` addition (js/analytics.js), aggregates only:

```js
// Daily mid-run persistence (docs/daily-persistence-spec.md). Fired at
// the moment of choice on a device that had saved mid-run state:
// action ∈ "resume" (continued at round rounds_done+1, incl. the
// 5-round finalize rescue) | "restart" ("Start over" chosen) |
// "discarded" (state was invalid/drifted and a fresh run started).
// rounds_done is how many rounds the save held (0 when unparseable).
// No coordinate, pin, image id, or payload byte rides.
daily_resumed: {
  day_number: "int", rounds_done: "int", hard: "bool", action: "string",
},
```

`docs/analytics.md`: event row + a KPI row — **Resume rescue rate**:
`daily_resumed[action=resume]` ÷ `daily_challenge_started` (how often the
net catches someone), and the funnel `daily_resumed[action=resume] →
daily_challenge_completed` split by device type (does a caught run get
finished, and did it move iOS completion). `daily_challenge_started` is
deliberately *not* re-fired on resume and `daily_challenge_completed`
gains no property — the existing completion funnel measures the effect
unchanged, and one event stays one event. ("Streak-safe" from the brief
is already covered: `streak` rides on started/completed.)

Consent gating unchanged: the call sites go through `track()` from
js/consent.js like every other Daily event. No inflight byte can reach
analytics: nothing reads the slot except the boot path, and the sanitizer
tests in §11 pin the event's property set.

---

## 11. Tests (exact names)

`tests/daily.test.js` — pure core:

1. `inflight: buildInflight/parseInflight round-trip a mid-run save`
2. `inflight: another day's save is discarded and removed`
3. `inflight: a version mismatch is discarded`
4. `inflight: corrupted JSON reads as absent`
5. `inflight: cursors must be strictly increasing and match rounds length`
6. `inflight: rounds beyond DAILY_ROUNDS are discarded`
7. `inflight: a complete (5-round) save parses with complete=true`
8. `resolveInflight: a saved result for the same board discards the inflight (no double fold)`
9. `resolveInflight: complete → finalize, partial → resume`
10. `inflightMatchesPool: pool drift discards the save`
11. `placesFromCursors: reconstructs the skip-adjusted play order exactly`
12. `placesFromCursors: a cursor beyond the order returns null`
13. `saveInflight/clearInflight: storage errors are swallowed`

`tests/ghost.test.js` — routing:

14. `dailyEntryRoute: a partial inflight routes to resume`
15. `dailyEntryRoute: a complete inflight routes to finalize`
16. `dailyEntryRoute: a live duel link outranks a mid-run save`
17. `dailyEntryRoute: a saved result outranks a stale inflight`

`tests/analytics.test.js` — schema:

18. `daily_resumed passes the sanitizer with aggregate properties only`
19. (existing coordinate-shaped-key schema test picks up the new entry
    automatically — verify it runs over `daily_resumed`)

Storage is exercised through fake `{getItem,setItem,removeItem}` objects
(the `loadDailyResult` test pattern) — no real localStorage anywhere in
the suite. The duel-exclusion guard (`no inflight write on a duel or
exhibition run`) lives in glue; its decision inputs are pinned by tests
14–17, and the save-site guard is a one-line condition reviewed, not
unit-tested (consistent with how the repo treats other glue guards).

Gates: `npm test` green, `npm run check` green, both before finishing the
change.

---

## 12. Owner-level decisions flagged (not settled here)

1. **Guess pins ride inside the persisted `run` (§2).** The brief said "no
   coordinates"; this spec keeps the pins because the identical bytes
   already persist in `geoparty_daily_result` at completion
   (owner-approved v2 shape), the slot is device-local and shorter-lived,
   and stripping them makes the post-resume recap and outgoing Ghost Duel
   links lie (pre-reload rounds become pinless/forfeit). **If the owner
   upholds the literal rule:** strip `rounds[i].guess` at save; accept a
   pinless recap for pre-reload rounds; and additionally suppress the
   challenge-link share for resumed runs (an honest plain card beats a
   ghost that forfeits rounds it actually played). Everything else in
   this spec survives that choice unchanged.
2. **One-tap resume instead of silent auto-resume (§7).** A deliberate
   divergence from the brief's stated default, argued from the §4 calm
   rules and the iOS gesture posture. Cheap to flip later (the routing
   and state machinery are identical; auto-resume is "call the resume
   path at boot instead of relabeling the button") — but flip it
   knowingly, not by default.

Settled here, for the record: duels excluded (§5.4 — forced by the
fragment privacy boundary, not a preference); full-clock restart of the
interrupted round (§4 — the threat model line already in daily.js);
cursor+`poolCheck` over replaying the skip loop (§1/§5.3 — exact, offline,
and reuses two tested mechanisms).
