// tests/console-scrub.test.js — proves raw SDK image ids / access tokens
// cannot reach the console (and therefore the session replay, since
// enable_recording_console_log is on). Guarantees (review P1-1 / RF-1):
//   1. scrubErrorMessage strips both an image id and a token from a realistic
//      SDK rejection — the payload our logging wrappers actually emit.
//   2. No production JS file passes a caught error to console.warn/error
//      without routing it through scrubErrorMessage — across EVERY js/*.js
//      file, not a hand-picked subset, and proven non-vacuous.
//
// The previous version of this guard was ~59% fake: its string-stripper
// (`stripStrings`) treated every apostrophe as a string delimiter, so an
// apostrophe in a comment ("the caller's…") opened a phantom string that
// swallowed whole regions of a file — and Fable's mutation
// (`console.warn("resume: image failed to load —", e)` in host-ui.js)
// slipped through un-noticed. This version replaces that regex hack with a
// small correct JS lexer (comments, single/double strings, template literals
// with `${…}` interpolation) and a per-file raw-vs-scanned self-check that
// fails the instant a real call silently drops out of the scan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { scrubErrorMessage } from "../js/imagery.js";

const jsDir = new URL("../js/", import.meta.url);
const read = (f) => readFileSync(new URL(f, jsDir), "utf8");

// Auto-discovered: EVERY production module. A file added tomorrow is guarded
// automatically — the scan can never fall back to a stale subset (RF-1).
const FILES = readdirSync(jsDir).filter((f) => f.endsWith(".js")).sort();

// Files whose console output demonstrably rides into replay and MUST stay in
// the scanned set. If any of these disappears from the auto-discovered list
// (rename/delete), the presence assertion below fails loudly rather than the
// file silently dropping out of coverage.
const REQUIRED_COVERED = [
  "host-ui.js", "player-ui.js", "screen-ui.js", "screen-h2h.js",
  "daily-ui.js", "viewer-ui.js", "chrome-ui.js", "consent.js", "analytics.js",
];

// The aliases a caught error travels under in this codebase.
const ALIAS = "(?:e|err|error|ex|_e|_err)";

// Every console method PostHog's replay console capture records. All five ride
// into the recording (enable_recording_console_log), so all five must be
// scanned — not just warn/error (RF-A). Production has zero log/info/debug
// sites today; method coverage is proven by the fixtures below, while per-file
// raw-vs-scanned parity keeps the scan honest WITHOUT fabricating a per-method
// production minimum that would force fake usage into the codebase.
const CONSOLE_METHODS = ["log", "info", "debug", "warn", "error"];
const consoleCallRe = () =>
  new RegExp(`console\\.(?:${CONSOLE_METHODS.join("|")})\\s*\\(`, "g");

/* ================================================================
 * A small, correct JS lexer.
 * ----------------------------------------------------------------
 * Returns a "code skeleton" the same length as the source, where the CONTENT
 * of comments, string literals and template-literal text is blanked to
 * spaces (newlines preserved), but real code — INCLUDING the expressions
 * inside `${…}` template interpolations — is kept verbatim. This is what
 * makes it immune to apostrophes/parens/commas/`console.warn(` occurring
 * inside comments or copy: they are no longer code.
 * ================================================================ */
