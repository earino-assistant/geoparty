#!/usr/bin/env node
// pool_health.mjs — weekly, deliberately POLITE pool health check
// (field-observability plan §13). Zero dependencies, Node ≥ 22.
//
// What it does:
//   1. Loads data/location_pool.json.
//   2. Builds a check set: up to 100 field-reported "suspects" (curated
//      from dashboard panel 5 into tools/pool-suspects.json) plus 150
//      rotating-sample entries seeded by ISO week, so the whole pool is
//      swept over roughly a year.
//   3. Asks the Mapillary Graph API whether each id still resolves, at ONE
//      request per ~1.2 s + jitter (≈ 5 minutes of traffic a week).
//   4. Updates consecutive-failure counts in tools/pool-health-state.json.
//      The WORKFLOW persists that file between runs via the Actions cache
//      (never a commit to main), which is what makes the two-strike rule
//      below reachable across weeks — see .github/workflows/pool-health.yml.
//   5. Writes a PROPOSAL: ids dead on ≥ 2 consecutive runs are added to
//      data/pool_quarantine.json. A human reviews the PR — a 404 can be
//      transient Mapillary indigestion, and nothing here auto-merges. Only
//      the quarantine file is committed to the PR; the state file rides the
//      cache.
//
// Politeness rules that are not negotiable:
//   - never more than MAX_REQUESTS ids in one run;
//   - a fixed inter-request delay with jitter, never parallel;
//   - on the third HTTP 429 the run ABORTS CLEANLY (exit 0) and writes
//     nothing — we back all the way off rather than hammer.
//
// Usage:
//   node tools/pool_health.mjs [--dry-run] [--limit N] [--token TOKEN]
//   MAPILLARY_TOKEN=... node tools/pool_health.mjs
//
// This is the only consent-independent signal in the observability system:
// it measures the POOL, not people, so it also covers the users who decline
// analytics and are otherwise invisible (plan §16).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const POOL_FILE = join(ROOT, "data", "location_pool.json");
const QUARANTINE_FILE = join(ROOT, "data", "pool_quarantine.json");
const SUSPECTS_FILE = join(HERE, "pool-suspects.json");
const STATE_FILE = join(HERE, "pool-health-state.json");

const MAX_SUSPECTS = 100;
const SAMPLE_SIZE = 150;
const MAX_REQUESTS = 250;
const DELAY_MS = 1200;
const JITTER_MS = 400;
const RATE_LIMIT_ABORT = 3;      // third 429 → stop the run entirely
const QUARANTINE_AFTER = 2;      // consecutive dead runs before proposing
const REQUEST_TIMEOUT_MS = 15000;

/* ---------------- tiny helpers ---------------- */

