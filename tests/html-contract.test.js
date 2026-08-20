// tests/html-contract.test.js — the static HTML↔JS contract (stabilization
// §8 item 1). Node tests never touch the DOM, so a page controller that
// references an element its HTML lacks, an event handler that was renamed out
// from under a listener (the shipped P0: `guessMarker.on("move",
// updateLockNowHint)` after the function became `updateLockButton`), a
// checklist mask that drifted from the markup, or a Mapillary SDK tag that
// disagrees with the runtime constant — all ship green today. This file
// closes those four gaps with pure string analysis, no DOM required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const jsFiles = readdirSync(new URL("js/", root)).filter((f) => f.endsWith(".js"));

// Page → (its HTML, the controller module(s) loaded by that page). These are
// the "page controllers" the P0 class of bug lives in.
const PAGES = {
  "host.html": ["host-ui.js"],
  "player.html": ["player-ui.js"],
  "screen.html": ["screen-ui.js", "screen-h2h.js"],
  "daily.html": ["daily-ui.js"],
  "index.html": ["landing-ui.js"],
};

/* Remove string literals so paren-counting and identifier scans don't trip
 * over parentheses or the words "e"/"error" inside message copy. */
function stripStrings(src) {
  return src
    .replace(/`[^`\\]*(?:\\.[^`\\]*)*`/g, "``")
    .replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""')
    .replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, "''");
}

// Names a file declares or imports (enough to resolve top-level handlers).
function declaredNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\bimport\s+([^;]+?)\s+from/g)) {
    const clause = m[1];
    const def = clause.match(/^\s*([A-Za-z_$][\w$]*)/);
    if (def && !clause.trimStart().startsWith("{")) names.add(def[1]);
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) {
      for (const part of braces[1].split(",")) {
        const as = part.trim().split(/\s+as\s+/);
        const local = (as[1] || as[0]).trim();
        if (local) names.add(local);
      }
    }
  }
  return names;
}

/* ================================================================
 * A. Event-handler contract — the one that catches the shipped P0.
 * Every bare-identifier callback passed to .on()/.addEventListener() must be
 * declared or imported in the same file. A rename that misses a call site
 * (updateLockNowHint → updateLockButton) fails here instead of at runtime.
 * ================================================================ */

