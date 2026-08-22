// posthog_report.mjs — builds the "State of GeoParty" digest from the JSON
// produced by posthog_metrics.mjs. Pure: reads metrics JSON in, prints a
// deterministic markdown digest out. The weekly PM commentary is added by
// the agent on top of this; this script owns the NUMBERS and the deltas so
// the report is apples-to-apples every week.
//
// No-silent-sections policy: every section renders either real numbers, an
// explicit "none in window" for a zero-row query, or a "⚠ NO DATA (query
// failed)" marker driven by the per-metric `error` flag. A missing line is
// never allowed — a blank section reads as "healthy zero" when it may be a
// failed pull.
//
// Usage:
//   node tools/posthog_report.mjs METRICS_FILE [PREV_METRICS_FILE]
//   node tools/posthog_report.mjs geo-metrics.json geo-metrics-last-week.json
//
// If PREV_METRICS_FILE is given, week-over-week deltas are computed and
// appended. Both files must come from posthog_metrics.mjs (same schema). If
// the prev bag reports ok:false, deltas are suppressed with a warning rather
// than compared against unreliable baseline numbers.

import { readFileSync, existsSync } from "node:fs";

const NO_DATA = "⚠ NO DATA (query failed)";

function load(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

// A per-metric section is unusable if it's absent or flagged errored.
function failed(m) {
  return !m || m.error === true;
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

// Render the tail of an $exception_functions stack. PostHog may hand this back
// as a JSON string, an already-parsed array, or null (a synthetic/handled
// exception with no captured frames). None of those may crash the digest.
function fmtStack(sig) {
  if (sig === null || sig === undefined || sig === "") return "(no stack)";
  if (Array.isArray(sig)) return sig.slice(-2).join(" › ") || "(no stack)";
  if (typeof sig === "string") {
    try {
      const arr = JSON.parse(sig);
      if (Array.isArray(arr)) return arr.slice(-2).join(" › ") || "(no stack)";
    } catch {
      /* not JSON — fall through and show it verbatim */
    }
    return sig;
  }
  return "(no stack)";
}

function fmtDelta(cur, prev) {
  if (prev === null || prev === undefined) return "";
  const d = num(cur) - num(prev);
  if (d === 0) return " (flat)";
  const sign = d > 0 ? "+" : "";
  return ` (${sign}${d} vs last week)`;
}

function buildDigest(metrics, prev) {
  const c = (metrics && metrics.metrics) || {};
  const baselineUnreliable = !!(prev && prev.ok === false);
  const p = (prev && !baselineUnreliable) ? prev.metrics : null;
  const lines = [];

  // --- Header: asof anchor + resolved window bounds ---
  const win = metrics.window || {};
  const asof = metrics.asof || (metrics.generated_at || "").slice(0, 10) || "?";
  const gen = (metrics.generated_at || "").slice(0, 10) || "?";
  lines.push(`**State of GeoParty** — as of ${asof} · 30d ${win.start30 || "?"}→${win.end || "?"} · 14d ${win.start14 || "?"}→${win.end || "?"} · generated ${gen}`);
  lines.push("");
  if (metrics.ok === false) {
    lines.push(`> ⚠ metrics pull incomplete — failed queries: ${(metrics.errors || []).join(", ") || "unknown"}`);
    lines.push("");
  }
  if (baselineUnreliable) {
    lines.push("> ⚠ baseline unreliable — week-over-week deltas suppressed");
    lines.push("");
  }

  // --- Core ---
  lines.push("**Core (30d):**");
  if (failed(c.core_30d)) {
    lines.push(`- ${NO_DATA}`);
  } else {
    const core = rowMap(c.core_30d.rows);
    const pcore = (p && !failed(p.core_30d)) ? rowMap(p.core_30d.rows) : null;
    const pv = (i) => pcore ? (pcore?.[i] ?? 0) : null;
    const created = core?.[0] ?? 0;
    const completed = core?.[1] ?? 0;
    const abandoned = core?.[2] ?? 0;
    const rounds = core?.[3] ?? 0;
    const guesses = core?.[4] ?? 0;
    const players = core?.[5] ?? 0;
    lines.push(`- Rooms created: **${created}**${fmtDelta(created, pv(0))} · active devices: **${players}**${fmtDelta(players, pv(5))}`);
    lines.push(`- Rounds played: **${rounds}** · guesses: **${guesses}**`);
    lines.push(`- Completed: **${completed}**${fmtDelta(completed, pv(1))} (${pct(completed, created)} of created) · abandoned: **${abandoned}**`);
  }
  lines.push("");

  // --- Mode mix ---
  lines.push("**Mode mix (30d):**");
  if (failed(c.mode_mix_30d)) {
    lines.push(`- ${NO_DATA}`);
  } else {
    const rows = c.mode_mix_30d.rows || [];
    if (!rows.length) {
      lines.push("- none in window");
    } else {
      for (const row of rows) {
        const [mode, cr, co] = row;
        lines.push(`- ${mode}: ${cr} created, ${co} completed (${pct(co, cr)})`);
      }
    }
  }
  lines.push("");

  // --- Funnel (14d) ---
  lines.push("**Funnel (14d):**");
  if (failed(c.funnel_14d)) {
    lines.push(`- ${NO_DATA}`);
  } else {
    const fun = new Map((c.funnel_14d.rows || []).map((r) => [r[0], num(r[1])]));
    const pfun = (p && !failed(p.funnel_14d))
      ? new Map((p.funnel_14d.rows || []).map((r) => [r[0], num(r[1])]))
      : null;
    const steps = ["party_choice", "game_created", "round_started", "game_completed"];
    for (const s of steps) {
      const n = fun.get(s) ?? 0;
      const pn = pfun ? (pfun.get(s) ?? 0) : null;
      lines.push(`- ${s}: **${n}**${fmtDelta(n, pn)}`);
    }
    lines.push(`- completion: **${pct(fun.get("game_completed") || 0, fun.get("game_created") || 0)}**`);
  }
  lines.push("");

  // --- Modifier funnel ---
  lines.push("**Guess modifier (14d):**");
  if (failed(c.modifier_funnel_14d)) {
    lines.push(`- ${NO_DATA}`);
  } else {
    const mf = rowMap(c.modifier_funnel_14d.rows);
    lines.push(`- callouts **${mf[0] ?? 0}** · sheets **${mf[1] ?? 0}** · super-sure resolved **${mf[3] ?? 0}** · decoys planted **${mf[2] ?? 0}**`);
  }
  lines.push("");

  // --- Errors ---
  lines.push("**Errors (14d):**");
  if (failed(c.exceptions_14d)) {
    lines.push(`- ${NO_DATA}`);
  } else {
    const rows = c.exceptions_14d.rows || [];
    if (!rows.length) {
      lines.push("- none in window");
    } else {
      const unhandled = [];
      for (const row of rows) {
        const [sig, handled, count] = row;
        const fam = fmtStack(sig);
        if (handled === false) unhandled.push(`${fam} (${count})`);
        lines.push(`- ${handled === false ? "⚠ UNHANDLED" : "· handled"} ${fam}: **${count}**`);
      }
      lines.push(`> Unhandled: ${unhandled.join(", ") || "none"}`);
    }
  }
  lines.push("");

  // --- Guess health ---
  lines.push("**Guess health (14d):**");
  if (failed(c.guess_distance_14d)) {
    lines.push(`- ${NO_DATA}`);
  } else {
    const gd = rowMap(c.guess_distance_14d.rows);
    if (gd && gd.length) {
      lines.push(`- avg **${gd[0]}** km · median **${gd[1]}** km · max **${gd[3]}** km · n=${gd[4]}`);
    } else {
      lines.push("- none in window");
    }
  }
  lines.push("");

  // --- Navigation recovery (issue #2 Phase 2 recovered-rate KPI) ---
  lines.push("**Navigation recovery (14d):**");
  if (failed(c.edge_recovery_14d)) {
    lines.push(`- ${NO_DATA}`);
  } else {
    const rows = c.edge_recovery_14d.rows || [];
    if (!rows.length) {
      lines.push("- none in window (no recovery attempts needed)");
    } else {
      let total = 0;
      let recovered = 0;
      for (const r of rows) {
        const cnt = num(r[2]);
        total += cnt;
        if (r[0] === "recovered") recovered += cnt;
      }
      lines.push(`- result mix: ${rows.map((r) => `${r[0]}=${r[2]}`).join(", ")}`);
      lines.push(`- recovery rate: **${pct(recovered, total)}** (${recovered}/${total} attempts recovered)`);
    }
  }
  lines.push("");

  // --- Daily ---
  lines.push("**Daily (30d):**");
  if (failed(c.daily_30d)) {
    lines.push(`- ${NO_DATA}`);
  } else {
    const dl = rowMap(c.daily_30d.rows);
    lines.push(`- ${dl[0] ?? 0} started · ${dl[1] ?? 0} completed · ${dl[2] ?? 0} ghost duels`);
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

export { buildDigest, fmtStack };
