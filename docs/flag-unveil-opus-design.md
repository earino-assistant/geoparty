# DESIGN BRIEF — "Flag Unveil" (working title) — from Opus 4.8 (2026-08-23)
*Decision document. Design-only; no repo changes.*

## 1. Game rules

**Round loop.** A flag is revealed progressively across **8 reveal steps** (a tile grid de-occluding + a parallel blur→sharp track; the pure module decides *what* is exposed at step k, the UI decides pixels). One step fires every `stepMs` (default 1500ms) on the **reveal owner's clock** (couch: host; everyone-plays: a designated `revealHost` phone, rotates by round). Players **ring in** at any time. First *correct* ring ends the round; a *wrong* ring **locks that phone out for the round** (its guess and lockout are **private** — no other phone or the TV learns it). Reveal continues past wrong rings until someone is correct or all 8 steps + a 3s grace elapse (round busts, zero points).

**Scoring (earlier = more).** `points = BASE × (STEPS − stepAtRing + 1) / STEPS`, floored at a `MIN`. Ring at step 1 ≈ full BASE; step 8 ≈ MIN. Wrong ring costs nothing but forfeits the round for that phone (opportunity cost). No speed-within-step bonus — the reveal step *is* the clock, which keeps it skew-immune.

**Win condition.** First to `TARGET` points, or highest after `roundCount` flags.

