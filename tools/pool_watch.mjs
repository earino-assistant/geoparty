#!/usr/bin/env node
// pool_watch.mjs — DAILY early-warning pool watcher (the fast lane of the
// two-lane pool-health system; field-observability plan §13). Zero
// dependencies, Node ≥ 22. Ported from the CTO's out-of-repo Python watcher
// (owner decision 2026-08-29) so it is auditable next to tools/pool_health.mjs,
// the WEEKLY lane it complements.
//
// The two lanes, one sentence each:
//   • pool_health.mjs (WEEKLY) — polite sweep, proposes a PR a human reviews;
//     never auto-merges.
//   • pool_watch.mjs (DAILY, this file) — reacts to a live field signal within
//     hours and, under the bounded conditions below, auto-quarantines + pushes.
//
// Pipeline every run (stateless — reads everything fresh):
//   1. PostHog EU (project 252836) HogQL: trailing WINDOW_HOURS of
//      `imagery_load` events grouped by the opaque `pool_entry`. A candidate is
//      an entry with ≥ MIN_FAILS failures AND ZERO successes in the window (a
//      live entry cannot satisfy that — someone always gets through).
//   2. OUTAGE GUARD: if the window's failure share is above OUTAGE_PCT (and more
//      than OUTAGE_MIN_FAILS failures), that is a Mapillary-wide incident, not
//      pool rot — print an outage report, quarantine NOTHING, exit 0.
//   3. Reverse-map the opaque poolDiagId → raw Mapillary image id LOCALLY, from
//      the repo's own pool file (the mapping never leaves this machine; PostHog
//      only ever held the pseudonym). We do NOT invert the hash — that is a
//      one-way FNV fold — we build the forward table (poolDiagId of every pool
//      id) and look the pseudonym up, exactly as tools/diag_lookup.mjs does.
//   4. Verify with the SAME SDK-faithful full-field probe pool_health.mjs uses
//      (its exported fetchGraph + classifyGraphResponse over the exact
//      SDK_FIELDS set) — the precise gap that let image 144692807618687 /
//      poolDiagId crcrtne4 slip past the old thumb-only ping. Two attempts
//      VERIFY_DELAY_MS apart; dead ONLY when BOTH attempts return a death
//      verdict and neither says alive. A 429/401/network error, or a 5xx the
//      Graph API does not flag is_transient, is NEVER evidence (inconclusive →
//      candidate dropped). This is deliberately MORE conservative than the
//      original Python, which treated any 5xx as death — the shared probe's
//      "a 5xx we cannot confirm transient is never pool rot" rule wins.
//   5. Already-quarantined ids are skipped silently (no double action).
//   6. On confirmation: append to data/pool_quarantine.json, commit, push
//      origin main. OUTPUT CONTRACT (this runs under an external scheduler with
//      no agent watching): print a report ONLY when a quarantine happened, the
//      outage guard tripped, or a check failed. A healthy run prints NOTHING.
//
// Credentials (precedence, documented per owner directive):
//   POSTHOG_PERSONAL_API_KEY — env var FIRST; else the KEY=value line in the
//     local env file (POOL_WATCH_ENV_FILE, default ~/.env).
//   MAPILLARY_TOKEN — env var FIRST; else the repo's config.js export (the same
//     public embeddable token the game ships with).
//   A secret is NEVER printed: all report output is scrubbed before it leaves.
//
// Flags:
//   --dry-run            run steps 1–4, print what WOULD be quarantined, write
//                        nothing, commit nothing, push nothing.
//   --suspects <file>    operator VERIFICATION override: a JSON array of raw
//                        image ids fed straight into the probe (steps 1–2 —
//                        PostHog + outage guard — are skipped). Mirrors
//                        tools/pool-suspects.json; use with --dry-run to sanity
//                        the probe against known-dead / known-alive ids.
//
// Usage:
//   node tools/pool_watch.mjs                 # the scheduled fast lane
//   node tools/pool_watch.mjs --dry-run
//   node tools/pool_watch.mjs --dry-run --suspects /tmp/suspects.json

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { poolDiagId } from "../js/imagery.js";
import { fetchGraph, classifyGraphResponse } from "./pool_health.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const POOL_FILE = join(ROOT, "data", "location_pool.json");
const QUARANTINE_FILE = join(ROOT, "data", "pool_quarantine.json");
const CONFIG_FILE = join(ROOT, "config.js");
const ENV_FILE = process.env.POOL_WATCH_ENV_FILE || join(homedir(), ".env");

const POSTHOG_HOST = "https://eu.i.posthog.com";
const POSTHOG_PROJECT = "252836"; // GeoParty EU project

