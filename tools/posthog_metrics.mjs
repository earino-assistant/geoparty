// posthog_metrics.mjs — the one repeatable source of truth for GeoParty's
// product metrics. Pulls every KPI the State of GeoParty report reads from
// PostHog, on stable date windows, and writes a single JSON file.
//
// The queries here are deliberately FIXED: the weekly report is only
// apples-to-apples if the same questions run every time. Change a query
// deliberately (and document why) — never silently.
//
// Windows are anchored to an `--asof` date (default: today UTC) and rendered
// into the SQL as literal `toDate('…')` bounds, NOT `now()`. A re-run after a
// failed Monday therefore reproduces Monday's numbers exactly.
//
// Usage:
//   POSTHOG_PERSONAL_API_KEY=... node tools/posthog_metrics.mjs [--asof YYYY-MM-DD] [--out FILE]
//   node tools/posthog_metrics.mjs --asof 2026-08-17 --out /opt/data/geoparty-metrics/geo-metrics-2026-08-17.json
//
// The API key is read from the environment ONLY — never committed, never
// printed. This script has no dependencies beyond Node's built-ins.
//
// EXIT CONTRACT (read by the weekly cron; the cron is not in this repo):
//   - Exit 0 only when EVERY query succeeded (bag.ok === true).
//   - Any query error → exit 1, bag.ok=false, bag.errors=[failed keys]. The
//     cron MUST then deliver "metrics pull FAILED: <errors>" and never render
//     a digest from a partial bag.
//   - The baseline (last-week file) is rotated only AFTER a fully-ok run, so a
//     failed pull never poisons next week's week-over-week deltas.
//
// BASELINE STORAGE (also a cron concern, stated here so it isn't lost):
//   Metrics JSON is written to a dated history on the persistent volume —
//   /opt/data/geoparty-metrics/geo-metrics-YYYY-MM-DD.json — and the report's
//   `prev` file is the newest earlier dated file. Metrics JSON is NEVER
//   committed to the repo: this is a public Pages repo, so the bag lives under
//   /opt/data/ only.

import { writeFileSync } from "node:fs";

const HOST = "https://eu.i.posthog.com";
const PROJECT = "252836"; // GeoParty EU project

const REQUEST_TIMEOUT_MS = 30000; // per-query abort budget
const RETRY_BACKOFF_MS = 1000;    // one retry on 5xx / timeout

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A PostHog HogQL query helper. Same transport the field-debug sessions use.
// One retry on 5xx or timeout/network error, mirroring pool_health.mjs's
// AbortController pattern; 4xx (a real query/auth fault) is not retried.
async function query(sql) {
  const key = process.env.POSTHOG_PERSONAL_API_KEY;
  if (!key) {
    console.error("posthog_metrics: POSTHOG_PERSONAL_API_KEY is not set");
    return { error: "no key" };
  }
  const url = `${HOST}/api/projects/${PROJECT}/query/`;
  const body = JSON.stringify({ query: { kind: "HogQLQuery", query: sql } });

  for (let attempt = 0; attempt <= 1; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body,
        signal: ac.signal,
      });
      if (res.status >= 500) {
        console.error(`posthog_metrics: query failed ${res.status} (attempt ${attempt + 1})`);
        if (attempt === 0) { await sleep(RETRY_BACKOFF_MS); continue; }
        return { error: `http ${res.status}` };
      }
      if (!res.ok) {
        const text = await res.text();
        console.error(`posthog_metrics: query failed ${res.status}: ${text.slice(0, 300)}`);
        return { error: `http ${res.status}` };
      }
      const data = await res.json();
      return data.results || [];
    } catch (e) {
      const reason = ac.signal.aborted ? "timeout" : (e && e.message) || "network error";
      console.error(`posthog_metrics: query error (${reason}, attempt ${attempt + 1})`);
      if (attempt === 0) { await sleep(RETRY_BACKOFF_MS); continue; }
      return { error: reason };
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ---------------- stable-window contract ---------------- */

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function formatDateUTC(d) {
  return d.toISOString().slice(0, 10);
}

// Shift a YYYY-MM-DD string by whole UTC days, returning YYYY-MM-DD.
function addDaysUTC(ymd, delta) {
  const [y, m, dd] = ymd.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, dd));
  d.setUTCDate(d.getUTCDate() + delta);
  return formatDateUTC(d);
}

// Resolve the --asof anchor: a real YYYY-MM-DD, or today UTC when omitted.
// Throws on a malformed or impossible date so a typo can't silently shift the
// whole report's window.
export function resolveAsof(value) {
  if (value === null || value === undefined || value === "") {
    return formatDateUTC(new Date());
  }
  if (!YMD.test(value)) {
    throw new Error(`invalid --asof '${value}', expected YYYY-MM-DD`);
  }
  const [y, m, dd] = value.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, dd));
  if (d.getUTCFullYear() !== y || d.getUTCMonth() !== m - 1 || d.getUTCDate() !== dd) {
    throw new Error(`invalid --asof '${value}', not a real date`);
  }
  return value;
}

// Build the fixed 14d / 30d windows as literal date bounds anchored to `asof`.
// Each window is [start, end) in whole UTC days; `end` is exclusive and equals
// `asof`, so the report always covers complete days and is reproducible from
// the anchor alone (no `now()`).
export function buildWindows(asof) {
  const end = asof;
  const start14 = addDaysUTC(asof, -14);
  const start30 = addDaysUTC(asof, -30);
  const w14 = `timestamp >= toDate('${start14}') and timestamp < toDate('${end}')`;
  const w30 = `timestamp >= toDate('${start30}') and timestamp < toDate('${end}')`;
  return { asof, end, start14, start30, w14, w30 };
}

