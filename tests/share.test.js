// Tests for js/share.js — the S1 share artifact: UTM-tagged links, the
// party card, the daily card's emoji grid, and the best-moment fold.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UTM_SOURCE,
  withUtm,
  foldBestMoment,
  partyShareText,
  EMOJI_BUCKETS,
  EMOJI_NO_PIN,
  distanceEmoji,
  emojiRow,
  dailyShareText,
  dailyChallengeUrl,
  winBragText,
} from "../js/share.js";
import { parseGhostFragment, encodeGhost } from "../js/ghost.js";

/* ---------------- withUtm ---------------- */

test("withUtm: tags source and campaign onto a clean URL", () => {
  const url = new URL(withUtm("https://example.test/geoparty/", "couch"));
  assert.equal(url.searchParams.get("utm_source"), UTM_SOURCE);
  assert.equal(url.searchParams.get("utm_campaign"), "couch");
  assert.equal(url.origin + url.pathname, "https://example.test/geoparty/");
});

test("withUtm: preserves existing query params, overwrites stale tags", () => {
  const tagged = withUtm(
    "https://example.test/daily.html?x=1&utm_campaign=old", "daily");
  const url = new URL(tagged);
  assert.equal(url.searchParams.get("x"), "1");
  assert.equal(url.searchParams.get("utm_source"), "share");
  assert.equal(url.searchParams.get("utm_campaign"), "daily");
});

/* ---------------- foldBestMoment ---------------- */

test("foldBestMoment: keeps the closest guess and its round's place name", () => {
  let best = null;
  best = foldBestMoment(best, {
    t1: { guess: { lat: 1, lng: 2 }, distanceKm: 812 },
    t2: { guess: { lat: 3, lng: 4 }, distanceKm: 44.2 },
  }, "Lisbon, Portugal");
  assert.deepEqual(best, { km: 44.2, place: "Lisbon, Portugal" });
  // A later, worse round leaves the moment alone…
  best = foldBestMoment(
    best, { t1: { guess: {}, distanceKm: 500 } }, "Bergen, Norway");
  assert.deepEqual(best, { km: 44.2, place: "Lisbon, Portugal" });
  // …a closer one replaces it, carrying the new round's place.
  best = foldBestMoment(
    best, { t2: { guess: {}, distanceKm: 3.1 } }, "Kyoto, Japan");
  assert.deepEqual(best, { km: 3.1, place: "Kyoto, Japan" });
});

test("foldBestMoment: ignores forfeits, null results, and missing distances", () => {
  const same = foldBestMoment(null, {
    t1: { guess: null, distanceKm: null }, // forfeit
    t2: null,                              // no result yet
    t3: { guess: { lat: 0, lng: 0 } },     // no distance (malformed)
  }, "Somewhere");
  assert.equal(same, null);
  // Idempotent: refolding the same results changes nothing.
  const once = foldBestMoment(null, { me: { guess: {}, distanceKm: 9 } }, "X");
  assert.deepEqual(foldBestMoment(once, { me: { guess: {}, distanceKm: 9 } }, "X"), once);
});

/* ---------------- the party card ---------------- */

test("partyShareText: the spec's card — distance, place, score, link", () => {
  const text = partyShareText({
    best: { km: 3.2, place: "Kyoto, Japan" },
    points: 4890,
    url: "https://example.test/?utm_source=share&utm_campaign=couch",
  });
  assert.equal(text,
    "GeoParty 🌍 We were 3.2 km from Kyoto, Japan 🏆 " +
    `${(4890).toLocaleString()} pts — beat us: ` +
    "https://example.test/?utm_source=share&utm_campaign=couch");
});

test("partyShareText: unnamed place and missing best degrade gracefully", () => {
  const noName = partyShareText({
    best: { km: 250, place: null }, points: 1000, url: "https://x.test/",
  });
  assert.match(noName, /We were 250 km from the answer/);
  // An all-forfeit game still gets a card — score and link, no brag.
  const noBest = partyShareText({ best: null, points: 0, url: "https://x.test/" });
  assert.equal(noBest, "GeoParty 🌍 0 pts — beat us: https://x.test/");
});

// C2 (G4): a sub-1km best moment stamps the party card with a 🎯 ACE tag —
// a visibly different flex, no new line of copy.
test("partyShareText: a sub-1km best moment adds the 🎯 ACE expression", () => {
  const ace = partyShareText({
    best: { km: 0.4, place: "Kyoto, Japan" }, points: 5200, url: "https://x.test/",
  });
  assert.match(ace, /from Kyoto, Japan 🎯 ACE 🏆/);
  // A non-ACE best carries no ACE tag.
  const notAce = partyShareText({
    best: { km: 3.2, place: "Kyoto, Japan" }, points: 5200, url: "https://x.test/",
  });
  assert.doesNotMatch(notAce, /🎯 ACE/);
});

/* ---------------- winBragText (win-screen brag line) ---------------- */

test("winBragText: no best moment (or no distance) is silent", () => {
  assert.equal(winBragText(null), "");
  assert.equal(winBragText(undefined), "");
  assert.equal(winBragText({ km: null, place: "Kyoto" }), "");
  assert.equal(winBragText({ place: "Kyoto" }), "");
});

test("winBragText: a sub-1km best moment gets the ACE tag", () => {
  assert.equal(winBragText({ km: 0.4, place: null }), "🎯 Your ACE pin — 0.4 km");
});

test("winBragText: an ordinary closest pin has no ACE tag", () => {
  assert.equal(winBragText({ km: 3.2, place: null }), "Your closest pin — 3.2 km");
});

