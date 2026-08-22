// posthog_metrics.mjs — the one repeatable source of truth for GeoParty's
// product metrics. Pulls every KPI the State of GeoParty report reads from
// PostHog, on stable date windows, and writes a single JSON file.
//
// The queries here are deliberately FIXED: the weekly report is only
// apples-to-apples if the same questions run every time. Change a query
// deliberately (and document why) — never silently.
//
// Usage:
//   POSTHOG_PERSONAL_API_KEY=... node tools/posthog_metrics.mjs [--out FILE]
//   node tools/posthog_metrics.mjs --out /tmp/geo-metrics.json
//
// The API key is read from the environment ONLY — never committed, never
// printed. This script has no dependencies beyond Node's built-ins.

import { writeFileSync } from "node:fs";

const HOST = "https://eu.i.posthog.com";
const PROJECT = "252836"; // GeoParty EU project

// A PostHog HogQL query helper. Same transport the field-debug sessions use.
async function query(sql) {
  const key = process.env.POSTHOG_PERSONAL_API_KEY;
  if (!key) {
    console.error("posthog_metrics: POSTHOG_PERSONAL_API_KEY is not set");
    return { error: "no key" };
  }
  const res = await fetch(`${HOST}/api/projects/${PROJECT}/query/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query: sql } }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`posthog_metrics: query failed ${res.status}: ${body.slice(0, 300)}`);
    return { error: `http ${res.status}` };
  }
  const data = await res.json();
  return data.results || [];
}

// All windows are measured relative to "now" so the report reads the same
// way every week. The 14d / 30d split is the report's fixed lens.
const W14 = "timestamp > now() - interval 14 day";
const W30 = "timestamp > now() - interval 30 day";

// The metrics bag. Each entry is a { label, sql } pair; results are stored
// under a stable key so the report builder never re-derives the query.
const METRICS = {
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

async function main(argv) {
  const outIdx = argv.indexOf("--out");
  const outFile = outIdx >= 0 ? argv[outIdx + 1] : null;

  const bag = { generated_at: new Date().toISOString(), metrics: {} };
  for (const [key, def] of Object.entries(METRICS)) {
    const rows = await query(def.sql);
    if (rows && !rows.error) {
      bag.metrics[key] = { label: def.label, rows };
    } else {
      bag.metrics[key] = { label: def.label, error: true };
    }
  }

  const output = JSON.stringify(bag, null, 2);
  if (outFile) {
    writeFileSync(outFile, output);
    console.log(`posthog_metrics: wrote ${outFile}`);
  } else {
    process.stdout.write(output + "\n");
  }
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("posthog_metrics.mjs")) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

export { METRICS, main };
