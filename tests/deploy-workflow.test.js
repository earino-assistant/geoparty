// tests/deploy-workflow.test.js — a static contract over the ONE Pages deploy
// workflow (beta-deployment-plan §8.2). Node has no built-in YAML parser and
// this repo adds no npm dependencies, so this is a lexical/structural contract
// over the raw workflow text. It pins exactly the properties the plan declares
// invariant, so a careless edit fails locally before it can flap /beta/ or
// break the production bootstrap. Actual Actions execution remains the final
// proof (§8.4); this is the guard that gets us there safely.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WF_DIR = new URL("../.github/workflows/", import.meta.url);
const readWf = (name) => readFileSync(new URL(name, WF_DIR), "utf8");
const pages = readWf("pages.yml");
const ci = readWf("ci.yml");

const workflowFiles = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f));

/* ---- Split the build job's steps into per-step blocks (no YAML dep) ---- */
// Steps are the 6-space `- name:` / `- uses:` entries under `    steps:`.
function buildSteps() {
  const lines = pages.split("\n");
  const start = lines.findIndex((l) => /^    steps:\s*$/.test(l));
  assert.ok(start !== -1, "could not find the build job's steps: block");
  const blocks = [];
  let cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^  \S/.test(l) || /^\S/.test(l)) break; // dedented out of the job/steps
    if (/^      - /.test(l)) {
      if (cur) blocks.push(cur);
      cur = l + "\n";
    } else if (cur !== null) {
      cur += l + "\n";
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}
const BLOCKS = buildSteps();
const find = (re) => BLOCKS.find((b) => re.test(b));

// The step-level `if:` guard of a block (at the 8-column step-property indent),
// ignoring commented lines and run:-body text.
function activeIf(block) {
  for (const raw of block.split("\n")) {
    let content = raw.trimStart();
    let indent = raw.length - content.length;
    if (content.startsWith("- ")) { content = content.slice(2); indent += 2; }
    if (indent !== 8 || content.startsWith("#")) continue;
    const m = /^if:\s?(.*)$/.exec(content);
    if (m) return m[1].trim();
  }
  return undefined;
}

/* ================= the single-deploy-workflow invariant ================= */

test("exactly ONE workflow deploys Pages (the anti-dueling-deploy guard)", () => {
  const deployers = workflowFiles.filter((f) =>
    /deploy-pages|upload-pages-artifact/.test(readWf(f)));
  assert.deepEqual(deployers, ["pages.yml"],
    "a second Pages deploy workflow would share (or race) the `pages` " +
    "concurrency group and flap /beta/ — never author one");
});

test("ci.yml is the PR gate and never deploys Pages", () => {
  assert.doesNotMatch(ci, /deploy-pages|upload-pages-artifact|configure-pages/,
    "ci.yml must not touch Pages");
  assert.match(ci, /pull_request/, "ci.yml is still the PR gate");
});

/* ============================ triggers ================================= */

test("pages.yml deploys on main AND beta pushes plus workflow_dispatch", () => {
  const onBlock = pages.slice(pages.indexOf("\non:"), pages.indexOf("\npermissions:"));
  assert.match(onBlock, /branches:\s*\[main,\s*beta\]/, "must push-trigger on main and beta");
  assert.match(onBlock, /workflow_dispatch:/, "manual dispatch removed");
  assert.match(onBlock, /include_beta:/, "dispatch lost the include_beta input");
  assert.match(onBlock, /type:\s*boolean/, "include_beta is not a boolean input");
});

test("pages.yml has NO pull_request trigger — PRs never deploy", () => {
  const onBlock = pages.slice(pages.indexOf("\non:"), pages.indexOf("\npermissions:"));
  assert.doesNotMatch(onBlock, /pull_request/,
    "a pull_request trigger on the deploy workflow would ship PR heads");
});

/* ========================= concurrency safety ========================= */

test("concurrency is preserved: group pages, never cancel mid-deploy", () => {
  assert.match(pages, /concurrency:\s*\n\s*group:\s*pages/, "concurrency group changed");
  assert.match(pages, /cancel-in-progress:\s*false/, "runs are no longer serialized");
});

