// Tests for js/ghost.js — the Ghost Duel codec + duel logic (G5, spec §3.5,
// §6.1). Round-trip fuzz, hostile inputs, the length budget, score
// reproduction, the day window, the pool check, and the verdict fold.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GHOST_VERSION,
  MAX_FRAGMENT_CHARS,
  MAX_URL_CHARS,
  poolCheck,
  encodeGhost,
  buildGhostPayload,
  runHasPins,
  decodeGhost,
  ghostExpired,
  poolMatches,
  ghostScores,
  duelVerdict,
  parseGhostFragment,
  ghostFragment,
  appendGhostFragment,
} from "../js/ghost.js";
import { mulberry32, hashSeed } from "../js/pool.js";
import {
  haversineKm, scoreForDistance, timeBonus, bonusWindowMs,
} from "../js/game.js";
import { dailyRoundSeconds } from "../js/daily.js";

// A seeded fuzz run: five rounds, random pins/timings, deterministic per seed.
function fuzzRun(seed, hard = false) {
  const rand = mulberry32(hashSeed(`ghost:${seed}`));
  const rounds = [];
  for (let i = 0; i < 5; i++) {
    const pinned = rand() > 0.15;   // mostly pinned, some forfeits
    rounds.push({
      pinned,
      lat: pinned ? rand() * 180 - 90 : null,
      lng: pinned ? rand() * 360 - 180 : null,
      elapsedMs: Math.floor(rand() * 60000),
    });
  }
  return { dayNumber: 1 + Math.floor(rand() * 60000), hard, poolCheck: 0, rounds };
}

/* ---------------- round-trip property (quantized) ---------------- */

test("decode(encode(run)) ≡ quantized(run) over 1000 seeded runs", () => {
  for (let s = 0; s < 1000; s++) {
    const run = fuzzRun(s, s % 2 === 0);
    const decoded = decodeGhost(encodeGhost(run));
    assert.equal(decoded.ok, true);
    assert.equal(decoded.version, GHOST_VERSION);
    assert.equal(decoded.dayNumber, run.dayNumber & 0xffff);
    assert.equal(decoded.hard, run.hard);
    for (let i = 0; i < 5; i++) {
      const a = run.rounds[i];
      const b = decoded.rounds[i];
      assert.equal(b.pinned, a.pinned);
      const ds = Math.min(6000, Math.round(a.elapsedMs / 100));
      assert.equal(b.elapsedMs, ds * 100);
      if (a.pinned) {
        // ~11 m quantization: reconstructed within a quantum of the input.
        assert.ok(Math.abs(b.lat - a.lat) <= 0.0001 + 1e-9);
        assert.ok(Math.abs(b.lng - a.lng) <= 0.0001 + 1e-9);
      } else {
        assert.equal(b.lat, null);
      }
    }
  }
});

test("poles and antimeridian survive exactly", () => {
  const run = {
    dayNumber: 37, hard: false, poolCheck: 0,
    rounds: [
      { pinned: true, lat: 90, lng: 180, elapsedMs: 0 },
      { pinned: true, lat: -90, lng: -180, elapsedMs: 60000 },
      { pinned: true, lat: 0, lng: 0, elapsedMs: 1234 },
      { pinned: false, lat: null, lng: null, elapsedMs: 0 },
      { pinned: true, lat: 89.9999, lng: -179.9999, elapsedMs: 100 },
    ],
  };
  const d = decodeGhost(encodeGhost(run));
  assert.equal(d.rounds[0].lat, 90);
  assert.equal(d.rounds[0].lng, 180);
  assert.equal(d.rounds[1].lat, -90);
  assert.equal(d.rounds[1].lng, -180);
  assert.equal(d.rounds[2].lat, 0);
});

test("elapsed clamps to the 600s (uint16 deciseconds) ceiling", () => {
  const run = {
    dayNumber: 1, hard: false, poolCheck: 0,
    rounds: [{ pinned: true, lat: 10, lng: 20, elapsedMs: 9_000_000 }],
  };
  const d = decodeGhost(encodeGhost(run));
  assert.equal(d.rounds[0].elapsedMs, 600000);   // 6000 ds × 100
});

/* ---------------- hostile inputs (decode is total) ---------------- */

test("decode: garbage, empty, huge, and wrong-length inputs → malformed", () => {
  assert.deepEqual(decodeGhost(""), { error: "malformed" });
  assert.deepEqual(decodeGhost(null), { error: "malformed" });
  assert.deepEqual(decodeGhost("!!!not base64!!!"), { error: "malformed" });
  assert.deepEqual(decodeGhost("AAAA"), { error: "malformed" });       // too short
  assert.deepEqual(decodeGhost("A".repeat(5000)), { error: "malformed" });
  // A '+' or '/' is base64 but NOT base64url → rejected.
  assert.deepEqual(decodeGhost("AB+CD/EF"), { error: "malformed" });
});