const readJson = (path, fallback) => {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
  } catch {
    return fallback;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// FNV-1a — the same hash family pool.js uses, so the rotating sample is
// reproducible from the week number alone.
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ISO-8601 week number: the sample rotates once a week and repeats a year
// later, so the whole pool gets swept without any stored cursor.
export function isoWeekKey(date) {
  const d = new Date(Date.UTC(
    date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Deterministic rotating slice: every entry's rank is a hash of
// (id, week), so each week picks a different, stable, uniform subset.
export function rotatingSample(ids, weekKey, size) {
  return ids
    .map((id) => ({ id, rank: hash(`${weekKey}:${id}`) }))
    .sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : 1))
    .slice(0, size)
    .map((e) => e.id);
}

// The check set: suspects first (they are why we run at all), then the
// rotating sample, deduped, capped at MAX_REQUESTS.
export function buildCheckSet(poolIds, suspects, weekKey) {
  const inPool = new Set(poolIds);
  const set = [];
  const seen = new Set();
  const add = (id) => {
    const s = String(id);
    if (!inPool.has(s) || seen.has(s)) return;
    seen.add(s);
    set.push(s);
  };
  for (const id of suspects.slice(0, MAX_SUSPECTS)) add(id);
  for (const id of rotatingSample(poolIds, weekKey, SAMPLE_SIZE)) add(id);
  return set.slice(0, MAX_REQUESTS);
}

// Fold one run's results into the persisted state: a live id resets its
// counter to zero (transient 404s must not accumulate across months).
export function foldState(prevState, results) {
  const next = { ...(prevState.entries || {}) };
  for (const r of results) {
    if (r.status === "rate_limited" || r.status === "error") continue;
    const cur = next[r.id] || { fails: 0 };
    next[r.id] = r.status === "dead"
      ? { fails: cur.fails + 1, last_seen_dead: r.checked_at }
      : { fails: 0, last_ok: r.checked_at };
  }
  return next;
}

// Quarantine proposal: ids dead on ≥ QUARANTINE_AFTER consecutive runs,
// merged with whatever is already quarantined. Sorted for a stable diff.
export function proposeQuarantine(entries, existing) {
  const out = new Set(existing.map(String));
  for (const [id, e] of Object.entries(entries)) {
    if ((e.fails || 0) >= QUARANTINE_AFTER) out.add(String(id));
  }
  return [...out].sort();
}

/* ---------------- the network part ---------------- */

async function checkId(id, token) {
  const url = `https://graph.mapillary.com/${encodeURIComponent(id)}?fields=id`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `OAuth ${token}`,
        "User-Agent": "geoparty-pool-health (weekly, 1 req/1.2s)",
      },
      signal: ac.signal,
    });
    if (res.status === 429) return "rate_limited";
    if (res.status === 404 || res.status === 400) return "dead";
    if (!res.ok) return "error";     // 5xx / auth — inconclusive, never dead
    const body = await res.json().catch(() => null);
    return body && body.id ? "alive" : "dead";
  } catch {
    return "error";                  // timeout / DNS — inconclusive
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- main ---------------- */

async function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const limitArg = argv.indexOf("--limit");
  const tokenArg = argv.indexOf("--token");
  const token = tokenArg >= 0 ? argv[tokenArg + 1] : process.env.MAPILLARY_TOKEN;

  if (!token) {
    console.error("pool_health: no Mapillary token (--token or MAPILLARY_TOKEN)");
    return 1;
  }

  const pool = readJson(POOL_FILE, []);
  if (!Array.isArray(pool) || !pool.length) {
    console.error("pool_health: location pool missing or empty");
    return 1;
  }
  const poolIds = pool.map((e) => String(e.image_id));
  const suspects = readJson(SUSPECTS_FILE, []);
  const state = readJson(STATE_FILE, { entries: {} });
  const weekKey = isoWeekKey(new Date());

  let checkSet = buildCheckSet(poolIds, Array.isArray(suspects) ? suspects : [],
    weekKey);
  if (limitArg >= 0) checkSet = checkSet.slice(0, Number(argv[limitArg + 1]) || 1);

  console.log(`pool_health: week ${weekKey}, pool ${poolIds.length}, ` +
    `suspects ${suspects.length}, checking ${checkSet.length}`);

  const results = [];
  let rateLimited = 0;
  let aborted = false;

  for (let i = 0; i < checkSet.length; i++) {
    const id = checkSet[i];
    const status = await checkId(id, token);
    results.push({ id, status, checked_at: new Date().toISOString() });

    if (status === "rate_limited") {
      rateLimited++;
      console.log(`::notice::rate limited (${rateLimited}/${RATE_LIMIT_ABORT})`);
      if (rateLimited >= RATE_LIMIT_ABORT) {
        // Back all the way off. Nothing is written: a partial run must not
        // push half-updated counters into the state file.
        console.log("::notice::aborting cleanly after repeated 429s — " +
          "no state written, no PR proposed");
        aborted = true;
        break;
      }
      await sleep(DELAY_MS * 5);
      continue;
    }
    if (i < checkSet.length - 1) {
      await sleep(DELAY_MS + Math.floor((hash(id) % JITTER_MS)));
    }
  }

  const dead = results.filter((r) => r.status === "dead");
  const errors = results.filter((r) => r.status === "error");
  console.log(`pool_health: ${results.length} checked, ${dead.length} dead, ` +
    `${errors.length} inconclusive`);

  if (aborted) return 0;

  const entries = foldState(state, results);
  const existing = readJson(QUARANTINE_FILE, []);
  const proposal = proposeQuarantine(entries,
    Array.isArray(existing) ? existing : []);
  const added = proposal.filter((id) => !existing.includes(id));

  if (dryRun) {
    console.log("pool_health: --dry-run, writing nothing");
    console.log(`would quarantine ${added.length}: ${added.join(", ") || "(none)"}`);
    return 0;
  }

  writeFileSync(STATE_FILE, `${JSON.stringify({
    updated: new Date().toISOString(), week: weekKey, entries,
  }, null, 2)}\n`);

  if (added.length) {
    writeFileSync(QUARANTINE_FILE, `${JSON.stringify(proposal, null, 2)}\n`);
    console.log(`pool_health: proposing ${added.length} new quarantine id(s)`);
  } else {
    console.log("pool_health: nothing new to quarantine");
  }

  // The workflow reads these to decide whether to open a PR.
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT,
      `added=${added.length}\nchecked=${results.length}\ndead=${dead.length}\n`,
      { flag: "a" });
  }
  return 0;
}

// Importable for tests; only runs the network sweep when invoked directly.
if (process.argv[1] && process.argv[1].endsWith("pool_health.mjs")) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
