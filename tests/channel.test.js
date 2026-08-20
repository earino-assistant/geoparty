// tests/channel.test.js — the pure deployment-channel contract
// (beta-deployment-plan §5.1). The URL is the identity: an http(s) page under
// a /beta/ directory is beta; everything else — every file:// dev checkout,
// whatever its filesystem path — is production. This is the ONLY place the
// channel decision lives (Firebase namespace + PostHog deployment_channel
// both derive from it), so the matrix here is load-bearing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { channelFromPath, roomsRoot, ROOMS_ROOTS } from "../js/channel.js";

test("production: the site root and ordinary pages", () => {
  assert.equal(channelFromPath("/geoparty/", "https:"), "production");
  assert.equal(channelFromPath("/geoparty/index.html", "https:"), "production");
  assert.equal(channelFromPath("/geoparty/player.html", "https:"), "production");
  assert.equal(channelFromPath("/", "https:"), "production");
});

test("beta: a /beta/ directory, with or without a page, over http(s)", () => {
  assert.equal(channelFromPath("/geoparty/beta/", "https:"), "beta");
  assert.equal(channelFromPath("/geoparty/beta/player.html", "https:"), "beta");
  assert.equal(channelFromPath("/geoparty/beta/screen.html", "http:"), "beta");
});

test("beta: a trailing /beta with no slash still matches (the appended /)", () => {
  // The URL a TV or a share link can land on before the redirect to /beta/.
  assert.equal(channelFromPath("/geoparty/beta", "https:"), "beta");
});

test("production: a /beta prefix that is not the /beta/ directory", () => {
  // The false-positives the "match the /beta/ DIRECTORY" rule defeats:
  // neither "betamax.html" nor a "/betas/" directory is the beta channel —
  // the match needs the segment to be exactly "beta".
  assert.equal(channelFromPath("/geoparty/betamax.html", "https:"), "production");
  assert.equal(channelFromPath("/geoparty/betas/", "https:"), "production");
});

test("production: EVERY file:// checkout, even one living under a beta/ dir", () => {
  // The EM-mandated protocol guard: a dev checkout at
  // file:///home/e/beta/geoparty/index.html must NOT talk to rooms-beta.
  assert.equal(channelFromPath("/home/e/beta/geoparty/index.html", "file:"), "production");
  assert.equal(channelFromPath("/home/e/geoparty/beta/index.html", "file:"), "production");
  assert.equal(channelFromPath("/geoparty/beta/", "file:"), "production");
  assert.equal(channelFromPath("/geoparty/", "file:"), "production");
});

test("production: any non-http(s) protocol is production", () => {
  for (const proto of ["file:", "chrome:", "about:", "data:", "blob:", ""]) {
    assert.equal(channelFromPath("/geoparty/beta/", proto), "production", proto);
  }
});

test("beta: a locally-served assembled artifact (localhost http) behaves as beta", () => {
  assert.equal(channelFromPath("/beta/index.html", "http:"), "beta");
  assert.equal(channelFromPath("/geoparty/beta/", "http:"), "beta");
});

test("channelFromPath tolerates a non-string pathname without throwing", () => {
  // Defensive: location.pathname is always a string in a browser, but the
  // pure function must not throw if handed something odd.
  assert.equal(channelFromPath(undefined, "https:"), "production");
  assert.equal(channelFromPath(null, "https:"), "production");
});

test("roomsRoot returns ONLY a value in the rules allowlist {rooms, rooms-beta}", () => {
  // A table test so a future third channel can never silently escape the
  // published Firebase rules (which allowlist rooms/ and rooms-beta/ only).
  const cases = [
    ["/geoparty/", "https:", "rooms"],
    ["/geoparty/beta/", "https:", "rooms-beta"],
    ["/geoparty/beta/player.html", "https:", "rooms-beta"],
    ["/geoparty/beta", "https:", "rooms-beta"],
    ["/geoparty/betamax.html", "https:", "rooms"],
    ["/home/e/beta/geoparty/index.html", "file:", "rooms"],
    ["/geoparty/beta/", "file:", "rooms"],
    ["/beta/index.html", "http:", "rooms-beta"],
  ];
  const allowed = new Set(["rooms", "rooms-beta"]);
  for (const [pathname, protocol, expected] of cases) {
    const root = roomsRoot(pathname, protocol);
    assert.equal(root, expected, `${protocol}//${pathname}`);
    assert.ok(allowed.has(root), `root ${root} is not in the rules allowlist`);
  }
});

test("ROOMS_ROOTS maps exactly the two channels to the two rules subtrees", () => {
  assert.deepEqual(ROOMS_ROOTS, { production: "rooms", beta: "rooms-beta" });
  // Frozen: no stray edit can grow a third namespace that the rules deny.
  assert.equal(Object.isFrozen(ROOMS_ROOTS), true);
});
