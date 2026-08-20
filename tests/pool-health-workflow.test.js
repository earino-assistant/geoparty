// tests/pool-health-workflow.test.js — a static contract over the pool-health
// GitHub Actions workflow (review RF-2). Node has no built-in YAML parser and
// this repo adds no npm dependencies, so this is a lexical/structural contract
// over the raw workflow text: a light step-splitter plus targeted assertions.
// It proves the SCHEDULE and CONDITIONAL wiring the review asked for —
//   - Monday runs the API check; Thursday only refreshes the cache.
//   - The midweek refresh cannot hit the API or open a PR.
//   - A cache miss warns loudly instead of resetting state silently.
//   - A manual dispatch off main is refused (no silent state fork).
//   - Concurrency serialization, run-id-unique keys, and the never-auto-merge
//     / no-CI PR warnings all survive.
// Actual Actions execution remains the final proof; this pins the structure so
// a careless edit that re-opens P1-4 fails locally first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const wf = readFileSync(
  new URL("../.github/workflows/pool-health.yml", import.meta.url), "utf8");

// Split the job's `steps:` list into per-step blocks. Steps are the 6-space
// `- name:` / `- uses:` entries under `    steps:`. Good enough to attribute an
// `if:` / `run:` to the step it guards without a YAML parser.
function steps() {
  const lines = wf.split("\n");
  const start = lines.findIndex((l) => /^    steps:\s*$/.test(l));
  assert.ok(start !== -1, "could not find the job's steps: block");
  const blocks = [];
  let cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\S/.test(l)) break; // dedented out of the job
    if (/^      - /.test(l)) { // new step
      if (cur) blocks.push(cur);
      cur = l + "\n";
    } else if (cur !== null) {
      cur += l + "\n";
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}

const BLOCKS = steps();
const find = (re) => BLOCKS.find((b) => re.test(b));

test("both schedules are wired: Monday full check + Thursday refresh", () => {
  assert.match(wf, /cron:\s*"13 4 \* \* 1"/, "Monday weekly cron missing");
  assert.match(wf, /cron:\s*"13 4 \* \* 4"/, "Thursday midweek refresh cron missing");
  assert.match(wf, /workflow_dispatch:/, "manual dispatch removed");
});

test("run mode is derived from the Thursday cron and defaults to check", () => {
  const mode = find(/id:\s*mode/);
  assert.ok(mode, "no run-mode step");
  assert.match(mode, /github\.event\.schedule.*=.*"13 4 \* \* 4"/s,
    "mode is not keyed on the Thursday cron");
  assert.match(mode, /mode=refresh/, "Thursday does not select refresh mode");
  assert.match(mode, /mode=check/, "no check-mode fallback (Monday/manual)");
});

test("the API check runs ONLY in check mode", () => {
  const api = find(/pool_health\.mjs/);
  assert.ok(api, "API check step missing");
  assert.match(api, /if:\s*steps\.mode\.outputs\.mode == 'check'/,
    "API check is not gated on check mode — Thursday could hit Mapillary");
  // exactly one step invokes the API script
  assert.equal(BLOCKS.filter((b) => /pool_health\.mjs/.test(b)).length, 1);
});

test("the PR is opened ONLY in check mode and only when entries were added", () => {
  const pr = find(/gh pr create/);
  assert.ok(pr, "PR step missing");
  assert.match(pr, /steps\.mode\.outputs\.mode == 'check'/,
    "PR step not gated on check mode — Thursday could open a PR");
  assert.match(pr, /steps\.health\.outputs\.added != '0'/,
    "PR step lost its added>0 guard");
});

test("a cache miss warns instead of resetting state silently", () => {
  const restore = find(/actions\/cache\/restore/);
  assert.ok(restore, "restore step missing");
  assert.match(restore, /id:\s*restore/, "restore step has no id to inspect its output");
  const warn = find(/if:\s*steps\.restore\.outputs\.cache-matched-key == ''/);
  assert.ok(warn, "no step gated on an empty cache-matched-key");
  assert.match(warn, /::warning/, "cache miss does not emit a workflow warning");
});

test("a manual dispatch off main is refused (no silent state fork)", () => {
  const guard = find(/github\.ref != 'refs\/heads\/main'/);
  assert.ok(guard, "no non-main dispatch guard (review A4)");
  assert.match(guard, /github\.event_name == 'workflow_dispatch'/,
    "guard is not scoped to workflow_dispatch");
  assert.match(guard, /exit 1/, "guard does not refuse the run");
});

test("state is saved under a run-id-unique key, and not after a refused dispatch", () => {
  const save = find(/actions\/cache\/save/);
  assert.ok(save, "save step missing");
  assert.match(save, /key:\s*pool-health-state-\$\{\{ github\.run_id \}\}/,
    "save key is not run-id-unique");
  assert.match(save, /if:\s*always\(\) && steps\.restore\.outcome == 'success'/,
    "save is not guarded so a refused non-main dispatch would still write state");
  // restore uses the same run-id key + prefix restore-keys
  const restore = find(/actions\/cache\/restore/);
  assert.match(restore, /key:\s*pool-health-state-\$\{\{ github\.run_id \}\}/);
  assert.match(restore, /restore-keys:/);
});

test("concurrency serialization and run-id-unique PR branch are preserved", () => {
  assert.match(wf, /concurrency:\s*\n\s*group:\s*pool-health/,
    "concurrency group changed");
  assert.match(wf, /cancel-in-progress:\s*false/, "runs are no longer serialized");
  const pr = find(/gh pr create/);
  assert.match(pr, /BRANCH="pool-health\/\$\(date -u \+%Y-%m-%d\)-\$\{\{ github\.run_id \}\}"/,
    "PR branch is no longer run-id-unique");
});

test("the PR stays never-auto-merged with the no-CI warning, and only quarantine data is committed", () => {
  const pr = find(/gh pr create/);
  assert.match(pr, /never auto-merged/i, "lost the never-auto-merged statement");
  assert.match(pr, /CI does not run on this PR/i, "lost the no-CI warning");
  assert.match(pr, /git add data\/pool_quarantine\.json/, "PR commits more than the quarantine proposal");
  assert.doesNotMatch(pr, /git add .*pool-health-state\.json/, "PR must not commit the state file");
});