/* ================= immutable-SHA resolve + dual trees ================= */

test("the build resolves BOTH branch tips once, via ls-remote, main required", () => {
  const refs = find(/id:\s*refs/);
  assert.ok(refs, "no ref-resolution step");
  assert.match(refs, /git ls-remote/, "tips are not resolved with ls-remote");
  assert.match(refs, /refs\/heads\/main refs\/heads\/beta/, "does not resolve both heads at once");
  assert.match(refs, /test -n "\$main_sha"/, "main is not asserted to exist");
  // The exact expression is pinned + evaluated in the INCLUDE_BETA suite
  // below; here we assert the shell consumes it to DROP beta only when it is
  // not the literal `true`.
  assert.match(refs, /\[ "\$INCLUDE_BETA" = "true" \] \|\| beta_sha=""/,
    "beta must be dropped only when INCLUDE_BETA is not literally true");
  assert.match(refs, /main=\$main_sha/, "main sha not exported");
  assert.match(refs, /beta=\$beta_sha/, "beta sha not exported");
});

/* ============ the INCLUDE_BETA guard: exact + evaluated ============ */
// The guard decides whether /beta/ ships. Its previous form,
// `inputs.include_beta != false`, was BROKEN on push events: `inputs` is null
// there, so `inputs.include_beta` is null and — under GitHub's loose equality
// (null == false) — `!= false` was `false`, silently clearing beta on every
// push to main/beta. These tests pin the corrected expression AND evaluate it
// under a faithful subset of GitHub Actions expression semantics for the
// three contexts it must serve, so a regression to any always-substring-
// present-but-wrong form fails here, not in production.

// Pull the raw expression out of `INCLUDE_BETA: ${{ ... }}`.
function includeBetaExpr() {
  const m = /INCLUDE_BETA:\s*\$\{\{\s*(.+?)\s*\}\}/.exec(pages);
  assert.ok(m, "no INCLUDE_BETA expression found in the workflow");
  return m[1].trim();
}

// --- a faithful subset of GitHub Actions expression evaluation ---
// Context lookups null-propagate (accessing a property of null yields null,
// never an error — this is exactly why the push case must not throw).
function ghProp(ctx, path) {
  return path.split(".").reduce((o, k) => (o == null ? null : o[k]), ctx);
}
// GitHub truthiness: booleans as-is; null/'' falsy; non-zero numbers and
// non-empty strings truthy. Enough for the boolean operands here.
function ghTruthy(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v !== "";
  return true;
}
function evalTerm(src, ctx) {
  if (/^'.*'$/.test(src)) return src.slice(1, -1); // string literal
  if (src === "true") return true;
  if (src === "false") return false;
  return ghProp(ctx, src); // dotted context path (github.*, inputs.*)
}
function evalOperand(src, ctx) {
  const neq = src.split("!=");
  if (neq.length === 2) {
    // string-vs-string inequality (the only comparison in this guard)
    return evalTerm(neq[0].trim(), ctx) !== evalTerm(neq[1].trim(), ctx);
  }
  return evalTerm(src, ctx);
}
// Evaluate `<left> || <right>` with GitHub's OR semantics: return the left
// operand when truthy (short-circuit — the right, `inputs.*`, is never even
// resolved on push), else the right operand.
function evalIncludeBeta(expr, ctx) {
  const m = /^(.+?)\s*\|\|\s*(.+)$/.exec(expr);
  assert.ok(m, "INCLUDE_BETA is not an OR expression");
  const left = evalOperand(m[1].trim(), ctx);
  return ghTruthy(left) ? left : evalOperand(m[2].trim(), ctx);
}
// How Actions substitutes the result into the env string the shell then reads.
const ghString = (v) => (v === null || v === undefined ? "" : String(v));

