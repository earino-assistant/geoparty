// couchscreen.js — pure S7 logic: couch without a TV (design review §1.2,
// roadmap S7 — "the last hard device-gate in the product"). Head-to-head
// already treats the screen as optional; this module gives couch the same
// trick: when no screen is live, the HOST PHONE becomes the shared display
// (reveal map, standings, showdown pins, crown), and "Start Round" never
// waits for a heartbeat. No DOM, no network — the browser glue lives in
// host-ui.js.

import { SCREEN_STALE_MS, revealPins } from "./h2h.js";
import { standings } from "./game.js";

/* ================================================================
 * Screen liveness — fold heartbeat callbacks into a skew-proof state
 * ================================================================ */

/* The TV writes screenHeartbeat with ITS OWN clock every 10s; comparing
 * that value against the host phone's clock would make a merely-skewed TV
 * look dead. So liveness is stamped on RECEIPT (the host's local clock),
 * with one guard: (re)subscribing replays the path's last value, which may
 * be the final beat of a screen that died long ago — a beat that ancient on
 * the writer's clock is ignored rather than stamped fresh. The threshold
 * matches the 5-minute client-skew allowance the rules already grant
 * createdAt, so no honestly-skewed TV can trip it. */
export const HEARTBEAT_ANCIENT_MS = 300_000;

// Fold one subscribeHeartbeat callback (ts = the TV-clock value, or null)
// into the previous liveness state. Returns { ts, seenAt } or null.
export function foldHeartbeat(prev, ts, now) {
  if (typeof ts !== "number") return prev;      // no beat yet / room cleared
  if (prev && prev.ts === ts) return prev;      // replay of a beat we hold
  if (now - ts > HEARTBEAT_ANCIENT_MS) return prev; // a dead screen's last beat
  return { ts, seenAt: now };
}

// A screen is live while beats keep arriving — same freshness window as
// h2h's screenAttached, measured on the receiving clock.
export function screenLive(beat, now) {
  return !!beat && now - beat.seenAt < SCREEN_STALE_MS;
}

// The S7 rule in one name: with no live screen, the host phone IS the
// shared display. Evaluated at each render decision point, so a TV that
// detaches mid-game hands the reveal to the phone at the next reveal, and
// one that attaches mid-game takes it back.
export function phoneIsScreen(beat, now) {
  return !screenLive(beat, now);
}

/* ================================================================
 * Lobby readiness — the hard gate, removed
 * ================================================================ */

// What the couch lobby says above Start Round. canStart is true in EVERY
// state — that is S7: the screen is an optional accessory, never a gate
// (a test enforces this for the full input space). `ok` drives the green
// "ready" styling.
export function lobbyReadiness(live, connected) {
  if (live) {
    return {
      canStart: true, ok: true,
      note: "TV connected ✓",
    };
  }
  if (!connected) {
    // Degraded single-screen mode (spec §12): the party survives offline.
    return {
      canStart: true, ok: false,
      note: "Offline — you can play on this phone alone.",
    };
  }
  return {
    canStart: true, ok: false,
    // §6.3: one line. "Add a TV anytime" was the fourth simultaneous
    // explanation of an optional accessory; the collapsed "📺 Put it on a
    // TV" module below it now says that by existing.
    note: "No TV? No problem — the reveal shows right here.",
  };
}

/* ================================================================
 * Phone-as-screen content: reveal pins and the crown
 * ================================================================ */

// Pins for the host phone's reveal map, normalized across the two couch
// round shapes: solo rounds carry one pin on round.guess/round.score,
// showdowns carry everyone's on round.results (the h2h shape, so the
// shared farthest-first draw order applies). SUPER SURE verdicts ride
// along — the reveal is the one surface where the bet is visible.
export function couchRevealPins(round, activeTeam) {
  if (!round || !round.truth) return [];
  if (round.showdown) return revealPins(round);
  const guess = round.guess;
  if (!guess || typeof guess.lat !== "number" || typeof guess.lng !== "number") {
    return [];
  }
  const score = round.score || {};
  return [{
    id: activeTeam,
    lat: guess.lat,
    lng: guess.lng,
    distanceKm: score.distanceKm,
    superSure: !!score.superSure,
    superSureOutcome: score.superSureOutcome || null,
  }];
}

// Game-over crown for the phone-as-screen surface: with no TV podium, the
// host phone names the winner itself. Single-team (co-op) games have no
// rivalry to crown — null keeps the plain standings heading. Ties show the
// first-ranked team, matching the TV podium's ordering.
export function crownLine(teams) {
  const ranked = standings(teams);
  if (ranked.length < 2) return null;
  return `👑 ${ranked[0].name} wins!`;
}