function codeSkeleton(src) {
  const out = [];
  const blank = (c) => out.push(c === "\n" ? "\n" : " ");
  const keep = (c) => out.push(c);
  // Brace-depth stack for active `${…}` interpolations: a `}` at depth 0 ends
  // the interpolation and returns us to template-text scanning.
  const interp = [];
  let state = "code";
  let i = 0;
  // Last significant character, to disambiguate a regex literal `/…/` from a
  // division `/`. A regex may begin only where a value may NOT (after an
  // operator, opener, comma, or at the start); after a value token
  // (identifier, number, `)`, `]`, or a closed string/regex, marked "x") the
  // `/` is division. Whitespace/comments do not update it.
  let prevSig = null;
  const REGEX_OK_BEFORE = /[([{,;:=!&|?+\-*/%^~<>]/;
  const isValueEnd = (ch) => /[)\]}A-Za-z0-9_$]/.test(ch);
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (state === "code") {
      if (c === "/" && d === "/") { state = "line"; blank(c); blank(d); i += 2; continue; }
      if (c === "/" && d === "*") { state = "block"; blank(c); blank(d); i += 2; continue; }
      if (c === "/" && (prevSig === null || (REGEX_OK_BEFORE.test(prevSig) && !isValueEnd(prevSig)))) {
        // Regex literal: blank its body (a char class may contain quotes and
        // `/`, which must not be read as strings or a terminator).
        blank(c); i++;
        let inClass = false;
        while (i < src.length) {
          const ch = src[i];
          if (ch === "\\") { blank(ch); blank(src[i + 1]); i += 2; continue; }
          if (ch === "[") inClass = true;
          else if (ch === "]") inClass = false;
          else if (ch === "/" && !inClass) { blank(ch); i++; break; }
          else if (ch === "\n") { break; } // unterminated — bail defensively
          blank(ch); i++;
        }
        while (i < src.length && /[a-z]/i.test(src[i])) { blank(src[i]); i++; } // flags
        prevSig = "x";
        continue;
      }
      if (c === "'") { state = "sq"; blank(c); i++; continue; }
      if (c === '"') { state = "dq"; blank(c); i++; continue; }
      if (c === "`") { state = "tmpl"; blank(c); i++; continue; }
      if (interp.length) {
        if (c === "{") { interp[interp.length - 1]++; keep(c); prevSig = c; i++; continue; }
        if (c === "}") {
          if (interp[interp.length - 1] === 0) { interp.pop(); state = "tmpl"; blank(c); prevSig = "x"; i++; continue; }
          interp[interp.length - 1]--; keep(c); prevSig = c; i++; continue;
        }
      }
      keep(c); if (!/\s/.test(c)) prevSig = c; i++; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; keep(c); i++; continue; }
      blank(c); i++; continue;
    }
    if (state === "block") {
      if (c === "*" && d === "/") { state = "code"; blank(c); blank(d); i += 2; continue; }
      blank(c); i++; continue;
    }
    if (state === "sq" || state === "dq") {
      const q = state === "sq" ? "'" : '"';
      if (c === "\\") { blank(c); blank(d); i += 2; continue; }
      if (c === q) { state = "code"; prevSig = "x"; blank(c); i++; continue; }
      blank(c); i++; continue;
    }
    if (state === "tmpl") {
      if (c === "\\") { blank(c); blank(d); i += 2; continue; }
      if (c === "`") { state = "code"; prevSig = "x"; blank(c); i++; continue; }
      if (c === "$" && d === "{") { interp.push(0); state = "code"; blank(c); blank(d); i += 2; continue; }
      blank(c); i++; continue;
    }
  }
  return out.join("");
}

// Extract the argument-list text of every console.log/info/debug/warn/error
// call, via balanced parens over the CODE SKELETON (so parens inside strings,
// comments and copy can never confuse the extractor; multiline calls span
// newlines transparently).
function consoleCalls(src) {
  const s = codeSkeleton(src);
  const calls = [];
  const re = consoleCallRe();
  let m;
  while ((m = re.exec(s))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < s.length && depth > 0; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")") depth--;
    }
    calls.push(s.slice(re.lastIndex, i - 1));
  }
  return calls;
}

// Remove balanced `name(…)` spans (e.g. the approved `scrubErrorMessage(e)`
// wrapper) so an error identifier that is ALREADY scrubbed is not mistaken
// for a leak.
function stripApprovedWrappers(argSkeleton, names = ["scrubErrorMessage"]) {
  let s = argSkeleton;
  let again = true;
  while (again) {
    again = false;
    for (const name of names) {
      const m = new RegExp(`\\b${name}\\s*\\(`).exec(s);
      if (!m) continue;
      let depth = 1;
      let i = m.index + m[0].length;
      for (; i < s.length && depth > 0; i++) {
        if (s[i] === "(") depth++;
        else if (s[i] === ")") depth--;
      }
      s = s.slice(0, m.index) + " ".repeat(i - m.index) + s.slice(i);
      again = true;
    }
  }
  return s;
}

// Given a console call's argument skeleton, return the leak shapes that reach
// the console un-scrubbed. Because the skeleton has already neutralised all
// string/comment/template text, ANY surviving whole-word error alias is an
// un-wrapped error value — this single test covers `…, e)`, `${e}`,
// `e.message`, `e.stack`, `String(e)` and `err`/`error`/`ex` aliases at once.
// The specific patterns below exist only to produce a precise failure label.
function leakShapes(argSkeleton) {
  const residue = stripApprovedWrappers(argSkeleton);
  if (!new RegExp(`\\b${ALIAS}\\b`).test(residue)) return [];
  const shapes = [];
  if (new RegExp(`\\b${ALIAS}\\.(?:message|stack|toString)\\b`).test(residue)) shapes.push(".message/.stack");
  if (new RegExp(`\\bString\\s*\\(\\s*${ALIAS}\\s*\\)`).test(residue)) shapes.push("String(e)");
  if (new RegExp(`(?:^|,)\\s*${ALIAS}\\s*(?:,|$)`).test(residue)) shapes.push("bare arg / interpolation");
  if (!shapes.length) shapes.push("error alias");
  return shapes;
}