**Couch vs everyone-plays.** Couch: TV shows the reveal, host phone is the buzz-in surface. Everyone-plays: identical, minus the shared TV (each phone renders its own reveal, `revealHost` drives cadence, phones adapt copy on `screenHeartbeat` exactly like today's h2h).

**HARD PRODUCT CONSTRAINT (owner, 2026-08-23): the TV must ALWAYS be connectable, in BOTH modes.** A flag game is fundamentally a "look at the big screen" game — everyone wants to watch the same reveal. So the TV-connected path is the PRIMARY way to play; the "each phone renders its own reveal" path is the fallback for when no TV is available (e.g. remote players). The TV is a first-class, always-available surface, never a couch-only feature.

**Reveal-cadence ownership (design position):** keep the TV a **passive renderer** (it only writes `screenHeartbeat`, as today — no new authority role). A **host phone owns the reveal timer** and writes the current step to RTDB; the TV renders whatever step is current. This preserves GeoParty's write-ownership model (host = sole writer) and means the TV is always connectable simply by subscribing to the room — no special TV logic.

**Host rotation (owner decision, 2026-08-23):** follow the GeoParty model — **whoever wins the previous game (of multiple rounds) becomes the host for the next round.** This is exactly the existing `hostTeam` rotation in h2h mode (`hostTeam` rotates to the winner; see docs/architecture.md). The winner's phone owns the reveal timer for the next game; the TV stays a passive renderer throughout. Simple, no contention, consistent with the established pattern.

## 2. Ring-in adjudication — the new concurrency problem (and the honest answer)

RTDB last-write-wins is the **wrong** primitive for "who was first" — last writer wins, not first. The correct, serverless-authoritative arbiter is an **RTDB transaction (compare-and-set)** on a single per-round path:

```
round/buzz/{roundNumber}  ← transaction: claim only if current value is null
                             writes { team, atStep, clientElapsedMs }
```

The **server** serializes concurrent transactions, so ordering is authoritative and **clock-skew-immune** — no client timestamp adjudicates anything. Simultaneous rings resolve deterministically; the loser's transaction sees a non-null value and aborts client-side into "someone rang first." Correctness of the *guess* is then evaluated by the winner's own phone against embedded `answerIso` and written to its own result subtree.

This is exactly GeoParty's **one existing transactional escape hatch** (`claimTeamSlot`) generalized to per-round. It is the single spot where the disjoint-path ownership model does **not** cover the mechanic.

## 3. Framework-extraction signal (the experiment's point)

**REUSES cleanly** — the reusable kernel holds: phase machine + `canTransition`, ≤4 writes/s throttle, reveal-flip settlement race (identical-shape harmless collision), `screenHeartbeat`/`nextRoom` chain, `roomRef()` choke point, clock-from-`endsAt` discipline, consent/analytics seam.

**BREAKS / must REWRITE** — buzzer arbitration is a genuinely new **contention class**: N phones racing *one* path with *first-wins* semantics. The write-ownership table's rule ("writers never contend on the same path") does **not** extend to it; the transaction primitive does, but it means the extracted kernel must promote transactions from a one-off (`claimTeamSlot`) to a **named, first-class arbitration primitive**. **This is the finding worth extracting:** GeoParty's ownership model is *disjoint-path last-write-wins + one settlement race*; a buzzer game proves the kernel also needs a **claim/arbitration primitive** as a peer concept. Also new: **private per-phone state** (lockout/guess never mirrored live) — GeoParty had *zero* hidden information; the kernel needs an explicit "private subtree, never on the live feed" contract (today only exists implicitly for SUPER SURE arming as *local* state).

## 4. Module seams (pure/glue split preserved)

New pure module **`js/flag.js`** (tested):
- `revealPlan(seed, steps) → [tileOrder…]` (deterministic, seeded like `pool.js`)
- `exposedAt(plan, step) → {tiles, blurPx}`
- `adjudicateBuzz(currentBuzz, claim) → 'won'|'lost'` (pure fold over the transaction snapshot)
- `scoreRing(stepAtRing, steps, base, min) → points`
- `normalizeAnswer(guess, answerIso, aliases) → bool` (alias/spelling tolerance)
- `roundConduct(phase, buzz, results, stepNow) → 'continue'|'flip'|'bust'`
- `carryStandings(...)` for game-over → next room

New glue **`js/flag-ui.js`** (host/player), **`js/screen-flag.js`** (TV). Transaction lives in `firebase.js` as `claimBuzz(code, round, claim)` beside `claimTeamSlot`.

## 5. RTDB model additions

```
rooms/{CODE}
  mode: "flag"
  settings { roundCount, stepMs, base, min, target, difficulty }
  round
    number, flagSeed, answerIso        # embedded at round start (self-scoring, as today)
    startedAt, stepStartedAt           # reveal owner writes cadence
    buzz/{number}                      # TRANSACTION path — first-correct claim
    results/tN { correct, stepAtRing, points, rangOut(bool) }  # own-subtree
    revealAt, autoAdvanceAt            # reuse S6 machine verbatim
  teams/tN { name, total, deviceId }   # claimTeamSlot unchanged
```
Writer table unchanged **except** `round/buzz/{n}` = **any phone via transaction**; `results/tN`, lockout = team's own subtree (private, never on a live feed).

## 6. What must NOT change

- Consent/analytics: aggregates only (`stepAtRing`, points, counts, mode). No answers-as-text, no team names. Extend `EVENT_SCHEMA`; new events `flag_ring`, `flag_round`.
- `roomRef()` remains the sole room choke point; transactions remain the *only* non-`update()` writes.
- Throttle ≤4/s; clocks from `endsAt`/step deltas, never ticked through Firebase.
- Pure/glue split; every feature ships tests + instrumentation (CLAUDE.md).
- Reveal-flip "identical-shape race" invariant must hold for the round-flip.

## 7. The "one distinct game" case — a position

**Flag Unveil is the right stress test — keep it, with one sharpening.** It breaks *two* GeoParty assumptions at once (private information **and** first-wins arbitration), and the arbitration break is precisely the mechanism the current kernel cannot express — maximal signal per unit build. A pure trivia buzzer would test arbitration but not private state; a hidden-role game would test privacy but not buzzing. Flag Unveil hits both while staying tiny (2D static imagery, no MapillaryJS/viewer layer, no imagery-observability subsystem — a large simplification that lets the *sync kernel* be studied in isolation). **Sharpening:** make the buzzer the headline mechanic, not a garnish — if a round can be won without a contested buzz, the experiment learns nothing, so tune `stepMs`/scoring so rings routinely collide.

## 8. Dataset

**flagcdn.com + ISO 3166-1** (public domain flag SVGs) keyed by a bundled static `flags.json` (ISO code, English name, alias list for `normalizeAnswer`). Alternatives: **`mledoze/countries`** (ODbL, rich metadata + names/translations) or **`risenow/annexare-countries`**. Recommendation: bundle `mledoze/countries` names/aliases as static JSON, render flags from flagcdn (or vendor the SVGs for offline/`file://` parity). Do **not** touch GeoParty's `data/`.

*One open decision: wrong ring **private** (recommended — preserves suspense, tests the kernel's hidden-subtree contract) or **public with penalty** (louder party moment, weaker privacy signal)?*
