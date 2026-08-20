// tests/deploy-workflow.test.js — a static contract over the ONE Pages deploy
// workflow. Node has no built-in YAML parser and this repo adds no npm
// dependencies, so this is a lexical/structural contract over the raw workflow
// text. It pins exactly the properties held invariant after the beta lane was
// removed (docs/beta-removal-plan.md §2.5, §4.3): a main-only production
// deploy plus a post-deploy `verify` job that makes green mean live. A
// careless edit fails locally before it can reach production. Actual Actions
// execution remains the final proof; this is the guard that gets us there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const WF_DIR = new URL("../.github/workflows/", import.meta.url);
const readWf = (name) => readFileSync(new URL(name, WF_DIR), "utf8");
const pages = readWf("pages.yml");
const ci = readWf("ci.yml");

const workflowFiles = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f));

/* ---- Split the build job's steps into per-step blocks (no YAML dep) ---- */
// Steps are the 6-space `- name:` / `- uses:` entries under the FIRST
// `    steps:` (the build job's).
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

/* ================= the single-deploy-workflow invariant ================= */

test("exactly ONE workflow deploys Pages (the anti-dueling-deploy guard)", () => {
  const deployers = workflowFiles.filter((f) =>
    /deploy-pages|upload-pages-artifact/.test(readWf(f)));
  assert.deepEqual(deployers, ["pages.yml"],
    "a second Pages deploy workflow would share (or race) the `pages` " +
    "concurrency group — never author one");
});

test("ci.yml is the PR gate and never deploys Pages", () => {
  assert.doesNotMatch(ci, /deploy-pages|upload-pages-artifact|configure-pages/,
    "ci.yml must not touch Pages");
  assert.match(ci, /pull_request/, "ci.yml is still the PR gate");
});

/* ============================ triggers ================================= */

test("pages.yml deploys on main pushes plus workflow_dispatch — and NOTHING else", () => {
  const onBlock = pages.slice(pages.indexOf("\non:"), pages.indexOf("\npermissions:"));
  assert.match(onBlock, /branches:\s*\[main\]/, "must push-trigger on main only");
  assert.match(onBlock, /workflow_dispatch:/, "manual dispatch removed");
});

test("pages.yml has NO pull_request trigger — PRs never deploy", () => {
  const onBlock = pages.slice(pages.indexOf("\non:"), pages.indexOf("\npermissions:"));
  assert.doesNotMatch(onBlock, /pull_request/,
    "a pull_request trigger on the deploy workflow would ship PR heads");
});

/* ============ the beta lane is gone, top to bottom ============ */

test("no `beta` operational string remains anywhere in the deploy workflow", () => {
  // The removal's positive proof: no trigger, input, route, assembly, stamp
  // key, marker, or doc reference reintroduces the retired lane (case-
  // insensitive, so /beta/, rooms-beta, GeoParty Beta all fail here).
  assert.doesNotMatch(pages, /beta/i,
    "the beta lane was removed — no `beta` may reappear in pages.yml");
});

/* ========================= concurrency safety ========================= */

test("concurrency is preserved: group pages, never cancel mid-deploy", () => {
  assert.match(pages, /concurrency:\s*\n\s*group:\s*pages/, "concurrency group changed");
  assert.match(pages, /cancel-in-progress:\s*false/, "runs are no longer serialized");
});

/* ===================== the build: single default checkout ================ */

test("the build checks out github.sha once (default checkout) and tests it", () => {
  const checkout = find(/actions\/checkout@v4/);
  assert.ok(checkout, "no checkout step");
  // No ref: pin — the default checkout is github.sha (single-branch: no
  // cross-ref resolution to protect).
  assert.doesNotMatch(checkout, /ref:/, "the checkout must be the default (github.sha)");
  const check = find(/npm run check/);
  const runTests = find(/npm test/);
  assert.ok(check, "the tree is not syntax-checked");
  assert.ok(runTests, "the tree is not tested");
});

test("ONE release.json stamp is written with EXACTLY {commit, short, deployed_at, run, env}", () => {
  const stamp = find(/Stamp the release/);
  assert.ok(stamp, "no release-stamp step");
  // Every key consent.js/the verify job reads is present…
  for (const k of ["commit", "short", "deployed_at", "run", "env"]) {
    assert.match(stamp, new RegExp("\\b" + k + ":"), `stamp dropped the ${k} key`);
  }
  // …and the retired beta metadata keys are gone.
  assert.doesNotMatch(stamp, /\bchannel:/, "the beta `channel` stamp key must be dropped");
  assert.doesNotMatch(stamp, /\bref:/, "the beta `ref` stamp key must be dropped");
  // The `run` field the verify job matches comes from GITHUB_RUN_ID.
  assert.match(stamp, /GITHUB_RUN_ID/, "the run stamp must come from GITHUB_RUN_ID");
});

/* ================= official actions + versions preserved ================= */

