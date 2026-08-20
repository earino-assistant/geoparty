// tests/console-scrub.test.js — proves raw SDK image ids / access tokens
// cannot reach the console (and therefore the session replay, since
// enable_recording_console_log is on). Two guarantees (review P1-1):
//   1. scrubErrorMessage strips both an image id and a token from a realistic
//      SDK rejection — the payload our logging wrappers actually emit.
//   2. No production controller/viewer file passes a bare caught error to
//      console.warn/error without routing it through scrubErrorMessage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scrubErrorMessage } from "../js/imagery.js";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");

// The files whose console output is imagery/SDK-adjacent and rides into replay.
const FILES = [
  "js/host-ui.js", "js/player-ui.js", "js/screen-ui.js",
  "js/screen-h2h.js", "js/daily-ui.js", "js/viewer-ui.js",
];

test("scrubErrorMessage removes the image id AND the token from an SDK rejection", () => {
  const raw = 'moveTo failed: GET https://graph.mapillary.com/1263588815098567' +
    '?access_token=MLY%7Cabc123%7Csecret — Image 1263588815098567 does not exist';
  const out = scrubErrorMessage(raw);
  assert.ok(!out.includes("1263588815098567"), `image id survived: ${out}`);
  assert.ok(!out.includes("access_token"), `token param survived: ${out}`);
  assert.ok(!out.includes("secret"), `token value survived: ${out}`);
  // An Error object (what a catch actually receives) is handled too.
  assert.ok(!scrubErrorMessage(new Error(raw)).includes("1263588815098567"));
});

// Balanced-paren extractor for a console.(warn|error)(...) call, on a
// string-stripped copy so parens/keywords inside message copy don't confuse it.
function stripStrings(src) {
  return src
    .replace(/`[^`\\]*(?:\\.[^`\\]*)*`/g, "``")
    .replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""')
    .replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, "''");
}

function consoleCalls(src) {
  const s = stripStrings(src);
  const calls = [];
  const re = /console\.(?:warn|error)\s*\(/g;
  let m;
  while ((m = re.exec(s))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < s.length && depth > 0; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")") depth--;
    }
    calls.push(s.slice(re.lastIndex, i - 1)); // the argument list, string-stripped
  }
  return calls;
}

test("no production console.warn/error passes a bare caught error un-scrubbed", () => {
  // A lone error identifier as an argument (…, e) / (err) / (error) — the
  // exact shape that leaks a raw SDK message — must be wrapped.
  const bareError = /(^|[,(])\s*(e|err|error|ex)\s*($|[,)])/;
  const offenders = [];
  for (const f of FILES) {
    for (const args of consoleCalls(read(f))) {
      if (bareError.test(args) && !/scrubErrorMessage/.test(args)) {
        offenders.push(`${f}: console call logs a raw error → "${args.trim()}"`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    `un-scrubbed error console sites:\n${offenders.join("\n")}`);
});
