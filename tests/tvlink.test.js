// Tests for js/tvlink.js — the "Add a TV" affordance logic. The invariant
// this module exists to enforce (design review §2.1): no human-facing line
// ever shows a protocol or a query string; machine links carry the room code
// and the handover-path tag; everything degrades on file://.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TV_VIAS,
  screenLink,
  siteAddress,
  tvBrowserLine,
  phoneJoinLine,
  screenJoinVia,
} from "../js/tvlink.js";
import { qrEncode } from "../js/qr.js";

const PAGES_BASE = "https://earino-assistant.github.io/geoparty/player.html";

/* ---------------- screenLink ---------------- */

test("screenLink: resolves screen.html next to the current page", () => {
  assert.equal(
    screenLink(PAGES_BASE, "KWPFRT", "qr"),
    "https://earino-assistant.github.io/geoparty/screen.html?room=KWPFRT&via=qr"
  );
  // host.html and a root-served deployment resolve the same way.
  assert.equal(
    screenLink("https://example.com/host.html", "ABCDEF", "link"),
    "https://example.com/screen.html?room=ABCDEF&via=link"
  );
});

test("screenLink: unknown via is omitted, not passed through", () => {
  for (const via of [undefined, null, "", "typed", "evil=1"]) {
    assert.equal(
      screenLink("https://example.com/player.html", "KWPFRT", via),
      "https://example.com/screen.html?room=KWPFRT"
    );
  }
});

test("screenLink: drops the current page's own query string", () => {
  // A lobby URL already carries ?room= — it must not leak into the link.
  assert.equal(
    screenLink(`${PAGES_BASE}?room=KWPFRT&create=1`, "KWPFRT", "qr"),
    "https://earino-assistant.github.io/geoparty/screen.html?room=KWPFRT&via=qr"
  );
});

test("screenLink: the production link fits the QR encoder", () => {
  // qr.js caps at version 5 / 106 bytes — the GH Pages screen link with
  // room + via must stay encodable or the lobby QR silently disappears.
  const link = screenLink(PAGES_BASE, "KWPFRT", "qr");
  assert.notEqual(qrEncode(link), null);
});

/* ---------------- siteAddress ---------------- */

test("siteAddress: host + directory, no protocol, no page, no slash", () => {
  assert.equal(siteAddress(PAGES_BASE), "earino-assistant.github.io/geoparty");
  assert.equal(siteAddress("https://example.com/host.html"), "example.com");
  assert.equal(
    siteAddress("https://example.com/geoparty/"),
    "example.com/geoparty"
  );
  // Dev servers keep their port — the address must actually work if typed.
  assert.equal(
    siteAddress("http://localhost:8080/player.html"),
    "localhost:8080"
  );
});

test("siteAddress: nothing typeable off the web", () => {
  assert.equal(siteAddress("file:///home/u/geoparty/player.html"), null);
  assert.equal(siteAddress("not a url"), null);
});

/* ---------------- human-facing lines ---------------- */

test("tvBrowserLine: names the site and the Add a TV affordance", () => {
  const line = tvBrowserLine(PAGES_BASE);
  assert.ok(line.includes("earino-assistant.github.io/geoparty"));
  assert.ok(line.includes("Add a TV"));
});

test("phoneJoinLine: short address plus the room code", () => {
  const line = phoneJoinLine(PAGES_BASE, "KWPFRT");
  assert.ok(line.includes("earino-assistant.github.io/geoparty"));
  assert.ok(line.includes("KWPFRT"));
});

test("human lines never contain a protocol or query string", () => {
  // The regression this whole module guards against: dumping
  // "https://…/screen.html?room=X" at a human.
  for (const line of [
    tvBrowserLine(PAGES_BASE),
    tvBrowserLine("http://localhost:8080/host.html"),
    phoneJoinLine(PAGES_BASE, "KWPFRT"),
    phoneJoinLine("file:///x/player.html", "KWPFRT"),
  ]) {
    assert.ok(!/:\/\/|[?&]\w+=|\.html/.test(line), `raw-URL leak: ${line}`);
  }
});

test("human lines degrade on file:// instead of showing a path", () => {
  assert.equal(tvBrowserLine("file:///x/player.html"), null);
  assert.equal(
    phoneJoinLine("file:///x/screen.html", "KWPFRT"),
    "Scan the host's QR to join"
  );
});

/* ---------------- screenJoinVia ---------------- */

test("screenJoinVia: known handover paths pass, everything else is typed", () => {
  for (const via of TV_VIAS) assert.equal(screenJoinVia(via), via);
  for (const raw of [null, undefined, "", "typed", "junk", 42]) {
    assert.equal(screenJoinVia(raw), "typed");
  }
});