test("first-party Pages actions and the shipped deploy-pages@v4 are kept", () => {
  assert.match(pages, /actions\/configure-pages@v5/);
  assert.match(pages, /actions\/upload-pages-artifact@v3/);
  assert.match(pages, /actions\/deploy-pages@v4/, "deploy-pages version drifted from the shipped v4");
  assert.match(pages, /path:\s*\./, "the artifact must upload the repo root (path: .)");
});

/* =================== the verify job: green means live =================== */
// The replacement for the removed beta lane's pre-production check. These
// lexical pins mean deleting or defanging the only green-means-live guarantee
// goes red locally and in CI (docs/beta-removal-plan.md §4.3).

// Slice out the verify job body: from its `  verify:` header to EOF (it is the
// last job in the file).
function verifyJob() {
  const start = pages.indexOf("\n  verify:");
  assert.ok(start !== -1, "no `verify:` job in pages.yml");
  return pages.slice(start);
}

test("a `verify` job exists and runs only after a successful deploy", () => {
  const job = verifyJob();
  assert.match(job, /needs:\s*deploy/, "verify must depend on deploy (needs: deploy)");
});

test("verify holds no elevated permissions (it only reads a public URL)", () => {
  const job = verifyJob();
  assert.match(job, /permissions:\s*\{\}/, "verify must declare empty permissions");
});

test("verify polls the PUBLIC root release.json and matches THIS run's id + sha", () => {
  const job = verifyJob();
  assert.match(job,
    /https:\/\/earino-assistant\.github\.io\/geoparty\/release\.json/,
    "verify must fetch the public root release.json");
  assert.match(job, /GITHUB_RUN_ID/, "verify must compare against GITHUB_RUN_ID");
  assert.match(job, /GITHUB_SHA/, "verify must compare against GITHUB_SHA");
});

test("verify retries with a bounded attempt count and a sleep between attempts", () => {
  const job = verifyJob();
  // A bounded loop (30 attempts) with a sleep — never an unbounded/instant poll.
  assert.match(job, /seq 1 30/, "verify must bound the retry loop to 30 attempts");
  assert.match(job, /sleep 10/, "verify must sleep 10s between attempts");
});

test("verify uses a FRESH cache-busting query every attempt (the false-red defense)", () => {
  const job = verifyJob();
  // A unique per-attempt query so Fastly's per-URL cache cannot pin a stale/404.
  assert.match(job, /\?verify=\$GITHUB_RUN_ID-\$attempt/,
    "each poll must carry a unique ?verify= cache-buster");
});

test("verify's failure message makes clear the previous deployment is still served", () => {
  const job = verifyJob();
  assert.match(job, /exit 1/, "an exhausted verify must fail the run");
  assert.match(job, /STILL being served|still.*serv/i,
    "the failure message must say the previous deployment is still served");
});

test("deploy has exactly ONE successor job, and it is verify", () => {
  // No other job may depend on deploy and masquerade as the verification gate.
  // Split the file into per-job blocks at each top-level (2-space) job header.
  const lines = pages.split("\n");
  const headerIdx = [];
  lines.forEach((l, i) => { if (/^  \w[\w-]*:\s*$/.test(l)) headerIdx.push(i); });
  const successors = [];
  headerIdx.forEach((start, k) => {
    const name = lines[start].trim().replace(/:$/, "");
    const end = k + 1 < headerIdx.length ? headerIdx[k + 1] : lines.length;
    const body = lines.slice(start + 1, end).join("\n");
    if (/needs:\s*deploy\b/.test(body)) successors.push(name);
  });
  assert.deepEqual(successors, ["verify"],
    "exactly one job (verify) may run after deploy");
});

/* ===== cross-module guard: rooms/ is decided in ONE place ===== */

// Strip comments so a doc comment mentioning a namespace can't trip the guard;
// we only care about live code. The `//`-to-EOL strip also eats `https://…`
// tails, which is harmless — we scan only for the `rooms` namespace tokens.
function jsCode(name) {
  const src = readFileSync(new URL("../js/" + name, import.meta.url), "utf8");
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
const jsFiles = readdirSync(new URL("../js/", import.meta.url)).filter((f) => f.endsWith(".js"));

test("the retired `rooms-beta` namespace literal appears in NO js module", () => {
  for (const f of jsFiles) {
    assert.equal((jsCode(f).match(/rooms-beta/g) || []).length, 0,
      `${f} references the retired rooms-beta namespace`);
  }
});

test("a rooms/ DB path literal is composed ONLY in js/firebase.js (the choke point)", () => {
  // roomRef() builds `rooms/${code}`; no other module may build a rooms/-style
  // Firebase path outside that single composition site.
  for (const f of jsFiles) {
    const hits = (jsCode(f).match(/["'`]rooms(-beta)?\//g) || []).length;
    if (f === "firebase.js") {
      assert.ok(hits >= 1, "firebase.js must compose the rooms/ path in roomRef()");
    } else {
      assert.equal(hits, 0, `${f} builds a rooms/ DB path literal outside roomRef()`);
    }
  }
});