function offenders(files) {
  const found = [];
  for (const f of files) {
    for (const args of consoleCalls(read(f))) {
      const shapes = leakShapes(args);
      if (shapes.length) {
        found.push(`${f}: console call logs a raw error (${shapes.join(", ")}) → "${args.trim().replace(/\s+/g, " ")}"`);
      }
    }
  }
  return found;
}

/* ================================================================
 * 1. scrubErrorMessage actually strips the two hazardous shapes.
 * ================================================================ */
test("scrubErrorMessage removes the image id AND the token from an SDK rejection", () => {
  const raw = "moveTo failed: GET https://graph.mapillary.com/1263588815098567" +
    "?access_token=MLY%7Cabc123%7Csecret — Image 1263588815098567 does not exist";
  const out = scrubErrorMessage(raw);
  assert.ok(!out.includes("1263588815098567"), `image id survived: ${out}`);
  assert.ok(!out.includes("access_token"), `token param survived: ${out}`);
  assert.ok(!out.includes("secret"), `token value survived: ${out}`);
  assert.ok(!scrubErrorMessage(new Error(raw)).includes("1263588815098567"));
});

/* ================================================================
 * 2. The invariant, across every production file.
 * ================================================================ */
test("no production console.log/info/debug/warn/error passes a caught error un-scrubbed (all js/*.js)", () => {
  const found = offenders(FILES);
  assert.deepEqual(found, [], `un-scrubbed error console sites:\n${found.join("\n")}`);
});

/* ================================================================
 * 3. Anti-vacuity — the scan cannot be silently blinded.
 * ================================================================ */
test("every console call the lexer scans is a call the raw source has (per-file count parity)", () => {
  // Raw count: the naive substring match. Scanned count: what the lexer sees.
  // These agree ONLY if the lexer neither drops a real call (the RF-1 bug:
  // an apostrophe blinding a region) nor invents one from a comment/string.
  // A divergence in EITHER direction fails the suite.
  const rawRe = consoleCallRe();
  let total = 0;
  for (const f of FILES) {
    const src = read(f);
    const raw = (src.match(rawRe) || []).length;
    const scanned = consoleCalls(src).length;
    assert.equal(scanned, raw,
      `${f}: lexer scanned ${scanned} console.(log|info|debug|warn|error) calls but the raw source has ${raw} — the scan is blind to ${raw - scanned} of them`);
    total += scanned;
  }
  // A floor mirroring track-schema.test.js: guard against the whole scan
  // matching nothing (regex/lexer regression). Deliberately a TOTAL floor, not
  // a per-method one: production has ~30 warn/error sites and zero
  // log/info/debug sites today, so a per-method minimum would fabricate usage.
  // Method coverage for log/info/debug is proven by fixtures below instead.
  assert.ok(total >= 25, `expected the real call sites (~30), found only ${total}`);
});

test("every file that must be covered is present in the auto-discovered set", () => {
  for (const f of REQUIRED_COVERED) {
    assert.ok(FILES.includes(f),
      `${f} is required in the console-scrub coverage set but is not among js/*.js — a guarded file dropped out`);
  }
  // The known bare-error hotspots must actually contribute scanned calls, so a
  // file cannot "pass" by having its console calls silently lexed away.
  for (const f of ["host-ui.js", "player-ui.js", "chrome-ui.js"]) {
    assert.ok(consoleCalls(read(f)).length > 0, `${f} contributed zero scanned console calls`);
  }
});

/* ================================================================
 * 4. Mutation fixtures — the scanner CATCHES real leak shapes, including the
 *    exact ones the old guard was blind to. These are strings, not edits to
 *    real files, so the proof needs no manual mutate-and-revert.
 * ================================================================ */
test("scanner flags the exact host-ui leak Fable's mutation used (apostrophes in comments do not blind it)", () => {
  // The mutation reproduced verbatim, preceded by comments whose apostrophes
  // broke the old `stripStrings`-based scan.
  const fixture = `
    // The caller's resume path re-anchors the viewer; it doesn't await here.
    // We shouldn't swallow the id — but the OLD scan's apostrophes did.
    export function resume() {
      try { thing(); }
      catch (e) {
        console.warn("resume: image failed to load —", e);
      }
    }
  `;
  const found = offenders([]); // no real files
  const shapes = consoleCalls(fixture).map(leakShapes).flat();
  assert.deepEqual(found, []);
  assert.ok(shapes.length > 0, "the raw `…, e)` leak was NOT caught");
});

