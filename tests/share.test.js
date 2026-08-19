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
} from "../js/share.js";

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

/* ---------------- the daily card ---------------- */

test("distanceEmoji: grades distances into the four tiers plus no-pin", () => {
  assert.equal(distanceEmoji(0), "🟩");
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

test("dailyShareText: number, score, grid, and the tagged link", () => {
  const text = dailyShareText({
    dayNumber: 37,
    score: 18420,
    rounds: [{ distanceKm: 1 }, { distanceKm: null }],
    url: "https://example.test/daily.html?utm_source=share&utm_campaign=daily",
  });
  assert.deepEqual(text.split("\n"), [
    `GeoParty Daily #37 🌍 ${(18420).toLocaleString()} pts`,
    "🟩⬛",
    "Beat me: https://example.test/daily.html?utm_source=share&utm_campaign=daily",
  ]);
});
