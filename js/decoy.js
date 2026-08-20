// decoy.js — Decoy Pin logic (G7, spec §3.7). No DOM, no Firebase. H2H only.
// Once per game per team (mirroring SUPER SURE's economy — decoyUsed is
// superSureUsed's sibling), a team may plant a decoy: rivals' live view shows
// the decoy where a live pin would be, while the real pin is placed unseen. At
// the reveal the decoy is exposed with a 🎭 beat before the real pins land.
//
// Hidden-information rule (the SUPER SURE inviolable): nothing on any in-play
// surface reveals that a pin is a decoy — the live feed carries the decoy coords
// as an ordinary pin, indistinguishable by construction. A test enforces the
// live-surface absence the same way the SUPER SURE tests do.

// Does this team still hold its one decoy, and is a decoy meaningful this round?
// False when spent (decoyUsed set — survives refresh like superSureUsed), and
// false during a Blind Duel (rival pins are hidden, so a decoy is noise; the
// chip hides and the spend is preserved, §3.7).
export function decoyAvailable(teams, teamId, twistId) {
  const t = teams && teams[teamId];
  if (!t || t.decoyUsed) return false;
  if (twistId === "blind") return false;
  return true;
}

// The guess-map deploy state machine (pure). state = { armed, planted }.
//  - "arm"  (the sheet's "Plant the decoy"): next map tap places the decoy.
//  - "tap"  on the map: while armed and not yet planted → place the DECOY and
//           mark planted; every tap after → place/move the REAL pin as normal.
// Returns { state, place } where place is "decoy" | "pin" | null.
export function decoyInitialState() {
  return { armed: false, planted: false };
}

export function decoyDeployFold(state, action) {
  const s = state || decoyInitialState();
  if (action === "arm") {
    return { state: { armed: true, planted: false }, place: null };
  }
  if (action === "tap") {
    if (s.armed && !s.planted) {
      return { state: { armed: true, planted: true }, place: "decoy" };
    }
    return { state: s, place: "pin" };
  }
  return { state: s, place: null };
}

// The lock button stays disabled until a REAL pin exists (unchanged behavior);
// a planted decoy alone is not a lockable guess.
export function canLockWithDecoy(hasRealPin) {
  return !!hasRealPin;
}

/* ================================================================
 * Reveal exposure (pure rendering from round/results — no reveal-time write)
 * ================================================================ */

// The decoy a team planted this round, or null. Read from the team's own
// lock-in patch (round/results/tN/decoy), same accepted pre-reveal-readable
// posture as the embedded truth and the bet.
export function plantedDecoy(round, teamId) {
  const r = round && round.results && round.results[teamId];
  const d = r && r.decoy;
  return d && typeof d.lat === "number" && typeof d.lng === "number"
    ? { lat: d.lat, lng: d.lng } : null;
}

// Every planted decoy, for the farthest-first cascade's 🎭 beat (before the
// real pins). [{ id, lat, lng }].
export function revealDecoys(round) {
  const results = (round && round.results) || {};
  const out = [];
  for (const id of Object.keys(results).sort()) {
    const d = plantedDecoy(round, id);
    if (d) out.push({ id, lat: d.lat, lng: d.lng });
  }
  return out;
}

// The roster/board line for the planter gains "🎭 decoy" once per game — the
// table needs to know who played whom (reveal-only).
export function teamPlantedDecoy(round, teamId) {
  return !!plantedDecoy(round, teamId);
}