const WINDOW_HOURS = 6;
const MIN_FAILS = 3;        // one unlucky player can produce 2; crcrtne4 made 6
const OUTAGE_PCT = 40;      // failure share above this = platform incident
const OUTAGE_MIN_FAILS = 6; // …and only when there is real volume behind it
const VERIFY_ATTEMPTS = 2;
const VERIFY_DELAY_MS = 3000;
const QUERY_TIMEOUT_MS = 60000;

// The two labels from classifyGraphResponse that count as death evidence. A
// "transient_5xx" is the incident shape (is_transient:true) and needs the
// second attempt to confirm; a "dead" is a 404 / empty-data (id gone). Anything
// else ("alive", "rate_limited", "error") is never evidence of pool rot.
const DEATH_LABELS = new Set(["dead", "transient_5xx"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- tiny helpers ---------------- */

const readJson = (path, fallback) => {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
  } catch {
    return fallback;
  }
};

// Replace every known secret with a placeholder so a token can never ride out
// in a report line, even if it somehow got interpolated into one.
export function scrub(text, secrets) {
  let out = String(text);
  for (const s of secrets || []) {
    if (s) out = out.split(s).join("«token»");
  }
  return out;
}

/* ---------------- credentials (env first, then local file) ---------------- */

// Pull a KEY=value out of an ~/.env-style file. Never throws; missing file or
// key → "".
function readEnvValue(file, key) {
  try {
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      const line = raw.trim();
      if (line.startsWith(`${key}=`)) {
        return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* no file — fall through to "" */
  }
  return "";
}

function posthogKey() {
  const fromEnv = process.env.POSTHOG_PERSONAL_API_KEY;
  if (fromEnv) return fromEnv;
  const fromFile = readEnvValue(ENV_FILE, "POSTHOG_PERSONAL_API_KEY");
  if (fromFile) return fromFile;
  throw new Error("no POSTHOG_PERSONAL_API_KEY (env or " + ENV_FILE + ")");
}

function mapillaryToken() {
  const fromEnv = process.env.MAPILLARY_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const m = /MAPILLARY_TOKEN\s*=\s*["']([^"']+)["']/.exec(
      readFileSync(CONFIG_FILE, "utf8"));
    if (m) return m[1];
  } catch {
    /* fall through */
  }
  throw new Error("no MAPILLARY_TOKEN (env or config.js)");
}

/* ---------------- pure decision pieces (unit-tested) ---------------- */

// The HogQL rows come back as positional arrays: [pool, fails, oks, failSess].
// A candidate is an entry that failed at least `minFails` times and succeeded
// ZERO times in the window — the shape a live entry can never take.
export function selectCandidates(rows, minFails = MIN_FAILS) {
  const out = [];
  for (const row of rows || []) {
    const [pool, fails, oks, failSess] = row;
    if (!pool) continue;
    if (Number(fails) >= minFails && Number(oks) === 0) {
      out.push({
        pool: String(pool),
        fails: Number(fails),
        oks: Number(oks),
        failSessions: Number(failSess) || 0,
      });
    }
  }
  return out;
}

// The traffic-level outage guard: a window whose failure share is above
// OUTAGE_PCT, backed by real volume (> OUTAGE_MIN_FAILS failures), is a
// Mapillary incident, not one rotten entry. Pure.
export function isTrafficOutage(totalFails, total, opts = {}) {
  const pct = opts.pct ?? OUTAGE_PCT;
  const minFails = opts.minFails ?? OUTAGE_MIN_FAILS;
  if (!total || totalFails <= minFails) return false;
  return (100 * totalFails) / total > pct;
}

// Build the LOCAL reverse table diagId → [raw image id, …]. The forward hash is
// the canonical poolDiagId from js/imagery.js (single source of truth — a local
// re-implementation could silently drift from the one the client actually
// ships). Collisions are astronomically unlikely at pool scale but handled: an
// entry keeps every raw id that folds to it.
export function buildReverseTable(pool) {
  const rev = new Map();
  for (const entry of Array.isArray(pool) ? pool : []) {
    const raw = entry && entry.image_id != null ? String(entry.image_id) : "";
    if (!raw) continue;
    const key = poolDiagId(raw);
    if (!rev.has(key)) rev.set(key, []);
    rev.get(key).push(raw);
  }
  return rev;
}

// Collapse a sequence of per-attempt probe labels into one verdict. The probe
// stops early on the first decisive attempt, so `labels` is what actually ran:
//   any "alive"                      → "alive"        (decisively live)
//   any non-death label (429/error)  → "inconclusive" (never evidence)
//   all death labels, `attempts` of  → "dead"         (both attempts failed)
//   fewer death labels than attempts → "inconclusive" (not confirmed twice)
// Pure, total.
export function classifyProbeAttempts(labels, attempts = VERIFY_ATTEMPTS) {
  const ls = labels || [];
  if (!ls.length) return "inconclusive";
  for (const l of ls) {
    if (l === "alive") return "alive";
    if (!DEATH_LABELS.has(l)) return "inconclusive";
  }
  return ls.length >= attempts ? "dead" : "inconclusive";
}

/* ---------------- network parts ---------------- */

async function queryHogql(sql, key) {
  const url = `${POSTHOG_HOST}/api/projects/${POSTHOG_PROJECT}/query/`;
  const body = JSON.stringify({ query: { kind: "HogQLQuery", query: sql } });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), QUERY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body,
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`PostHog query HTTP ${res.status}`);
    const data = await res.json();
    return data.results || [];
  } finally {
    clearTimeout(timer);
  }
}

