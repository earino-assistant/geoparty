// autoadvance.js — pure soft auto-advance logic (roadmap S6). No DOM, no
// Firebase in here.
//
// The problem: between rounds only the host device can advance past the
// reveal, so everyone else stares at "X starts the next round…" while the
// host chats. The fix is a SOFT auto-advance: the reveal-flip write stamps
// round/autoAdvanceAt (ms epoch, same shared-deadline pattern as endsAt /
// revealAt — every surface renders `autoAdvanceAt − Date.now()` on its own
// clock), every surface shows the countdown, and the HOST device alone
// fires the advance when the deadline lands. The host stays in charge both
// ways: advancing early (the existing Next Round button) or writing
// autoAdvanceAt = null to hold the room open — that's the "soft".

// Default countdown, measured from the moment the reveal is VISIBLE (couch:
// the reveal write itself; h2h: revealAt, after the 3-2-1). 15s covers the
// TV's line-drawing animation (~1s per team) plus reading the result rows,
// while keeping the between-round gap inside one social beat. Hosts who
// want to talk about the reveal hold; the hold event's seconds_left tells
// us if this number is wrong.
export const AUTO_ADVANCE_MS = 15_000;

// A deadline found already expired by more than this is LAPSED, not due:
// a host phone resuming into an old reveal (refresh, backgrounded tab)
// must not yank the whole room into a round nobody expects. Within the
// window, a briefly-suspended host tab still fires the advance it owed.
export const AUTO_ADVANCE_LAPSE_MS = 10_000;

// The patch the reveal-flip writer merges in. Racing h2h flip writers pass
// revealAt values milliseconds apart, so colliding stamps are identical in
// shape — the same accepted collision as revealAt itself.
export function autoAdvancePatch(revealShownAt) {
  return { "round/autoAdvanceAt": revealShownAt + AUTO_ADVANCE_MS };
}

// The host's hold: null the deadline, room stays open until a manual tap.
// There is deliberately no "resume countdown" — a held reveal is host-paced.
export function holdAdvancePatch() {
  return { "round/autoAdvanceAt": null };
}

/* Countdown state for one reveal, from the shared stamp and a local clock:
 *   held     — no deadline (host held it, or a pre-S6 room): show the
 *              classic waiting copy, never fire.
 *   counting — deadline ahead: show the countdown.
 *   due      — deadline passed within the lapse window: the host device
 *              fires the advance; other surfaces show "starting…".
 *   lapsed   — deadline long gone (resume, or the host device died before
 *              firing): behave exactly like held.
 */
export function autoAdvanceStatus(autoAdvanceAt, now) {
  if (!Number.isFinite(autoAdvanceAt)) return { state: "held", msLeft: 0 };
  const msLeft = autoAdvanceAt - now;
  if (msLeft > 0) return { state: "counting", msLeft };
  if (-msLeft <= AUTO_ADVANCE_LAPSE_MS) return { state: "due", msLeft: 0 };
  return { state: "lapsed", msLeft: 0 };
}

// Should THIS device push the advance right now? Host authority only (the
// same device that owns manual advance in both modes), reveal phase only,
// and only while the deadline is due — a lapsed one waits for the human.
export function shouldAutoAdvance({ phase, autoAdvanceAt, isHost, now }) {
  if (!isHost || phase !== "reveal") return false;
  return autoAdvanceStatus(autoAdvanceAt, now).state === "due";
}

// Where the advance lands. The final reveal's countdown must resolve to the
// scoreboard (gameOver), never force a new game — the next-game / Daily
// entry lives on that screen and stays a human choice.
export function advanceTarget(roundNumber, roundCount) {
  return roundNumber >= roundCount ? "gameOver" : "round";
}

export function advanceSecondsLeft(msLeft) {
  return Math.max(0, Math.ceil(msLeft / 1000));
}

// The one countdown line every surface shows (phones, both TVs). "due" gets
// the starting copy so a dead host device shows an honest transient state
// until the lapse window demotes it to the waiting copy.
export function countdownText(status, target) {
  if (status.state === "counting") {
    const s = advanceSecondsLeft(status.msLeft);
    return target === "gameOver"
      ? `Final scores in ${s}…`
      : `Next round in ${s}…`;
  }
  if (status.state === "due") {
    return target === "gameOver" ? "Final scores…" : "Starting the next round…";
  }
  return null; // held / lapsed: callers fall back to their waiting copy
}
