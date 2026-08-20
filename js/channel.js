// channel.js — which deployment channel is this page running in?
//
// The URL is the identity: an http(s) page whose path contains the /beta/
// directory is the beta channel; everything else — including every file://
// dev checkout, whatever its filesystem path contains — is production.
// Everything channel-dependent (the Firebase namespace in js/firebase.js,
// the PostHog deployment_channel super property in js/consent.js) derives
// from this ONE pure, synchronous, infallible function, so there is no
// second place a channel decision can drift.
//
// Pure module: no DOM, no network (same discipline as game.js / h2h.js) —
// unit-tested in tests/channel.test.js. Call sites pass
// `location.pathname, location.protocol`.
//
// The `protocol` guard mirrors the precedent in siteAddress()
// (js/tvlink.js): without it a dev checkout living under a directory named
// beta/ (file:///home/e/beta/geoparty/index.html) would silently talk to
// the beta namespace, contradicting "file:// → production". The beta
// deployment plan (docs/beta-deployment-plan.md §5.1) mandates it.

// The two legal namespace roots. Frozen so a stray edit can't grow a third
// value that escapes the published Firebase rules (rooms/ + rooms-beta/).
export const ROOMS_ROOTS = Object.freeze({ production: "rooms", beta: "rooms-beta" });

export function channelFromPath(pathname, protocol) {
  if (protocol !== "http:" && protocol !== "https:") return "production";
  // Append "/" so a trailing "/geoparty/beta" (no slash) still matches while
  // "/geoparty/betamax.html" (a prefix, not the directory) does not.
  return /\/beta\//.test(String(pathname) + "/") ? "beta" : "production";
}

export function roomsRoot(pathname, protocol) {
  return ROOMS_ROOTS[channelFromPath(pathname, protocol)];
}