// The metrics bag definitions, parameterized by the resolved windows. Each
// entry is a { label, sql } pair; results are stored under a stable key so the
// report builder never re-derives the query.
export function buildMetrics(windows) {
  const W14 = windows.w14;
  const W30 = windows.w30;
  return {
    core_30d: {
      label: "Core volumes (30d)",
      sql: `select
        countIf(event='game_created') created,
        countIf(event='game_completed') completed,
        countIf(event='game_abandoned') abandoned,
        countIf(event='round_started') rounds,
        countIf(event='guess_submitted') guesses,
        count(distinct distinct_id) players
        from events where ${W30}`,
    },
    mode_mix_30d: {
      label: "Mode mix + completion (30d)",
      sql: `select properties.mode, countIf(event='game_created'), countIf(event='game_completed')
        from events where ${W30} and event in ('game_created','game_completed')
        group by properties.mode order by properties.mode`,
    },
    funnel_14d: {
      label: "Funnel (14d)",
      sql: `select event, count() from events where ${W14} and event in
        ('party_choice','front_door_join','game_created','round_started','game_completed','game_abandoned')
        group by event order by count() desc`,
    },
    modifier_funnel_14d: {
      label: "Modifier funnel (14d)",
      sql: `select countIf(event='modifier_callout_shown') callouts,
        countIf(event='modifier_sheet_opened') sheets,
        countIf(event='decoy_planted') decoys_planted,
        countIf(event='super_sure_resolved') super_resolved
        from events where ${W14}`,
    },
    modifier_by_via_14d: {
      label: "Modifier call/sheet by modifier+via (14d)",
      sql: `select properties.modifier, properties.via, count() from events where ${W14}
        and event in ('modifier_callout_shown','modifier_sheet_opened')
        group by properties.modifier, properties.via order by count() desc`,
    },
    exceptions_14d: {
      label: "Exception signatures (14d)",
      sql: `select properties.$exception_functions, properties.$exception_handled,
        count(), count(distinct properties.$current_url)
        from events where ${W14} and event='$exception'
        group by properties.$exception_functions, properties.$exception_handled
        order by count() desc`,
    },
    edge_recovery_14d: {
      label: "Edge recovery result mix (14d)",
      sql: `select properties.result, properties.trigger, count() from events
        where ${W14} and event='edge_recovery'
        group by properties.result, properties.trigger`,
    },
    guess_distance_14d: {
      label: "Guess distance spread (14d)",
      sql: `select round(avg(properties.distance_km),1), round(median(properties.distance_km),1),
        round(min(properties.distance_km),1), round(max(properties.distance_km),1), count()
        from events where ${W14} and event='guess_submitted'`,
    },
    daily_30d: {
      label: "Daily challenge funnel (30d)",
      sql: `select countIf(event='daily_challenge_started'), countIf(event='daily_challenge_completed'),
        countIf(event='ghost_duel_completed') from events where ${W30}`,
    },
    entry_points_30d: {
      label: "Entry point mix (30d)",
      sql: `select properties.choice, count() from events where ${W30}
        and event='party_choice' group by properties.choice order by count() desc`,
    },
    errors_unhandled_14d: {
      label: "Unhandled exception detail (14d)",
      sql: `select timestamp, properties.$current_url from events where ${W14}
        and event='$exception' and properties.$exception_handled=false
        order by timestamp desc limit 15`,
    },
  };
}

async function main(argv) {
  const outIdx = argv.indexOf("--out");
  let outFile = null;
  if (outIdx >= 0) {
    outFile = argv[outIdx + 1];
    if (!outFile || outFile.startsWith("--")) {
      console.error("posthog_metrics: --out requires a file path");
      return 1;
    }
  }

  const asofIdx = argv.indexOf("--asof");
  let asof;
  try {
    asof = resolveAsof(asofIdx >= 0 ? argv[asofIdx + 1] : null);
  } catch (e) {
    console.error(`posthog_metrics: ${e.message}`);
    return 1;
  }

  const windows = buildWindows(asof);
  const METRICS = buildMetrics(windows);

  const bag = {
    generated_at: new Date().toISOString(),
    asof,
    window: {
      asof,
      end: windows.end,
      start14: windows.start14,
      start30: windows.start30,
    },
    ok: true,
    errors: [],
    metrics: {},
  };

  for (const [key, def] of Object.entries(METRICS)) {
    const rows = await query(def.sql);
    if (rows && !rows.error) {
      bag.metrics[key] = { label: def.label, rows };
    } else {
      bag.metrics[key] = { label: def.label, error: true };
      bag.errors.push(key);
    }
  }
  bag.ok = bag.errors.length === 0;

  const output = JSON.stringify(bag, null, 2);
  if (outFile) {
    writeFileSync(outFile, output);
    const suffix = bag.ok ? "" : ` (with ${bag.errors.length} failed quer${bag.errors.length === 1 ? "y" : "ies"})`;
    console.log(`posthog_metrics: wrote ${outFile}${suffix}`);
  } else {
    process.stdout.write(output + "\n");
  }

  if (!bag.ok) {
    console.error(`posthog_metrics: FAILED queries: ${bag.errors.join(", ")}`);
  }
  return bag.ok ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith("posthog_metrics.mjs")) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

export { main };
