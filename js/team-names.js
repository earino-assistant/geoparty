// team-names.js — geography-pun name bank + this device's recent-team-name
// memory (owner brief: team-name persistence, easy couch entry, zero-typing
// pun picks). Pure, no DOM, no network — the js/game.js discipline; host-ui.js
// is the only caller. localStorage is optional and defensive throughout:
// private mode / file:// / SSR degrades to "nothing remembered", never a
// throw.
//
// NOTE ON GEO_PUNS: the brief referenced "the owner's 100 puns" but the brief
// text itself only ever named three of them (the first two and the last).
// The full verbatim list was never actually supplied, so the array below is
// a self-authored placeholder of the same size and flavor, opening on
// "Istanbul Not Constantinople" / "Kenya Believe It" and closing on "Nile It
// Every Time" as named. Swap its contents for the owner's real list when
// it's available — every other function here is list-agnostic.

export const GEO_PUNS = Object.freeze([
  "Istanbul Not Constantinople",
  "Kenya Believe It",
  "Czech Yourself Before You Wreck Yourself",
  "Iran Out of Time",
  "Chile Today, Hot Tamale",
  "Norway Jose",
  "Cuba Libre or Die Trying",
  "Wales of a Tale",
  "Turkey Trotters",
  "Greece Is the Word",
  "Seoul Searching",
  "Peru-sing the Map",
  "Bahrain of Thought",
  "Malta Melts for You",
  "Fiji With It",
  "Denmark My Words",
  "Jamaica Me Crazy",
  "Alaska Questions Later",
  "Panama Canal Do It",
  "Team Zealand",
  "Slovenia Way Out",
  "Oman My Gosh",
  "Egypt Us Good",
  "Vietnam-Nam Style",
  "Sahara Point of View",
  "China Shop Bulls",
  "Cairo You Kidding Me",
  "Sicily Me Now",
  "Bali Believe It",
  "Congo Big or Go Home",
  "Ghana Have a Good Time",
  "Tonga the Moon and Back",
  "Bolivia It or Not",
  "Guam Sweet Guam",
  "Belarus Yourself In",
  "Sri Lanka Do Better",
  "Malawi to Success",
  "Yemen There, Done That",
  "Angola Get 'Em",
  "Rwanda Have Fun Tonight",
  "Estonia Explorers",
  "Croatia Good Time",
  "Latvia the Details",
  "Lesotho Much Fun",
  "Serbia Business Only",
  "Gambia On, Let's Go",
  "Botswana Party",
  "Namibia Nice Time",
  "Zambia Zealots",
  "Eritrea-t Yourself",
  "Djibouti-ful Team",
  "Suriname the Game",
  "Comoros or Less",
  "Vanuatu Much Fun",
  "Kiribati or Bust",
  "Grenada Great Time",
  "Dominica-ll Win This",
  "Seychelles Yeah",
  "Monaco My Way",
  "Liechtenstein of Champions",
  "San Marino Solo",
  "Andorra Adventure",
  "Brunei of Champions",
  "Qatar-tine and Chill",
  "Bahrain-storm Squad",
  "Oman-azing Team",
  "Baghdad to the Bone",
  "Tehran of Thought",
  "Beirut Force",
  "Amman Up",
  "Doha or Nothing",
  "Riyadh the Storm",
  "Muscat of Champions",
  "Budapest of Both Worlds",
  "Praha-bly Gonna Win",
  "Vienna Sausage Squad",
  "Athens to Victory",
  "Dublin Down on Fun",
  "Oslo Down, Team's Fast",
  "Helsinki-y Business",
  "Zagreb This Trophy",
  "Ljubljana Long Way",
  "Bratislava La Vista",
  "Sarajevo Kidding",
  "Skopje Out",
  "Tirana Kind of Team",
  "Podgorica Great",
  "Chisinau Way to Win",
  "Minsk-onceivable Squad",
  "Kyiv Us a Chance",
  "Vilnius the Team",
  "Tallinn Us Apart",
  "Riga-morole Squad",
  "Reykjavik and Roll",
  "Nuuk-ing Around",
  "Wellington Boots On",
  "Canberra Careful",
  "Jakarta Special",
  "Manila Envelope Squad",
  "Nile It Every Time",
]);

const RECENT_KEY = "gp_recent_teams";
const RECENT_MAX = 5;

function defaultStorage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null; // blocked (private mode / sandboxed) — read as unavailable
  }
}

let storage = defaultStorage();

// Test-only seam: swap in a fake localStorage-shaped object ({getItem,
// setItem}), or null to simulate one being unavailable. Never called from
// production code.
export function _setStorage(s) {
  storage = s;
}

function readRecent() {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(RECENT_KEY));
    return Array.isArray(parsed) ? parsed.filter((n) => typeof n === "string" && n) : [];
  } catch {
    return []; // unparsable/tampered — a fresh device, not a crash
  }
}

function writeRecent(list) {
  if (!storage) return;
  try {
    storage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* private mode / quota — this session just isn't remembered */
  }
}

// Most-recent-first, capped at `max`.
export function recentTeams(max = RECENT_MAX) {
  return readRecent().slice(0, max);
}

// Add a name to the front of the recent list (case-insensitive dedupe),
// capped at RECENT_MAX, persisted. Returns the updated (already-capped) list.
export function rememberTeam(name) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) return readRecent();
  const lower = trimmed.toLowerCase();
  const rest = readRecent().filter((n) => n.toLowerCase() !== lower);
  const list = [trimmed, ...rest].slice(0, RECENT_MAX);
  writeRecent(list);
  return list;
}

// The most recently used team name, for pre-filling the input — "" when the
// device has never remembered one.
export function lastTeam() {
  return readRecent()[0] || "";
}

// Deterministic small PRNG (mulberry32) so a numeric seed reproduces the same
// sequence across runs/platforms — Math.random() gives no such guarantee.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A random pun. `seedOrRng` is optional: a number seeds a deterministic PRNG
// (for tests), a function is used directly as the rng (must return [0,1)),
// and omitting it draws from Math.random().
export function randomPun(seedOrRng) {
  let rng;
  if (typeof seedOrRng === "function") rng = seedOrRng;
  else if (typeof seedOrRng === "number") rng = mulberry32(seedOrRng);
  else rng = Math.random;
  const i = Math.min(GEO_PUNS.length - 1, Math.floor(rng() * GEO_PUNS.length));
  return GEO_PUNS[i];
}

// Type-ahead matches for `input`: recent team names first, then puns, both
// case-insensitive substring matches, deduped (case-insensitive), capped at
// `limit`. Suggestions only make sense while typing — an empty/blank input
// returns no suggestions rather than "everything".
export function suggestTeams(input, limit = 6) {
  const q = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (!q) return [];
  const seen = new Set();
  const out = [];
  const add = (name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(name);
  };
  for (const n of readRecent()) {
    if (out.length >= limit) break;
    if (n.toLowerCase().includes(q)) add(n);
  }
  for (const p of GEO_PUNS) {
    if (out.length >= limit) break;
    if (p.toLowerCase().includes(q)) add(p);
  }
  return out.slice(0, limit);
}