test("A: every .on/.addEventListener callback identifier is defined in its file", () => {
  const re = /\.(?:on|addEventListener)\(\s*(?:"[^"]+"|'[^']+'|`[^`]+`)\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g;
  const offenders = [];
  for (const f of jsFiles) {
    const src = read(`js/${f}`);
    const names = declaredNames(src);
    for (const m of src.matchAll(re)) {
      if (!names.has(m[1])) offenders.push(`js/${f}: handler "${m[1]}" is not defined`);
    }
  }
  assert.deepEqual(offenders, [],
    `undefined event-handler references:\n${offenders.join("\n")}`);
});

/* ================================================================
 * B. DOM id contract — every id a page controller looks up via $()/​
 * getElementById() exists in that page's HTML, or is created dynamically in
 * module code (an id assigned via `.id = "..."`).
 * ================================================================ */

test("B: every controller $()/getElementById id exists in its page or is created in JS", () => {
  const dynamic = new Set();
  for (const f of jsFiles) {
    for (const m of read(`js/${f}`).matchAll(/\.id\s*=\s*["'`]([\w-]+)["'`]/g)) {
      dynamic.add(m[1]);
    }
  }
  const offenders = [];
  for (const [html, ctrls] of Object.entries(PAGES)) {
    const htmlIds = new Set(
      [...read(html).matchAll(/id=["']?([\w-]+)/g)].map((m) => m[1]));
    for (const c of ctrls) {
      const src = read(`js/${c}`);
      const refs = new Set();
      for (const m of src.matchAll(/\$\(\s*"([\w-]+)"\s*\)/g)) refs.add(m[1]);
      for (const m of src.matchAll(/getElementById\(\s*"([\w-]+)"\s*\)/g)) refs.add(m[1]);
      for (const id of refs) {
        if (!htmlIds.has(id) && !dynamic.has(id)) {
          offenders.push(`${html} (${c}): references #${id}, absent from HTML and not created in JS`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `missing element ids:\n${offenders.join("\n")}`);
});

/* ================================================================
 * C. Replay-mask contract — the checklist (docs/replay-mask-checklist.md §2)
 * and the markup cannot drift. Every id the checklist lists as masked must
 * carry data-ph-mask in its HTML (static), or set dataset.phMask in its page
 * controller (runtime-injected). Deliberately-unmasked ids are skipped.
 * ================================================================ */

function checklistMaskedIds() {
  const md = read("docs/replay-mask-checklist.md");
  const sec2 = md.split(/^## /m).find((s) => s.startsWith("2. Masked containers"));
  const jsFor = {
    "host.html": ["host-ui.js"], "player.html": ["player-ui.js"],
    "screen.html": ["screen-ui.js", "screen-h2h.js"], "daily.html": ["daily-ui.js"],
  };
  const rows = [];
  let page = null;
  for (const line of sec2.split("\n")) {
    const h = line.match(/^###\s+(host\.html|player\.html|screen\.html|daily\.html)/);
    if (h) { page = h[1]; continue; }
    if (line.startsWith("###")) { page = null; continue; } // Cross-page selectors
    if (!page || !line.trimStart().startsWith("- ")) continue;
    if (/unmasked|not\s+\*{0,2}mask/i.test(line)) continue; // deliberately not masked
    const runtime = /inject|runtime|masked in/i.test(line);
    const subject = line.split("—")[0]; // ids after the em-dash are prose refs
    for (const m of subject.matchAll(/`#([\w-]+)`/g)) {
      rows.push({ id: m[1], page, js: jsFor[page], runtime });
    }
  }
  return rows;
}

test("C: checklist-masked ids carry the mask in markup (or set it in JS)", () => {
  const rows = checklistMaskedIds();
  assert.ok(rows.length >= 30, `expected the full checklist, parsed ${rows.length}`);
  const offenders = [];
  for (const r of rows) {
    if (r.runtime) {
      const js = r.js.map((f) => read(`js/${f}`)).join("\n");
      if (!(js.includes(r.id) && /dataset\.phMask/.test(js))) {
        offenders.push(`${r.page} #${r.id}: listed as runtime-masked but JS does not set dataset.phMask`);
      }
      continue;
    }
    const h = read(r.page);
    const idx = h.search(new RegExp(`id=["']${r.id}["']`));
    let masked = false;
    if (idx >= 0) {
      const tag = h.slice(h.lastIndexOf("<", idx), h.indexOf(">", idx));
      masked = /data-ph-mask/.test(tag);
    }
    if (!masked) offenders.push(`${r.page} #${r.id}: checklist says masked, markup has no data-ph-mask`);
  }
  assert.deepEqual(offenders, [], `mask drift:\n${offenders.join("\n")}`);
});

/* ================================================================
 * D. Mapillary SDK version — the pinned <script>/<link> tags in every page
 * must equal MAPILLARY_SDK, the constant viewer-ui.js reports on viewer_init
 * (a drift makes the dashboard's `sdk` property lie).
 * ================================================================ */

test("D: the Mapillary SDK tag in every page matches viewer-ui's MAPILLARY_SDK", () => {
  const sdk = read("js/viewer-ui.js").match(/MAPILLARY_SDK\s*=\s*"([^"]+)"/)[1];
  assert.ok(sdk, "MAPILLARY_SDK constant not found");
  const offenders = [];
  for (const html of Object.keys(PAGES)) {
    const found = new Set(
      [...read(html).matchAll(/mapillary-js@([\d.]+)/g)].map((m) => m[1]));
    assert.ok(found.size > 0, `${html} loads no mapillary-js tag`);
    for (const v of found) {
      if (v !== sdk) offenders.push(`${html}: mapillary-js@${v} != MAPILLARY_SDK ${sdk}`);
    }
  }
  assert.deepEqual(offenders, [], `SDK tag drift:\n${offenders.join("\n")}`);
});