const PUSH = { github: { event_name: "push" }, inputs: null };
const DISPATCH_DEFAULT = {
  github: { event_name: "workflow_dispatch" }, inputs: { include_beta: true },
};
const DISPATCH_OFF = {
  github: { event_name: "workflow_dispatch" }, inputs: { include_beta: false },
};

test("INCLUDE_BETA is the exact GitHub-correct guard expression", () => {
  assert.equal(includeBetaExpr(),
    "github.event_name != 'workflow_dispatch' || inputs.include_beta",
    "the beta guard must short-circuit on non-dispatch events; " +
    "`inputs.include_beta != false` is FALSE on push (inputs is null)");
});

test("INCLUDE_BETA resolves to \"true\" on a push (beta never silently cleared)", () => {
  // The regression the old expression caused: this is the case that broke.
  assert.equal(ghString(evalIncludeBeta(includeBetaExpr(), PUSH)), "true");
});

test("INCLUDE_BETA resolves to \"true\" on a default/true workflow_dispatch", () => {
  assert.equal(ghString(evalIncludeBeta(includeBetaExpr(), DISPATCH_DEFAULT)), "true");
});

test("INCLUDE_BETA resolves to \"false\" ONLY on an explicit include_beta=false dispatch", () => {
  assert.equal(ghString(evalIncludeBeta(includeBetaExpr(), DISPATCH_OFF)), "false");
});

test("the shell drops beta only when INCLUDE_BETA is not literally \"true\"", () => {
  // Cross-check the env→shell contract: the three env values above feed
  // `[ "$INCLUDE_BETA" = "true" ] || beta_sha=""`, so beta survives push and
  // default dispatch and is cleared only on the emergency hatch.
  const drop = (env) => env !== "true"; // beta_sha="" iff not literal true
  assert.equal(drop(ghString(evalIncludeBeta(includeBetaExpr(), PUSH))), false);
  assert.equal(drop(ghString(evalIncludeBeta(includeBetaExpr(), DISPATCH_DEFAULT))), false);
  assert.equal(drop(ghString(evalIncludeBeta(includeBetaExpr(), DISPATCH_OFF))), true);
});

test("check+test run against TWO distinct working directories", () => {
  const prodCheck = find(/working-directory:\s*prod/);
  const betaCheck = find(/working-directory:\s*beta-tree/);
  assert.ok(prodCheck, "no production-tree check step");
  assert.ok(betaCheck, "no beta-tree check step");
  for (const step of [prodCheck, betaCheck]) {
    assert.match(step, /npm run check/, "a tree is not syntax-checked");
    assert.match(step, /npm test/, "a tree is not tested");
  }
  // The production checkout is pinned to the resolved main SHA, not a branch.
  const prodCheckout = find(/path:\s*prod/);
  assert.match(prodCheckout, /ref:\s*\$\{\{ steps\.refs\.outputs\.main \}\}/,
    "production tree is not pinned to the resolved main SHA");
});

test("TWO release.json stamps are written, each with a channel field", () => {
  const stamp = find(/Stamp releases/);
  assert.ok(stamp, "no release-stamp step");
  assert.match(stamp, /"_site"[\s\S]*"production"[\s\S]*"main"/,
    "root stamp missing production/main channel+ref");
  assert.match(stamp, /"_site\/beta"[\s\S]*"beta"[\s\S]*"beta"/,
    "beta stamp missing beta channel+ref");
  // Existing consumed keys are preserved.
  for (const k of ["commit", "short", "deployed_at"]) {
    assert.match(stamp, new RegExp(k + ":"), `stamp dropped the ${k} key consent.js reads`);
  }
});

/* =============== the no-beta-until-branch-exists bootstrap =============== */

test("beta-only steps carry the step-level branch-exists guard (bootstrap)", () => {
  // The bootstrap invariant: with no beta branch, beta_sha is '' and every
  // step that would fail or do wrong work without a beta tree is SKIPPED —
  // production deploys unchanged. The checkout, the check/test and the marker
  // steps must carry the step-level `if:` guard.
  const GUARD = "steps.refs.outputs.beta != ''";
  const mustGuard = [
    ["beta checkout", find(/path:\s*beta-tree/)],
    ["beta check+test", find(/working-directory:\s*beta-tree/)],
    ["beta markers", find(/Stamp beta markers/)],
  ];
  for (const [label, step] of mustGuard) {
    assert.ok(step, `missing the ${label} step`);
    assert.equal(activeIf(step), GUARD,
      `the ${label} step is not guarded on the branch-exists output`);
  }
});