// Verify one raw id against the SDK-faithful probe. Returns "dead" | "alive" |
// "inconclusive". Two attempts VERIFY_DELAY_MS apart, short-circuiting the
// moment an attempt is decisively alive or inconclusive. `opts.fetcher` and
// `opts.delayMs` are injection seams for tests (network stays stubbed).
export async function verifyDead(rawId, token, opts = {}) {
  const fetcher = opts.fetcher || fetchGraph;
  const delayMs = opts.delayMs ?? VERIFY_DELAY_MS;
  const attempts = opts.attempts ?? VERIFY_ATTEMPTS;
  const labels = [];
  for (let i = 0; i < attempts; i++) {
    const { status, body } = await fetcher(rawId, token);
    const label = classifyGraphResponse(status, body);
    labels.push(label);
    // Stop early: a live id is decided, and an inconclusive attempt can never
    // become evidence — only a fresh death confirming a prior death matters.
    if (label === "alive" || !DEATH_LABELS.has(label)) break;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return classifyProbeAttempts(labels, attempts);
}

// The HogQL: trailing-window imagery_load, grouped by opaque pool_entry.
function windowQuery() {
  return (
    "SELECT JSONExtractString(properties, 'pool_entry') AS pool, " +
    "countIf(JSONExtractString(properties, 'ok') = 'false') AS fails, " +
    "countIf(JSONExtractString(properties, 'ok') = 'true') AS oks, " +
    "uniqExactIf(properties.\"$session_id\", " +
    "  JSONExtractString(properties, 'ok') = 'false') AS fail_sess " +
    "FROM events WHERE event = 'imagery_load' " +
    `AND timestamp >= now() - INTERVAL ${WINDOW_HOURS} HOUR ` +
    "AND JSONExtractString(properties, 'pool_entry') != '' " +
    "GROUP BY pool"
  );
}

/* ---------------- main ---------------- */

async function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const suspectsIdx = argv.indexOf("--suspects");
  const suspectsFile = suspectsIdx >= 0 ? argv[suspectsIdx + 1] : null;

  const report = [];
  const secrets = [];
  const flush = () => {
    for (const line of report) console.log(scrub(line, secrets));
  };

  const pool = readJson(POOL_FILE, []);
  if (!Array.isArray(pool) || !pool.length) {
    console.error("pool_watch: location pool missing or empty");
    return 1;
  }
  const reverse = buildReverseTable(pool);
  const quarantined = new Set(
    (Array.isArray(readJson(QUARANTINE_FILE, [])) ? readJson(QUARANTINE_FILE, []) : [])
      .map(String));

  // 1–2. Candidate discovery. Normally from PostHog + the outage guard; the
  // --suspects override feeds raw ids straight into the probe for verification.
  let candidates = []; // [{ raw, pool, fails, failSessions }]

  if (suspectsFile) {
    const rawIds = readJson(suspectsFile, []);
    if (!Array.isArray(rawIds)) {
      console.error(`pool_watch: --suspects ${suspectsFile} is not a JSON array`);
      return 1;
    }
    candidates = rawIds.map(String).map((raw) => ({
      raw, pool: poolDiagId(raw), fails: null, failSessions: null,
    }));
    report.push(`pool_watch: --suspects override — probing ${candidates.length} ` +
      `id(s) from ${suspectsFile} (PostHog query + outage guard skipped)`);
  } else {
    let key;
    try {
      key = posthogKey();
    } catch (e) {
      report.push(`pool_watch: ${e.message}`);
      flush();
      return 1;
    }
    secrets.push(key);

    let rows;
    try {
      rows = await queryHogql(windowQuery(), key);
    } catch (e) {
      report.push(`pool_watch: PostHog query FAILED: ${e.message}`);
      flush();
      return 1;
    }

    if (!rows.length) {
      flush();          // nothing but the (empty) report — silence on healthy
      return 0;
    }

    const totalFails = rows.reduce((n, r) => n + Number(r[1] || 0), 0);
    const totalOks = rows.reduce((n, r) => n + Number(r[2] || 0), 0);
    if (isTrafficOutage(totalFails, totalFails + totalOks)) {
      report.push(`OUTAGE GUARD: ${totalFails}/${totalFails + totalOks} imagery ` +
        `attempts failed in ${WINDOW_HOURS}h — a Mapillary-wide incident, NOT ` +
        "pool rot. No quarantine. Check https://status.mapillary.com first.");
      flush();
      return 0;
    }

    for (const c of selectCandidates(rows)) {
      const raws = reverse.get(c.pool);
      if (!raws || !raws.length) {
        report.push(`UNVERIFIABLE candidate poolDiagId ${c.pool} (${c.fails} ` +
          `fails in ${c.failSessions} session(s); no match in the pool file — ` +
          "already removed, or a different pool revision)");
        continue;
      }
      const raw = raws[0];
      if (quarantined.has(raw)) continue; // already out (step 5)
      candidates.push({ raw, pool: c.pool, fails: c.fails, failSessions: c.failSessions });
    }
  }

  // 3–4. Verify each candidate with the SDK-faithful double probe.
  let token;
  try {
    token = mapillaryToken();
  } catch (e) {
    report.push(`pool_watch: ${e.message}`);
    flush();
    return 1;
  }
  secrets.push(token);

  // Note: already-quarantined ids were dropped during PostHog discovery (step
  // 5). The --suspects override deliberately probes every listed id, quarantined
  // or not — it exists to re-verify a verdict on demand.
  const newlyDead = [];
  for (const c of candidates) {
    const verdict = await verifyDead(c.raw, token);
    if (dryRun) {
      const from = c.fails == null ? "" : ` (${c.fails} field fails)`;
      report.push(`  ${c.pool} -> ${c.raw}${from}: ${verdict}`);
    }
    if (verdict === "dead") newlyDead.push(c);
  }

  // 5–6. Act. Nothing dead → silence (unless dry-run already spoke).
  if (!newlyDead.length) {
    flush();
    return 0;
  }

  const ids = newlyDead.map((c) => c.raw);
  const idsTxt = ids.map((i) => `\`${i}\``).join(", ");

  if (dryRun) {
    report.unshift(`pool_watch --dry-run: WOULD quarantine ${ids.length} id(s): ` +
      `${idsTxt} — dead on the SDK-faithful probe (${VERIFY_ATTEMPTS} attempts, ` +
      `${WINDOW_HOURS}h field signal). Writing nothing.`);
    flush();
    return 0;
  }

  // Live: append (never remove), commit, push. A git failure is reported and
  // exits non-zero — a verified-dead entry that did not ship needs a human.
  const nextList = [...new Set([...quarantined, ...ids])].sort();
  writeFileSync(QUARANTINE_FILE, `${JSON.stringify(nextList, null, 2)}\n`);
  const msg =
    `data(pool): auto-quarantine ${idsTxt} — early-warning pool watch\n\n` +
    `Field signal (≥ ${MIN_FAILS} imagery_load failures, zero successes, ` +
    `${WINDOW_HOURS}h window) + double verification against the SDK-faithful ` +
    "Graph request. See tools/pool_watch.mjs and " +
    "docs/field-observability-plan.md §13.";
  try {
    execFileSync("git", ["-C", ROOT, "add", "data/pool_quarantine.json"], { stdio: "pipe" });
    execFileSync("git", ["-C", ROOT, "commit", "-m", msg], { stdio: "pipe" });
    execFileSync("git", ["-C", ROOT, "push", "origin", "main"], { stdio: "pipe", timeout: 120000 });
    report.unshift(`🚨 POOL WATCH auto-quarantined: ${idsTxt} — dead on the ` +
      `SDK-faithful request (${VERIFY_ATTEMPTS} attempts, ${WINDOW_HOURS}h field ` +
      "signal). Committed + pushed; Pages re-deploys on its own.");
  } catch (e) {
    const err = ((e && (e.stderr || e.message)) || "").toString().slice(0, 200);
    report.unshift(`POOL WATCH: verified dead ${idsTxt} but GIT STEP FAILED: ` +
      `${err} — quarantine NOT shipped, needs a human.`);
    flush();
    return 1;
  }
  flush();
  return 0;
}

// Importable for tests; only runs the live pipeline when invoked directly.
if (process.argv[1] && process.argv[1].endsWith("pool_watch.mjs")) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
