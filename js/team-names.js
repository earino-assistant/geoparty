// team-names.js — geography-pun name bank + this device's recent-team-name
// memory (owner brief: team-name persistence, easy entry, zero-typing pun
// picks). Pure, no DOM, no network — the js/game.js discipline; host-ui.js
// (couch) and player-ui.js (h2h joiner) are the callers. localStorage is
// optional and defensive throughout: private mode / file:// / SSR degrades
// to "nothing remembered", never a throw.

// The owner's curated list of geography puns — used verbatim by "🎲 Surprise
// me". List-agnostic logic (randomPun/suggestTeams) means this can grow freely.
export const GEO_PUNS = Object.freeze([
  "Istanbul Not Constantinople",
  "Kenya Believe It",
  "The Great Wall of Winners",
  "Czech Mates",
  "Czech Yourself",
  "Norway We're Losing",
  "Norway José",
  "Iraq of Lamb",
  "Iran So Far Away",
  "Kuwait for It",
  "Oman, Not Again",
  "Yemen, Right?",
  "India Zone",
  "Cuba Libre-ians",
  "Havana Good Time",
  "Bolivia It or Not",
  "Chile Reception",
  "Peru-sing the Map",
  "Brazil Nuts",
  "Panama Canal-ers",
  "Costa Rica-vering Champs",
  "Jamaican Me Crazy",
  "Haiti to Lose",
  "Bahama Drama",
  "Guyana Win This",
  "Uruguay-ded Missiles",
  "Paraguay-t Team",
  "Ecuador-able",
  "Venezuela-come to Win",
  "Alaska No Questions",
  "Alaska Later",
  "Hawaii You Doing",
  "Idaho, You-daho",
  "Mississippi Queens",
  "Kansas City Shufflers",
  "Ohio Silver",
  "Tennessee What You Did There",
  "Rhode Island Warriors",
  "Maine Attraction",
  "Florida Man Squad",
  "Texas Toast",
  "New Mexico, Same Us",
  "Utah-lly Awesome",
  "Oregon Trailblazers",
  "Nevada Gonna Give You Up",
  "Denali or Nothing",
  "Canada Believe This",
  "Toronto Raptors of the Map",
  "Ottawa-nna Win",
  "Quebec to Basics",
  "Vancouver-t Operations",
  "Greenland Is Actually Ice",
  "Iceland Is Actually Green",
  "Fjord Focus",
  "Finnish Line",
  "Finnish Him",
  "Swede Victory",
  "Danish Pastries",
  "Copenhagen We Win",
  "Dublin Down",
  "Irish You Were Here",
  "Belfast and Furious",
  "Scot Free",
  "Loch and Load",
  "Walesa Minute",
  "London Calling",
  "Big Ben-ders",
  "Thames of Endearment",
  "Paris-ite Hosts",
  "Eiffel for You",
  "Seine-sational",
  "France-tastic",
  "Belgium Waffles",
  "Netherlands Below Sea Level Gang",
  "Amsterdamn Good",
  "Germany Points Do We Get",
  "Berlin It to Win It",
  "Munich Ache",
  "Vienna Waits for Us",
  "Austrian Powers",
  "Swiss Cheese Whizzes",
  "Alps and Downs",
  "Rome If You Want To",
  "When in Rome",
  "Pisa Cake",
  "Venice the Menace",
  "Naples of My Eye",
  "Spain in the Neck",
  "Barcelona Bound",
  "Madrid It Again",
  "Seville-ized Society",
  "Lisbon Around the World",
  "Portugal the Distance",
  "Athens the Odds",
  "Greece Lightning",
  "Crete Expectations",
  "Cyprus Hill",
  "Moscow Mules",
  "Cairo-practors",
  "Nile It Every Time",
]);

export function randomPun(seedOrRng) {
  if (GEO_PUNS.length === 0) return "";
  let idx;
  if (typeof seedOrRng === "function") {
    idx = Math.floor(seedOrRng() * GEO_PUNS.length);
  } else if (typeof seedOrRng === "number") {
    // Deterministic PRNG from a numeric seed. Use splitmix32: an integer-mix
    // scrambler that spreads even tiny consecutive seeds (0,1,2,...) across the
    // full 32-bit range, so each seed lands on a well-separated index in the
    // bank. Robust to any GEO_PUNS length.
    let s = seedOrRng >>> 0;
    const rnd = () => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = (z ^ (z >>> 16)) >>> 0;
      z = Math.imul(z, 0x21f0aaad) >>> 0;
      z = (z ^ (z >>> 15)) >>> 0;
      z = Math.imul(z, 0x735a2d97) >>> 0;
      z = (z ^ (z >>> 15)) >>> 0;
      return z / 0x100000000;
    };
    idx = Math.floor(rnd() * GEO_PUNS.length);
  } else {
    idx = Math.floor(Math.random() * GEO_PUNS.length);
  }
  return GEO_PUNS[idx];
}

const DEFAULT_KEY = "gp_recent_teams";
let _storage = null; // injected by tests via _setStorage

function storage() {
  if (_storage) return _storage;
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch { /* unavailable */ }
  return null;
}
export function _setStorage(s) { _storage = s; }

export function recentTeams(max = 5) {
  const s = storage();
  if (!s) return [];
  try {
    const raw = s.getItem(DEFAULT_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.slice(0, max) : [];
  } catch { return []; }
}

export function rememberTeam(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return recentTeams();
  const cur = recentTeams(10)
    .filter((n) => n.toLowerCase() !== trimmed.toLowerCase());
  cur.unshift(trimmed);
  const next = cur.slice(0, 5);
  const s = storage();
  if (s) {
    try { s.setItem(DEFAULT_KEY, JSON.stringify(next)); } catch { /* no-op */ }
  }
  return next;
}

export function lastTeam() {
  const r = recentTeams(1);
  return r[0] || "";
}

export function suggestTeams(input, limit = 6) {
  const q = String(input || "").trim().toLowerCase();
  if (!q) return [];
  const hits = [];
  const seen = new Set();
  const push = (n) => {
    if (!n) return;
    const k = n.toLowerCase();
    if (!seen.has(k)) { seen.add(k); hits.push(n); }
  };
  for (const n of recentTeams(5)) if (n.toLowerCase().includes(q)) push(n);
  for (const p of GEO_PUNS) if (p.toLowerCase().includes(q)) push(p);
  return hits.slice(0, limit);
}