test("winBragText: a place name is appended when present", () => {
  assert.equal(winBragText({ km: 3.2, place: "Kyoto, Japan" }),
    "Your closest pin — 3.2 km from Kyoto, Japan");
  assert.equal(winBragText({ km: 0.4, place: "Kyoto, Japan" }),
    "🎯 Your ACE pin — 0.4 km from Kyoto, Japan");
});

/* ---------------- the daily card ---------------- */

test("distanceEmoji: grades distances into the four tiers plus no-pin", () => {
  assert.equal(distanceEmoji(0), "🎯");     // < 1 km is an ACE (G4)
  assert.equal(distanceEmoji(0.9), "🎯");
  assert.equal(distanceEmoji(1), "🟩");     // exactly 1 km is not an ACE
  assert.equal(distanceEmoji(100), "🟩");   // boundaries are inclusive
  assert.equal(distanceEmoji(100.1), "🟨");
  assert.equal(distanceEmoji(750), "🟨");
  assert.equal(distanceEmoji(3000), "🟧");
  assert.equal(distanceEmoji(19999), "🟥");
  assert.equal(distanceEmoji(null), EMOJI_NO_PIN);
  assert.equal(distanceEmoji(undefined), EMOJI_NO_PIN);
  // The bucket table stays sorted — the find() grading depends on it.
  const maxes = EMOJI_BUCKETS.map((b) => b.maxKm);
  assert.deepEqual(maxes, [...maxes].sort((a, b) => a - b));
});

test("emojiRow: one square per round, in order", () => {
  const rounds = [
    { distanceKm: 12 }, { distanceKm: 600 }, { distanceKm: null },
    { distanceKm: 2800 }, { distanceKm: 9000 },
  ];
  assert.equal(emojiRow(rounds), "🟩🟨⬛🟧🟥");
  assert.equal(emojiRow([]), "");
  assert.equal(emojiRow(null), "");
});

test("dailyShareText: plain card — number, globe, score, grid, link", () => {
  const text = dailyShareText({
    dayNumber: 37,
    score: 18420,
    rounds: [{ distanceKm: 1 }, { distanceKm: null }],
    url: "https://example.test/daily.html?utm_source=share&utm_campaign=daily",
  });
  assert.deepEqual(text.split("\n"), [
    `GeoParty Daily #37 🌍 · ${(18420).toLocaleString()} pts`,
    "🟩⬛",
    "Beat me: https://example.test/daily.html?utm_source=share&utm_campaign=daily",
  ]);
});

test("dailyShareText: streak segment appears at ≥2, omitted at <2 (G1)", () => {
  const withStreak = dailyShareText({
    dayNumber: 37, score: 18340, streak: 12,
    rounds: [{ distanceKm: 1 }], url: "https://x.test/",
  });
  assert.match(withStreak.split("\n")[0], /^GeoParty Daily #37 🔥12 · 18,340 pts$/);
  const one = dailyShareText({
    dayNumber: 37, score: 100, streak: 1, rounds: [{ distanceKm: 1 }], url: "https://x.test/",
  });
  assert.doesNotMatch(one.split("\n")[0], /🔥/);
});

test("dailyShareText: hard card carries the star and ⚡ (G6)", () => {
  const text = dailyShareText({
    dayNumber: 37, score: 14200, hard: true,
    rounds: [{ distanceKm: 1 }], url: "https://x.test/",
  });
  assert.match(text.split("\n")[0], /^GeoParty Daily #37\* ⚡ · 14,200 pts$/);
});

test("dailyShareText: challenge line + ace grid square (G5/G4)", () => {
  const text = dailyShareText({
    dayNumber: 37, score: 18420, challenge: true,
    rounds: [{ distanceKm: 0.4 }, { distanceKm: 200 }],   // an ACE → 🎯
    url: "https://x.test/daily.html#g=ABC",
  });
  assert.equal(text.split("\n")[1], "🎯🟨");
  assert.equal(text.split("\n")[2], "⚔️ Beat my ghost: https://x.test/daily.html#g=ABC");
});

test("dailyShareText: verdict card leads with the duel result (G5)", () => {
  const won = dailyShareText({
    dayNumber: 37, verdict: { outcome: "won", margin: 1840 },
    rounds: [{ distanceKm: 1 }], url: "https://x.test/#g=Z",
  });
  assert.equal(won.split("\n")[0], "GeoParty Daily #37 — I beat the ghost by 1,840 🏆");
  assert.equal(won.split("\n")[2], "⚔️ Your move: https://x.test/#g=Z");
  const lost = dailyShareText({
    dayNumber: 37, verdict: { outcome: "lost", margin: 90 },
    rounds: [], url: "https://x.test/",
  });
  assert.match(lost.split("\n")[0], /The ghost got me by 90 👻/);
  const tie = dailyShareText({
    dayNumber: 37, verdict: { outcome: "tie", margin: 0 },
    rounds: [], url: "https://x.test/",
  });
  assert.match(tie.split("\n")[0], /Dead heat with the ghost/);
});

test("dailyChallengeUrl: UTM query and ghost fragment coexist", () => {
  const payload = encodeGhost({
    dayNumber: 37, hard: false, poolCheck: 0,
    rounds: [{ pinned: true, lat: 10, lng: 20, elapsedMs: 3000 }],
  });
  const url = dailyChallengeUrl("https://x.test/daily.html", payload, "daily");
  const [base, frag] = url.split("#");
  const u = new URL(base);
  assert.equal(u.searchParams.get("utm_source"), "share");
  assert.equal(u.searchParams.get("utm_campaign"), "daily");
  assert.ok(!base.includes(payload));                     // never in the query
  assert.equal(parseGhostFragment("#" + frag), payload);  // only in the fragment
});
