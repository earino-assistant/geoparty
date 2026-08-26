// tvlink.js — pure logic for the "Add a TV" affordance (design review §2.1:
// the worst-documented step was "hand-type a long URL + query string into a
// TV browser with a remote"). The affordance is built from three pieces, all
// assembled here so tests can enforce the rule that created this module:
// no human-facing line ever contains a protocol or a query string.
//
//   1. A QR any spare phone/tablet scans — that device becomes the screen
//      and gets cast/AirPlayed to the TV (OS-level mirroring, no code).
//   2. A one-tap share/copy of the same screen link.
//   3. A short typeable site address for TVs that do have a browser —
//      "open <site>, choose Add a TV" — never the raw screen.html URL.
//
// No DOM, no network in here; the browser glue lives in host-ui.js /
// player-ui.js / screen-ui.js / screen-h2h.js.

// How a screen link was handed over. Rides to screen.html as ?via= and back
// out on the screen_joined event, so we learn which path actually attaches
// TVs (QR-scan-then-cast vs shared link vs hand-typed code).
export const TV_VIAS = Object.freeze(["qr", "link"]);

// Absolute link that turns any browser into this room's screen. baseHref is
// the current page's href (player.html / host.html resolve to their own
// directory); via tags the handover path and is omitted when unknown.
export function screenLink(baseHref, code, via) {
  const url = new URL("tv.html", baseHref);
  url.search = `?room=${code}` + (TV_VIAS.includes(via) ? `&via=${via}` : "");
  return url.href;
}

// The shortest thing a human could type on a TV remote to reach the site:
// host + directory, no protocol, no page, no trailing slash — e.g.
// "earino-assistant.github.io/geoparty". null when the site isn't
// web-served (file://), where a typeable address doesn't exist.
export function siteAddress(baseHref) {
  let u;
  try { u = new URL(baseHref); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const dir = u.pathname.replace(/\/[^/]*$/, "").replace(/\/+$/, "");
  return u.host + dir;
}

// The typing fallback, phrased as one action: reach the site, follow its
// own "Add a TV" affordance (landing footer → screen.html), enter the code
// that's displayed huge right above this line in both lobbies. null when
// there's nothing typeable to point at.
export function tvBrowserLine(baseHref) {
  const site = siteAddress(baseHref);
  return site
    ? `TV has a browser? Open ${site} on it, choose “Add a TV”, and type in the code above.`
    : null;
}

// What the h2h lobbies (the TV's and the host phone's) tell joining phones —
// same rule as above: the short site address plus the code, never a raw URL.
// The front door routes an h2h code to the player page. Falls back to the QR
// when nothing is typeable.
export function phoneJoinLine(baseHref, code) {
  const site = siteAddress(baseHref);
  return site
    ? `Join on your phone: ${site} — code ${code}`
    : "Scan the QR on the host's phone to join";
}

// Normalize the ?via= a screen arrived with into the screen_joined
// attribution value: a known handover path, or "typed" (the code was
// entered by hand — TV browser, front door, or direct screen.html visit).
export function screenJoinVia(raw) {
  return TV_VIAS.includes(raw) ? raw : "typed";
}
