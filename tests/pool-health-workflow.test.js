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

// Parse a step block's ACTIVE, step-level mapping properties (name/id/if/uses/
// run/…). This is what makes the `if:` assertions honest: a raw substring
// match on the block text is fooled by a commented-out `# if: …` line (it still
// contains the string `if: …`) or by the same text appearing inside a `run:`
// block-scalar body. We instead return only keys that are real YAML step
// properties — at the step indent (8 columns, counting the `- ` marker as two),
// not commented, and not inside a block scalar's body.
function stepProps(block) {
  const props = {};
  let inScalar = false;
  let scalarIndent = 0;
  for (const raw of block.split("\n")) {
    if (raw.trim() === "") continue;
    const indent = raw.length - raw.trimStart().length;
    if (inScalar) {
      if (indent > scalarIndent) continue; // still inside the block-scalar body
      inScalar = false;
    }
    let content = raw.trimStart();
    let propIndent = indent;
    if (content.startsWith("- ")) { content = content.slice(2); propIndent += 2; }
    if (content.startsWith("#")) continue; // a commented line is NOT an active property
    if (propIndent !== 8) continue;        // deeper keys belong to with:/env: maps
    const m = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(content);
    if (!m) continue;
    props[m[1]] = m[2];
    if (/^[|>][+-]?\d*$/.test(m[2])) { inScalar = true; scalarIndent = propIndent; } // run: | etc.
  }
  return props;
}

// The step's active `if:` expression, or undefined when the step has none.
const activeIf = (block) => stepProps(block).if;
// Find the step whose ACTIVE if: matches — not one that merely mentions the
// text in a comment or a run: body.
const findByIf = (re) => BLOCKS.find((b) => re.test(activeIf(b) ?? ""));

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
  assert.equal(activeIf(api), "steps.mode.outputs.mode == 'check'",
    "API check is not gated on check mode via an ACTIVE step if: — Thursday could hit Mapillary");
  // exactly one step invokes the API script
  assert.equal(BLOCKS.filter((b) => /pool_health\.mjs/.test(b)).length, 1);
});

test("the PR is opened ONLY in check mode and only when entries were added", () => {
  const pr = find(/gh pr create/);
  assert.ok(pr, "PR step missing");
  const prIf = activeIf(pr);
  assert.ok(prIf, "PR step has no active if: guard at all");
  assert.match(prIf, /steps\.mode\.outputs\.mode == 'check'/,
    "PR step not gated on check mode via an ACTIVE if: — Thursday could open a PR");
  assert.match(prIf, /steps\.health\.outputs\.added != '0'/,
    "PR step lost its added>0 guard");
});

test("a cache miss warns instead of resetting state silently", () => {
  const restore = find(/actions\/cache\/restore/);
  assert.ok(restore, "restore step missing");
  assert.match(restore, /id:\s*restore/, "restore step has no id to inspect its output");
  const warn = findByIf(/^steps\.restore\.outputs\.cache-matched-key == ''$/);
  assert.ok(warn, "no step ACTIVELY gated on an empty cache-matched-key");
  assert.match(warn, /::warning/, "cache miss does not emit a workflow warning");
});

test("a manual dispatch off main is refused (no silent state fork)", () => {
  const guard = findByIf(/github\.ref != 'refs\/heads\/main'/);
  assert.ok(guard, "no non-main dispatch guard (review A4) as an ACTIVE step if:");
  assert.match(activeIf(guard), /github\.event_name == 'workflow_dispatch'/,
    "guard if: is not scoped to workflow_dispatch");
  assert.match(guard, /exit 1/, "guard does not refuse the run");
});

test("state is saved under a run-id-unique key, and not after a refused dispatch", () => {
  const save = find(/actions\/cache\/save/);
  assert.ok(save, "save step missing");
  assert.match(save, /key:\s*pool-health-state-\$\{\{ github\.run_id \}\}/,
    "save key is not run-id-unique");
  assert.equal(activeIf(save), "always() && steps.restore.outcome == 'success'",
    "save is not guarded via an ACTIVE if: so a refused non-main dispatch would still write state");
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

test("the active-if parser reads real step guards (not vacuous)", () => {
  // The parser must actually find the real guards, or the assertions above pass
  // for the wrong reason (activeIf() === undefined would fool an == undefined).
  const api = find(/pool_health\.mjs/);
  assert.equal(activeIf(api), "steps.mode.outputs.mode == 'check'");
  const save = find(/actions\/cache\/save/);
  assert.equal(activeIf(save), "always() && steps.restore.outcome == 'success'");
  // A step legitimately without an if: (checkout) yields undefined, not a
  // spurious match.
  const checkout = find(/actions\/checkout/);
  assert.equal(activeIf(checkout), undefined, "checkout should have no if:");
});

test("a commented-out or body-buried `# if:` does NOT count as an active guard (mutation)", () => {
  // The exact false-green Advisory #1 flagged: a substring match on the step
  // block is satisfied by the guard text even when it has been commented out or
  // is merely echoed inside a run: body. The active-property parser must reject
  // both. These are string fixtures — the real workflow is left untouched.
  const commentedOut = [
    "      - name: Check pool entries against the Mapillary Graph API",
    "        id: health",
    "        # if: steps.mode.outputs.mode == 'check'   # <- accidentally disabled!",
    "        run: |",
    "          node tools/pool_health.mjs --token \"$TOKEN\"",
    "",
  ].join("\n");
  // A naive substring assertion (the old shape) is fooled …
  assert.match(commentedOut, /if:\s*steps\.mode\.outputs\.mode == 'check'/,
    "sanity: the commented line still contains the guard text");
  // … but the active parser is not: this step has NO active if:, so Thursday
  // could reach the API and the strengthened guard must fail this shape.
  assert.equal(activeIf(commentedOut), undefined,
    "a commented-out `# if:` must not register as an active guard");

  const bodyBuried = [
    "      - name: sneaky echo",
    "        run: |",
    "          echo \"if: steps.mode.outputs.mode == 'check'\"",
    "",
  ].join("\n");
  assert.equal(activeIf(bodyBuried), undefined,
    "text inside a run: block-scalar body must not register as a step-level if:");

  // And the guard-locator built on top of the parser skips both shapes: an
  // unsafe workflow whose only 'check' gate is commented out is not found.
  const fakeBlocks = [commentedOut, bodyBuried];
  const foundActive = fakeBlocks.find(
    (b) => /steps\.mode\.outputs\.mode == 'check'/.test(activeIf(b) ?? ""));
  assert.equal(foundActive, undefined,
    "findByIf-style lookup must not accept a commented / body-buried guard");
});
