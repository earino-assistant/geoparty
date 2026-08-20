// ghost.js — Ghost Duel codec + duel logic (G5, spec §3.5). No DOM, no
// network — the js/game.js discipline. A Ghost Duel rides entirely in a URL
// *fragment* (never a query string, never a server): the sender's own five
// Daily guesses + timings, base64url-encoded, person-to-person. The recipient
// plays the same five and the ghost's pin lands at every reveal.
//
// PRIVACY (CLAUDE.md "Daily Ghost Duel links"): the payload carries ONLY the
// challenger's own guesses/timings — no name, no score, no identity, no truth
// location, no Mapillary image id. Scores are RECOMPUTED by the recipient from
// pins + times with the same pure scorers, so a link can never claim a score
// its pins didn't earn. decode is TOTAL: any input → {ok}|{error}, never throws.

import { haversineKm, scoreForDistance, timeBonus, bonusWindowMs } from "./game.js";
import { dailyRoundSeconds, DAILY_ROUNDS } from "./daily.js";

export const GHOST_VERSION = 1;
export const GHOST_FRAGMENT_KEY = "g";

// Fixed byte layout (spec §3.5.1). 53 bytes → 71–72 base64url chars.
const PAYLOAD_BYTES = 3 + 3 + (DAILY_ROUNDS * 9) + 2;   // = 53 for 5 rounds
const ROUND_OFFSET = 6;
const ELAPSED_DECISECONDS_MAX = 6000;   // uint16, deciseconds (10 min ceiling)
const U24_MAX = 0xffffff;

// Length budget, test-enforced (§3.5.1): short enough that no messenger
// truncates it and the paste stays legible.
export const MAX_FRAGMENT_CHARS = 100;
export const MAX_URL_CHARS = 200;

/* ================================================================
 * base64url over byte arrays (no atob/DOM dependency — Node runs it natively)
 * ================================================================ */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_INV = (() => {
  const inv = {};
  for (let i = 0; i < B64.length; i++) inv[B64[i]] = i;
  return inv;
})();

function bytesToBase64url(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) out += B64[((b1 & 15) << 2) | (b2 >> 6)];
    if (i + 2 < bytes.length) out += B64[b2 & 63];
  }
  return out;
}