test("always-run steps that touch beta guard it INTERNALLY (no empty beta dir)", () => {
  // Assembly and the release stamp run on every deploy but must only produce
  // a /beta/ tree / beta stamp WHEN the branch exists — otherwise a
  // main-only deploy would ship an empty or half-stamped beta directory.
  const assemble = find(/Assemble _site/);
  assert.match(assemble, /if \[ -n "\$\{\{ steps\.refs\.outputs\.beta \}\}" \]/,
    "assembly must shell-guard the _site/beta copy on the branch-exists output");
  const stamp = find(/Stamp releases/);
  assert.match(stamp, /if \(process\.env\.BETA_SHA\)/,
    "the beta release stamp must be guarded on BETA_SHA being set");
});

test("beta markers are fail-loud: manifest-name assert + noindex on every head", () => {
  const markers = find(/Stamp beta markers/);
  assert.ok(markers, "no beta-markers step");
  assert.match(markers, /GeoParty Beta/, "beta manifest name is not rewritten");
  assert.match(markers, /noindex/, "beta pages are not de-indexed");
  assert.match(markers, /throw new Error/, "marker drift does not fail the build");
  assert.match(markers, /<head>/, "noindex is not anchored on <head>");
});

/* ================= official actions + versions preserved ================= */

test("first-party Pages actions and the shipped deploy-pages@v4 are kept", () => {
  assert.match(pages, /actions\/configure-pages@v5/);
  assert.match(pages, /actions\/upload-pages-artifact@v3/);
  assert.match(pages, /actions\/deploy-pages@v4/, "deploy-pages version drifted from the shipped v4");
  assert.match(pages, /path:\s*_site/, "the artifact must upload the assembled _site, not the repo root");
});

/* ===== cross-module guard: rooms/ is decided in ONE place (§8.2) ===== */

// Strip comments so a doc comment mentioning a namespace can't trip the guard;
// we only care about live code. The `//`-to-EOL strip also eats `https://…`
// tails, which is harmless — we scan only for the `rooms` namespace tokens.
function jsCode(name) {
  const src = readFileSync(new URL("../js/" + name, import.meta.url), "utf8");
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
const jsFiles = readdirSync(new URL("../js/", import.meta.url)).filter((f) => f.endsWith(".js"));

test("the `rooms-beta` namespace literal lives ONLY in js/channel.js", () => {
  for (const f of jsFiles) {
    const hits = (jsCode(f).match(/rooms-beta/g) || []).length;
    if (f === "channel.js") assert.ok(hits >= 1, "channel.js must define rooms-beta");
    else assert.equal(hits, 0, `${f} hardcodes the rooms-beta namespace — route through roomsRoot()`);
  }
});

test("no module hardcodes a rooms/ DB path — every room path composes via roomsRoot()", () => {
  // A `"rooms/` or `` `rooms-beta/ `` literal would be a Firebase path built
  // outside the choke point. roomRef() builds `${ROOMS_ROOT}/${code}`, so no
  // such literal may exist anywhere.
  for (const f of jsFiles) {
    assert.doesNotMatch(jsCode(f), /["'`]rooms(-beta)?\//,
      `${f} builds a rooms/ DB path literal outside roomRef()`);
  }
});

test("roomsRoot() is called in exactly one place — the Firebase choke point", () => {
  const callers = jsFiles.filter((f) => f !== "channel.js" && /roomsRoot\s*\(/.test(jsCode(f)));
  assert.deepEqual(callers, ["firebase.js"],
    "roomsRoot() must be called only by js/firebase.js (roomRef is the sole namespace decision site)");
});
