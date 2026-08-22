// posthog_report.mjs — builds the "State of GeoParty" digest from the JSON
// produced by posthog_metrics.mjs. Pure: reads metrics JSON in, prints a
// deterministic markdown digest out. The weekly PM commentary is added by
// the agent on top of this; this script owns the NUMBERS and the deltas so
// the report is apples-to-apples every week.
//
// Usage:
//   node tools/posthog_report.mjs METRICS_FILE [PREV_METRICS_FILE]
//   node tools/posthog_report.mjs /tmp/geo-metrics.json /tmp/geo-metrics-last-week.json
//
// If PREV_METRICS_FILE is given, week-over-week deltas are computed and
// appended. Both files must come from posthog_metrics.mjs (same schema).

import { readFileSync, existsSync } from "node:fs";

function load(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

// Helpers to read a 1-row result as a named map, tolerant of shape.
function rowMap(rows) {
  return (rows && rows[0]) ? rows[0] : [];
}
function num(v) {
  return (typeof v === "number") ? v : Number(v || 0);
}

function pct(n, d) {
  if (!d) return "—";
  return `${Math.round((n / d) * 100)}%`;
}

function fmtDelta(cur, prev) {
  if (prev === null || prev === undefined) return "";
  const d = num(cur) - num(prev);
  if (d === 0) return " (flat)";
  const sign = d > 0 ? "+" : "";
  return ` (${sign}${d} vs last week)`;
}

function buildDigest(metrics, prev) {
  const c = metrics.metrics;
  const p = prev ? prev.metrics : null;
  const lines = [];

  // --- Core ---
  const core = rowMap(c.core_30d?.rows);
  const pcore = p ? rowMap(p.core_30d?.rows) : null;
  const created = core?.[0] ?? 0;
  const completed = core?.[1] ?? 0;
  const abandoned = core?.[2] ?? 0;
  const rounds = core?.[3] ?? 0;
  const guesses = core?.[4] ?? 0;
  const players = core?.[5] ?? 0;
  const pCreated = p ? (pcore?.[0] ?? 0) : null;

  lines.push(`**State of GeoParty** — 30d · generated ${(metrics.generated_at || "").slice(0, 10)}`);
  lines.push("");
  lines.push(`- Rooms created: **${created}**${fmtDelta(created, pCreated)} · players: **${players}**`);
  lines.push(`- Rounds played: **${rounds}** · guesses: **${guesses}**`);
  lines.push(`- Completed: **${completed}** (${pct(completed, created)} of created) · abandoned: **${abandoned}**`);
  lines.push("");

  // --- Mode mix ---
  lines.push("**Mode mix (30d):**");
  for (const row of c.mode_mix_30d?.rows || []) {
    const [mode, cr, co] = row;
    lines.push(`- ${mode}: ${cr} created, ${co} completed (${pct(co, cr)})`);
  }
  lines.push("");

  // --- Funnel (14d) ---
  lines.push("**Funnel (14d):**");
  const fun = new Map((c.funnel_14d?.rows || []).map((r) => [r[0], num(r[1])]));
  const steps = ["party_choice", "game_created", "round_started", "game_completed"];
  for (const s of steps) {
    const n = fun.get(s) ?? 0;
    lines.push(`- ${s}: **${n}**`);
  }
  const fCreate = fun.get("game_created") || 0;
  const fComp = fun.get("game_completed") || 0;
  lines.push(`- completion: **${pct(fComp, fCreate)}**`);
  lines.push("");

  // --- Modifier funnel ---
  const mf = rowMap(c.modifier_funnel_14d?.rows);
  if (mf) {
    lines.push("**Guess modifier (14d):**");
    lines.push(`- callouts **${mf[0]}** · sheets **${mf[1]}** · super-sure resolved **${mf[3]}** · decoys planted **${mf[2]}**`);
    lines.push("");
  }

  // --- Errors ---
  lines.push("**Errors (14d):**");
  const unhandled = [];
  for (const row of c.exceptions_14d?.rows || []) {
    const [sig, handled, count] = row;
    const fam = JSON.parse(sig).slice(-2).join(" › ");
    if (handled === false) unhandled.push(`${fam} (${count})`);
    lines.push(`- ${handled === false ? "⚠ UNHANDLED" : "· handled"} ${fam}: **${count}**`);
  }
  if (unhandled.length) lines.push("");
  lines.push(`> Unhandled: ${unhandled.join(", ") || "none"}`);
  lines.push("");

  // --- Edge / guess health ---
  const gd = rowMap(c.guess_distance_14d?.rows);
  if (gd) {
    lines.push(`**Guess health (14d):** avg **${gd[0]}** km · median **${gd[1]}** km · max **${gd[3]}** km · n=${gd[4]}`);
  }
  const er = (c.edge_recovery_14d?.rows || []).map((r) => `${r[0]}=${r[2]}`).join(", ");
  if (er) lines.push(`Edge recovery (14d): ${er}`);
  lines.push("");

  // --- Daily ---
  const dl = rowMap(c.daily_30d?.rows);
  if (dl) {
    lines.push(`**Daily (30d):** ${dl[0]} started · ${dl[1]} completed · ${dl[2]} ghost duels`);
  }

  return lines.join("\n");
}

if (process.argv[1] && process.argv[1].endsWith("posthog_report.mjs")) {
  const args = process.argv.slice(2);
  const metricsFile = args[0];
  const prevFile = args[1];
  const metrics = load(metricsFile);
  if (!metrics) {
    console.error("posthog_report: missing metrics file");
    process.exit(1);
  }
  const prev = prevFile ? load(prevFile) : null;
  process.stdout.write(buildDigest(metrics, prev) + "\n");
}

export { buildDigest };