// Returns a Uint8Array, or null when any character is not base64url (the
// codec's first line of defence — malformed input can never throw).
function base64urlToBytes(str) {
  if (typeof str !== "string" || str.length === 0) return null;
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of str) {
    const val = B64_INV[ch];
    if (val === undefined) return null;
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/* ================================================================
 * FNV-1a-32 checksums, folded to 16 bits (integrity, not crypto)
 * ================================================================ */

function fnv1a32Bytes(bytes, end) {
  let h = 2166136261;
  const n = end === undefined ? bytes.length : end;
  for (let i = 0; i < n; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function fnv1a32Str(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function fold16(h) {
  return ((h >>> 16) ^ (h & 0xffff)) & 0xffff;
}

// The pool integrity check: FNV-1a-32 of the day's five image_ids joined with
// commas, folded to 16 bits. Catches a link built on a since-changed Daily
// (the graceful "playing without the ghost" degrade, §3.5.1). Never leaves the
// device — it is a 16-bit hash of ids, and the ids themselves never travel.
export function poolCheck(imageIds) {
  return fold16(fnv1a32Str((imageIds || []).join(",")));
}

function clampU24(v) {
  return Math.max(0, Math.min(U24_MAX, Math.round(v)));
}

/* ================================================================
 * Encode (spec §3.5.1)
 * ================================================================ */

// rounds: up to DAILY_ROUNDS of { pinned, lat, lng, elapsedMs }. Missing/extra
// rounds are padded/truncated to exactly DAILY_ROUNDS forfeits.
export function encodeGhost({ dayNumber, hard, poolCheck: pc, rounds }) {
  const bytes = new Uint8Array(PAYLOAD_BYTES);
  bytes[0] = GHOST_VERSION & 0xff;
  bytes[1] = dayNumber & 0xff;
  bytes[2] = (dayNumber >> 8) & 0xff;
  bytes[3] = hard ? 1 : 0;
  bytes[4] = pc & 0xff;
  bytes[5] = (pc >> 8) & 0xff;
  for (let r = 0; r < DAILY_ROUNDS; r++) {
    const off = ROUND_OFFSET + r * 9;
    const rr = (rounds && rounds[r]) || null;
    const pinned = !!(rr && rr.pinned && typeof rr.lat === "number" &&
      typeof rr.lng === "number");
    bytes[off] = pinned ? 1 : 0;
    const latQ = pinned ? clampU24((rr.lat + 90) * 10000) : 0;
    const lngQ = pinned ? clampU24((rr.lng + 180) * 10000) : 0;
    bytes[off + 1] = (latQ >> 16) & 0xff;
    bytes[off + 2] = (latQ >> 8) & 0xff;
    bytes[off + 3] = latQ & 0xff;
    bytes[off + 4] = (lngQ >> 16) & 0xff;
    bytes[off + 5] = (lngQ >> 8) & 0xff;
    bytes[off + 6] = lngQ & 0xff;
    const ds = rr ? Math.max(0, Math.min(ELAPSED_DECISECONDS_MAX,
      Math.round((rr.elapsedMs || 0) / 100))) : 0;
    bytes[off + 7] = ds & 0xff;
    bytes[off + 8] = (ds >> 8) & 0xff;
  }
  const cs = fold16(fnv1a32Bytes(bytes, PAYLOAD_BYTES - 2));
  bytes[PAYLOAD_BYTES - 2] = cs & 0xff;
  bytes[PAYLOAD_BYTES - 1] = (cs >> 8) & 0xff;
  return bytesToBase64url(bytes);
}

// Build a ghost payload straight from a saved/finished daily run + the day's
// five image_ids. rounds without a stored pin (v1 saves, forfeits) encode as
// forfeits — the comparison still works on points (§3.5.2 case 5).
export function buildGhostPayload(run, imageIds, dayNumber) {
  const rounds = ((run && run.rounds) || []).map((r) => ({
    pinned: !!(r.guess && typeof r.guess.lat === "number"),
    lat: r.guess ? r.guess.lat : null,
    lng: r.guess ? r.guess.lng : null,
    elapsedMs: r.elapsedMs || 0,
  }));
  return encodeGhost({
    dayNumber,
    hard: !!(run && run.hard),
    poolCheck: poolCheck(imageIds),
    rounds,
  });
}

/* ================================================================
 * Decode — total, never throws (spec §3.5.1 failure table)
 * ================================================================ */

export function decodeGhost(payload) {
  const bytes = base64urlToBytes(payload);
  if (!bytes || bytes.length !== PAYLOAD_BYTES) return { error: "malformed" };
  const cs = bytes[PAYLOAD_BYTES - 2] | (bytes[PAYLOAD_BYTES - 1] << 8);
  if (cs !== fold16(fnv1a32Bytes(bytes, PAYLOAD_BYTES - 2))) {
    return { error: "malformed" };   // truncation / copy-paste damage / bit flip
  }
  if (bytes[0] !== GHOST_VERSION) return { error: "version" };
  const dayNumber = bytes[1] | (bytes[2] << 8);
  const hard = !!(bytes[3] & 1);
  const pc = bytes[4] | (bytes[5] << 8);
  const rounds = [];
  for (let r = 0; r < DAILY_ROUNDS; r++) {
    const off = ROUND_OFFSET + r * 9;
    const pinned = !!(bytes[off] & 1);
    const latQ = (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3];
    const lngQ = (bytes[off + 4] << 16) | (bytes[off + 5] << 8) | bytes[off + 6];
    const ds = bytes[off + 7] | (bytes[off + 8] << 8);
    rounds.push(pinned
      ? { pinned: true, lat: latQ / 10000 - 90, lng: lngQ / 10000 - 180, elapsedMs: ds * 100 }
      : { pinned: false, lat: null, lng: null, elapsedMs: ds * 100 });
  }
  return { ok: true, version: GHOST_VERSION, dayNumber, hard, poolCheck: pc, rounds };
}

// Day-window check (spec §3.5.1): a sender in Auckland shares #37 while the
// recipient's Chicago evening is still #36 — a ±1 window covers the timezone
// gap. Outside it, the challenge is "expired" and the recipient plays their own
// fresh daily.
export function ghostExpired(dayNumber, todayNumber) {
  return Math.abs(dayNumber - todayNumber) > 1;
}

// After loading the challenge day's five entries, does its pool still match?
export function poolMatches(decodedPoolCheck, imageIds) {
  return decodedPoolCheck === poolCheck(imageIds);
}

/* ================================================================
 * Score recomputation + duel fold (spec §3.5.3–3.5.4)
 * ================================================================ */

// The ghost's per-round result, recomputed on THIS device from its pin + time
// against the day's truths — the integrity posture: no score is trusted from
// the wire. truths: [{lat,lng}] for the day's five. Returns per round
// { pinned, distanceKm, points }.
export function ghostScores(truths, decoded) {
  const hard = !!(decoded && decoded.hard);
  const windowMs = bonusWindowMs(dailyRoundSeconds(hard));
  return (decoded.rounds || []).map((r, i) => {
    const truth = truths && truths[i];
    if (!r.pinned || !truth || typeof truth.lat !== "number") {
      return { pinned: false, distanceKm: null, points: 0 };
    }
    const km = haversineKm(truth.lat, truth.lng, r.lat, r.lng);
    const dp = scoreForDistance(km);
    const bonus = timeBonus(dp, r.elapsedMs, windowMs);
    return { pinned: true, distanceKm: km, points: dp + bonus };
  });
}

// Per-round comparison + verdict (spec §3.5.4). yourPoints / ghostPoints are
// per-round point arrays; margin is a plain score difference — the same class
// of aggregate as winning_score, and the ONLY duel number analytics may see.
export function duelVerdict(yourPoints, ghostPoints) {
  const n = Math.max(yourPoints.length, ghostPoints.length);
  const rows = [];
  let yourTotal = 0;
  let ghostTotal = 0;
  for (let i = 0; i < n; i++) {
    const you = yourPoints[i] || 0;
    const ghost = ghostPoints[i] || 0;
    yourTotal += you;
    ghostTotal += ghost;
    rows.push({ you, ghost, winner: you > ghost ? "you" : ghost > you ? "ghost" : "tie" });
  }
  const outcome = yourTotal > ghostTotal ? "won"
    : ghostTotal > yourTotal ? "lost" : "tie";
  return { yourTotal, ghostTotal, outcome, margin: Math.abs(yourTotal - ghostTotal), rows };
}

/* ================================================================
 * Fragment plumbing (the transport). The fragment is parsed then STRIPPED by
 * the UI before analytics init (§3.5.6); these are the pure string helpers.
 * ================================================================ */

// Extract the payload from a location hash ("#g=XXXX" or "g=XXXX&..."), or null.
export function parseGhostFragment(hash) {
  const h = String(hash || "").replace(/^#/, "");
  const m = new RegExp(`(?:^|&)${GHOST_FRAGMENT_KEY}=([A-Za-z0-9\\-_]+)`).exec(h);
  return m ? m[1] : null;
}

// The fragment string (without the leading '#').
export function ghostFragment(payload) {
  return `${GHOST_FRAGMENT_KEY}=${payload}`;
}

// Append a ghost payload to an (already UTM-tagged) URL as a fragment. The
// payload rides the fragment ONLY — never the query string.
export function appendGhostFragment(url, payload) {
  const base = String(url).split("#")[0];
  return `${base}#${ghostFragment(payload)}`;
}