test("decode: truncation at every byte boundary → malformed (never throws)", () => {
  const payload = encodeGhost(fuzzRun(42));
  for (let cut = 1; cut < payload.length; cut++) {
    const r = decodeGhost(payload.slice(0, cut));
    assert.ok(r.error, `truncation at ${cut} should not decode`);
  }
});

test("decode: a single bit flip is caught by the checksum", () => {
  const payload = encodeGhost(fuzzRun(7));
  let caught = 0;
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  for (let i = 0; i < payload.length; i++) {
    const orig = payload[i];
    const alt = chars[(chars.indexOf(orig) + 1) % chars.length];
    const r = decodeGhost(payload.slice(0, i) + alt + payload.slice(i + 1));
    // Either malformed, or a valid-but-different decode; never a throw, and the
    // vast majority are rejected by the checksum.
    if (r.error) caught++;
  }
  assert.ok(caught > payload.length * 0.9, "checksum should reject most flips");
});

test("decode: an unknown version reads as {error:'version'}", () => {
  const payload = encodeGhost(fuzzRun(3));
  // Flip the version byte to 2 and re-checksum so it passes integrity.
  const bytes = bytesFromB64url(payload);
  bytes[0] = 2;
  refreshChecksum(bytes);
  assert.deepEqual(decodeGhost(b64urlFromBytes(bytes)), { error: "version" });
});

test("decode: an all-forfeit run round-trips as five forfeits", () => {
  const run = {
    dayNumber: 5, hard: false, poolCheck: 0,
    rounds: Array.from({ length: 5 }, () => ({ pinned: false, lat: null, lng: null, elapsedMs: 0 })),
  };
  const d = decodeGhost(encodeGhost(run));
  assert.equal(d.ok, true);
  assert.ok(d.rounds.every((r) => r.pinned === false && r.lat === null));
});

/* ---------------- length budget (§3.5.1) ---------------- */

test("fragment ≤ 100 chars and full share URL ≤ 200 chars", () => {
  const base = "https://earino.github.io/geoparty/daily.html?utm_source=share&utm_campaign=daily";
  for (let s = 0; s < 200; s++) {
    const payload = encodeGhost(fuzzRun(s, s % 2 === 0));
    const frag = ghostFragment(payload);
    assert.ok(frag.length <= MAX_FRAGMENT_CHARS, `fragment ${frag.length} > ${MAX_FRAGMENT_CHARS}`);
    const url = appendGhostFragment(base, payload);
    assert.ok(url.length <= MAX_URL_CHARS, `url ${url.length} > ${MAX_URL_CHARS}`);
  }
});

/* ---------------- score reproduction (integrity posture) ---------------- */

test("recomputed ghost score is within a couple of points of full precision", () => {
  for (let s = 0; s < 300; s++) {
    const run = fuzzRun(s, false);
    const rand = mulberry32(hashSeed(`truth:${s}`));
    const truths = run.rounds.map(() => ({ lat: rand() * 180 - 90, lng: rand() * 360 - 180 }));
    const decoded = decodeGhost(encodeGhost(run));
    const recomputed = ghostScores(truths, decoded);
    const windowMs = bonusWindowMs(dailyRoundSeconds(false));
    run.rounds.forEach((r, i) => {
      if (!r.pinned) { assert.equal(recomputed[i].points, 0); return; }
      const km = haversineKm(truths[i].lat, truths[i].lng, r.lat, r.lng);
      const dp = scoreForDistance(km);
      const full = dp + timeBonus(dp, r.elapsedMs, windowMs);
      assert.ok(Math.abs(recomputed[i].points - full) <= 3,
        `round ${i}: ${recomputed[i].points} vs ${full}`);
    });
  }
});

/* ---------------- day window + pool check ---------------- */

test("ghostExpired: ±1 day is in-window (timezone grace), beyond expires", () => {
  assert.equal(ghostExpired(37, 37), false);
  assert.equal(ghostExpired(36, 37), false);   // recipient a day behind
  assert.equal(ghostExpired(38, 37), false);   // sender a day ahead
  assert.equal(ghostExpired(35, 37), true);
  assert.equal(ghostExpired(40, 37), true);
});

test("poolCheck / poolMatches: same ids match, drift is caught", () => {
  const ids = ["a1", "b2", "c3", "d4", "e5"];
  const pc = poolCheck(ids);
  assert.equal(poolMatches(pc, ids), true);
  assert.equal(poolMatches(pc, ["a1", "b2", "c3", "d4", "X"]), false);
  // Order matters (a different order is a different Daily).
  assert.equal(poolMatches(pc, ["b2", "a1", "c3", "d4", "e5"]), false);
});

