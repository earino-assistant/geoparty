// supersure.js — pure logic for the SUPER SURE pin (design review §1.6,
// roadmap M6). No DOM, no Firebase — same discipline as game.js / h2h.js.
//
// The mechanic: once per game, a team may mark one pin SUPER SURE — a
// hidden double-or-nothing bet on that round's total (distance + time
// bonus). Closest pin of the round → the bettor banks 2× the round total;
// anyone else strictly closer → 0 for the round (the running total never
// dips below what they already had). Equally-closest super-sure pins ALL
// win — a tie is not "closer". A bet armed with no pin at the buzzer is
// burned: treated as losing → 0. Hidden until the reveal: this module
// resolves outcomes; UI code must never surface `superSure` on an in-play
// path (live pins, lock toasts, rosters, TV panels).
//
// Result rows carry two fields:
//   superSure         true when the pin (or forfeit) spent the bet
//   superSureOutcome  "won" | "lost" | "burned", written at settlement

// Does this team still hold its one bet? Spending is recorded as
// teams/<tid>/superSureUsed = round number: it lives on the team row so it
// survives phone refreshes, and carryTeams() naturally resets it for the
// next game (a new game is a new bet).
export function superSureAvailable(teams, teamId) {
  const t = teams && teams[teamId];
  return !!t && !t.superSureUsed;
}

// Outcome per betting team for a round's complete result set:
// { tid: "won" | "lost" | "burned" } — empty when nobody bet. "Closest"
// compares every real guess in the round; a lone pin (couch solo round)
// is closest by definition.
export function resolveSuperSure(results) {
  const res = results || {};
  const ids = Object.keys(res);
  let best = Infinity;
  for (const id of ids) {
    const r = res[id];
    if (r && r.guess && typeof r.distanceKm === "number" &&
        r.distanceKm < best) {
      best = r.distanceKm;
    }
  }
  const outcomes = {};
  for (const id of ids) {
    const r = res[id];
    if (!r || !r.superSure) continue;
    if (!r.guess) outcomes[id] = "burned";
    else outcomes[id] = r.distanceKm <= best ? "won" : "lost";
  }
  return outcomes;
}

// A result's final round score once its bet (if any) is resolved. Raw
// `points` stays untouched in the result — display and totals go through
// this so old rooms (no superSure fields) render unchanged.
export function adjustedPoints(result) {
  if (!result) return 0;
  const raw = result.points || 0;
  if (!result.superSure) return raw;
  const o = result.superSureOutcome;
  if (o === "won") return raw * 2;
  if (o === "lost" || o === "burned") return 0;
  return raw; // unresolved — only possible before settlement, never rendered
}

/* Settlement for the reveal flip. Raw points are banked into
 * teams/<tid>/total at lock-in (each phone owns its own row); win/lose is
 * only knowable once the set is complete, so the SAME patch that flips the
 * phase to reveal also writes, for every bettor: the outcome marker and
 * the corrected ABSOLUTE total (won: +points again → 2×; lost: −points,
 * restoring exactly the pre-round total; burned: ±0 — a forfeit banked 0).
 * Absolute values keep racing flip writers harmless: multi-path updates
 * are atomic, so any snapshot with the complete result set also has every
 * raw-banked total, and every racer computes identical numbers — the same
 * collision contract as the reveal flip and forfeit sweep. */
export function superSureSettlement(teams, results) {
  const outcomes = resolveSuperSure(results);
  const patch = {};
  for (const id of Object.keys(outcomes)) {
    const o = outcomes[id];
    const raw = (results[id] && results[id].points) || 0;
    const banked = (teams && teams[id] && teams[id].total) || 0;
    const delta = o === "won" ? raw : o === "lost" ? -raw : 0;
    patch[`round/results/${id}/superSureOutcome`] = o;
    patch[`teams/${id}/total`] = banked + delta;
  }
  return { outcomes, patch };
}

// The reveal badge, verbatim from the spec: "SUPER SURE ×2" on a win,
// "SUPER SURE ×0" on a loss or burn (the row/no-pin context distinguishes
// a burned bet from a plain forfeit). Empty for non-bets.
export function superSureLabel(result) {
  if (!result || !result.superSure) return "";
  return result.superSureOutcome === "won" ? "SUPER SURE ×2" : "SUPER SURE ×0";
}
