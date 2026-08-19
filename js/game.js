// game.js — shared game logic: state machine, scoring, round math.
// Used by both host-ui.js and screen-ui.js. No DOM, no Firebase in here.

export const PHASES = ["lobby", "roundActive", "guessing", "reveal", "gameOver"];

// Legal transitions, driven exclusively by host writes (spec §7).
const TRANSITIONS = {
  lobby: ["roundActive"],
  roundActive: ["guessing"],
  guessing: ["reveal"],
  reveal: ["roundActive", "gameOver"],
  gameOver: ["lobby"],
};

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

// Room codes: 4 uppercase letters, no I or O (spec §4).
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";

export function makeRoomCode() {
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

export function isValidRoomCode(code) {
  return /^[A-HJ-NP-Z]{4}$/.test(code);
}

// Great-circle distance in km, haversine (spec §8).
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// GeoGuessr-style exponential decay: 5000 at zero, ~1800 at 1500km.
export function scoreForDistance(km) {
  return Math.round(5000 * Math.exp(-km / 1492));
}

// One decimal under 100km, integer km above (spec §8).
export function formatDistance(km) {
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString()} km`;
}

export function formatCountdown(msLeft) {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

// Teams are stored as {t1: {...}, t2: {...}}; stable ordering by key.
export function teamIds(teams) {
  return Object.keys(teams || {}).sort();
}

// Rotate activeTeam each round when more than one team (spec §4).
export function teamForRound(teams, roundNumber) {
  const ids = teamIds(teams);
  if (ids.length === 0) return null;
  return ids[(roundNumber - 1) % ids.length];
}

export function defaultTeams() {
  return { t1: { name: "Everyone", total: 0 } };
}

export function initialRoomState(settings, teams) {
  return {
    createdAt: Date.now(),
    phase: "lobby",
    settings,
    round: null,
    teams,
    activeTeam: teamIds(teams)[0],
    poolCursor: 0,
    screenHeartbeat: null,
  };
}

// Standings sorted best-first for reveal scoreboard / podium.
export function standings(teams) {
  return teamIds(teams).map((id) => ({ id, ...teams[id] }))
    .sort((a, b) => b.total - a.total);
}