test("scanner flags e.message, String(e), template ${e}, and a multiline call", () => {
  const fixtures = {
    "member access": `console.error("boom", e.message);`,
    "String() wrap": `console.warn("x " + String(e));`,
    "template interpolation": "console.warn(`load failed: ${e}`);",
    "template member": "console.error(`load failed: ${err.stack}`);",
    "multiline call": `console.warn(
        "resume: image failed to load —",
        error,
      );`,
    "aliased err": `console.warn("janitor: could not delete", err);`,
  };
  for (const [label, src] of Object.entries(fixtures)) {
    const shapes = consoleCalls(src).map(leakShapes).flat();
    assert.ok(shapes.length > 0, `did NOT catch the ${label} leak: ${src}`);
  }
});

test("the scanner recognises all five replay-captured console methods", () => {
  // Guards the CONSOLE_METHODS list itself: if a method is ever dropped from
  // the regex, the call below stops being scanned and this fails — so a future
  // console.log/info/debug leak could not slip past by method name alone.
  for (const m of CONSOLE_METHODS) {
    assert.equal(consoleCalls(`console.${m}("x", e);`).length, 1,
      `console.${m} is not scanned as a call — it dropped out of CONSOLE_METHODS`);
  }
});

test("scanner catches unsafe caught-error forms for console.log/info/debug too", () => {
  // RF-A: PostHog replay captures log/info/debug as well as warn/error. Prove
  // each of the three previously-unscanned methods is caught in at least a
  // bare-error form AND a member/interpolation/String() form. Fixtures, not
  // production edits — production has no log/info/debug sites to mutate.
  const perMethod = {
    log: {
      "bare error": `console.log("resume: image failed to load —", e);`,
      "member access": `console.log("boom", e.message);`,
    },
    info: {
      "aliased bare error": `console.info("janitor: could not delete", err);`,
      "template interpolation": "console.info(`load failed: ${e}`);",
    },
    debug: {
      "bare error": `console.debug("follow failed", error);`,
      "String() wrap": `console.debug("x " + String(ex));`,
    },
  };
  for (const [method, forms] of Object.entries(perMethod)) {
    for (const [label, src] of Object.entries(forms)) {
      const shapes = consoleCalls(src).map(leakShapes).flat();
      assert.ok(shapes.length > 0,
        `console.${method} — the ${label} leak was NOT caught: ${src}`);
    }
  }
});

test("scanner does not flag a properly scrubbed console.log/info/debug call", () => {
  // The new methods must not become false-positive machines either: a scrubbed
  // caught error is clean regardless of which method logs it.
  for (const m of ["log", "info", "debug"]) {
    const src = `console.${m}("firebase write failed:", scrubErrorMessage(e));`;
    assert.deepEqual(consoleCalls(src).map(leakShapes).flat(), [],
      `false positive on a scrubbed console.${m} call: ${src}`);
  }
});

/* ================================================================
 * 5. False-positive resistance — apostrophes/parens/commas/`console.warn(`
 *    inside comments, strings and templates must NOT produce phantom
 *    offenders, and a properly scrubbed call stays clean.
 * ================================================================ */
test("scanner does not flag scrubbed calls, even amid hostile comments/strings", () => {
  const fixtures = [
    // Apostrophes in comments (the old blinding shape) around a SCRUBBED call.
    `// the caller's path doesn't await; we shouldn't leak the SDK's id
     console.warn("resume: image failed to load —", scrubErrorMessage(e));`,
    // A string literal that literally contains "console.warn(... , e)" and an
    // apostrophe — must not be read as code.
    `console.warn("don't log a bare error like console.warn('x', e) here", scrubErrorMessage(e));`,
    // Template with a non-error interpolation (room.phase / next are phase
    // strings, not caught errors).
    "console.error(`Illegal transition ${room.phase} -> ${next}`);",
    // Opaque diag-id line — pool entry, error CLASS (not the error value).
    "console.warn(`Pool entry ${r.poolEntry} failed to load (${r.errorClass}), skipping`);",
    // A comment that mentions console.warn(e) but is not code.
    `// never write console.warn("x", e) — always scrub it first
     console.warn("firebase write failed:", scrubErrorMessage(e));`,
  ];
  for (const src of fixtures) {
    const shapes = consoleCalls(src).map(leakShapes).flat();
    assert.deepEqual(shapes, [], `false positive on:\n${src}`);
  }
});

test("codeSkeleton neutralises comment/string/template text but keeps ${…} code", () => {
  // A `console.warn(` buried in a comment and in a string must vanish; the
  // interpolation expression must survive.
  const src = "// x console.warn( ok\n" +
    'const a = "y console.error(" + `t ${e} u`;';
  const calls = consoleCalls(src);
  assert.equal(calls.length, 0, "phantom console call leaked from a comment/string");
  const skel = codeSkeleton(src);
  assert.ok(skel.includes("${e}".replace("$", "")) || /\be\b/.test(skel),
    "the interpolation expression was blanked away");
  assert.ok(!skel.includes("console.warn("), "comment code leaked into the skeleton");
});