test("buildGhostPayload: from a run + ids carries the hard flag and pool", () => {
  const ids = ["i1", "i2", "i3", "i4", "i5"];
  const run = {
    hard: true,
    rounds: [
      { guess: { lat: 10, lng: 20 }, elapsedMs: 5000 },
      { guess: null, elapsedMs: 0 },
    ],
  };
  const d = decodeGhost(buildGhostPayload(run, ids, 41));
  assert.equal(d.ok, true);
  assert.equal(d.hard, true);
  assert.equal(d.dayNumber, 41);
  assert.equal(poolMatches(d.poolCheck, ids), true);
  assert.equal(d.rounds[0].pinned, true);
  assert.equal(d.rounds[1].pinned, false);
});

/* ---------------- verdict fold ---------------- */

test("duelVerdict: totals, outcome, margin, per-round winners, ties", () => {
  const v = duelVerdict([100, 200, 0, 50, 300], [90, 250, 0, 50, 100]);
  assert.equal(v.yourTotal, 650);
  assert.equal(v.ghostTotal, 490);
  assert.equal(v.outcome, "won");
  assert.equal(v.margin, 160);
  assert.deepEqual(v.rows.map((r) => r.winner), ["you", "ghost", "tie", "tie", "you"]);
  // A dead heat.
  const tie = duelVerdict([100, 100], [100, 100]);
  assert.equal(tie.outcome, "tie");
  assert.equal(tie.margin, 0);
  // The ghost takes it.
  const lost = duelVerdict([10], [999]);
  assert.equal(lost.outcome, "lost");
});

/* ---------------- fragment plumbing ---------------- */

test("parse/append ghost fragment round-trips; only the fragment carries it", () => {
  const payload = encodeGhost(fuzzRun(1));
  const url = appendGhostFragment("https://x.test/daily.html?utm_source=share", payload);
  assert.ok(url.includes(`#g=${payload}`));
  assert.ok(!url.split("#")[0].includes(payload));   // never in the query string
  assert.equal(parseGhostFragment(new URL(url).hash), payload);
  assert.equal(parseGhostFragment(`#g=${payload}&x=1`), payload);
  assert.equal(parseGhostFragment("#nope"), null);
  assert.equal(parseGhostFragment(""), null);
});

/* ---------------- helpers (mirror the codec's byte math) ---------------- */

function bytesFromB64url(str) {
  const B = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const inv = {}; for (let i = 0; i < B.length; i++) inv[B[i]] = i;
  const out = []; let buf = 0; let bits = 0;
  for (const ch of str) { buf = (buf << 6) | inv[ch]; bits += 6; if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); } }
  return Uint8Array.from(out);
}
function b64urlFromBytes(bytes) {
  const B = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]; const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0; const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B[b0 >> 2]; out += B[((b0 & 3) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) out += B[((b1 & 15) << 2) | (b2 >> 6)];
    if (i + 2 < bytes.length) out += B[b2 & 63];
  }
  return out;
}
function refreshChecksum(bytes) {
  let h = 2166136261;
  for (let i = 0; i < bytes.length - 2; i++) { h ^= bytes[i]; h = Math.imul(h, 16777619); }
  h >>>= 0;
  const cs = ((h >>> 16) ^ (h & 0xffff)) & 0xffff;
  bytes[bytes.length - 2] = cs & 0xff;
  bytes[bytes.length - 1] = (cs >> 8) & 0xff;
}

// R5: a saved run must carry at least one usable pin before it can become a
// challenge link — a pre-v2 (v1) save or an all-forfeit run has none, and must
// fall back to the plain card + honest toast, never an all-forfeit ghost link.
test("runHasPins: true only when at least one round has a usable v2 pin", () => {
  // A v2 run with pins.
  assert.equal(runHasPins({ rounds: [
    { guess: null }, { guess: { lat: 10, lng: 20 } }, { guess: null },
  ] }), true);
  // A pre-v2 (v1) save: rounds have points but no per-round `guess`.
  assert.equal(runHasPins({ rounds: [
    { distanceKm: 12, points: 3000 }, { distanceKm: 40, points: 2000 },
  ] }), false);
  // An all-forfeit run (v2 shape, every guess null).
  assert.equal(runHasPins({ rounds: [{ guess: null }, { guess: null }] }), false);
  // Malformed pins (non-numeric coords) do not count.
  assert.equal(runHasPins({ rounds: [{ guess: { lat: "x", lng: 3 } }] }), false);
  // Defensive: missing/empty shapes.
  assert.equal(runHasPins(null), false);
  assert.equal(runHasPins({}), false);
  assert.equal(runHasPins({ rounds: [] }), false);
});
