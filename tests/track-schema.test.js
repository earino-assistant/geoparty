// tests/track-schema.test.js — the schema↔call-site contract (stabilization
// §8 item 6 / review test-credibility). track() drops any event not in
// EVENT_SCHEMA *silently* (the schema is a hard allowlist), so a typo'd or
// un-added event name instruments nothing and no test notices. This scans
// every production call site and proves the pair can't drift apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { EVENT_SCHEMA } from "../js/analytics.js";

const jsDir = new URL("../js/", import.meta.url);
const files = readdirSync(jsDir).filter((f) => f.endsWith(".js"));
const read = (f) => readFileSync(new URL(f, jsDir), "utf8");

test("every literal track(\"event\") names a real EVENT_SCHEMA event", () => {
  // `\btrack\(` does not match `trackError(` (no "(" after "track") nor
  // `this.track(` string-lessly — we only pin the string-literal call sites.
  const re = /\btrack\(\s*"([a-z0-9_]+)"/g;
  const seen = [];
  for (const f of files) {
    for (const m of read(f).matchAll(re)) {
      seen.push(m[1]);
      assert.ok(EVENT_SCHEMA[m[1]],
        `${f}: track("${m[1]}") has no EVENT_SCHEMA entry — it is silently dropped`);
    }
  }
  // Guard against the scan quietly matching nothing (e.g. a regex regression).
  assert.ok(seen.length >= 20,
    `expected to find the real call sites, found only ${seen.length}`);
});

test("the ONLY dynamic track(var) sites are the analytics core + consent re-export", () => {
  // A track(variable) call can't be schema-checked statically, so the
  // intentional ones must be explicit and confined: the createAnalytics
  // implementation and its consent.js wrapper. A new dynamic call site in a
  // feature module would be an uninstrumentable hole — fail loudly.
  const re = /\btrack\(\s*[A-Za-z_$]/g; // track( followed by an identifier, not a quote
  const offenders = [];
  for (const f of files) {
    if (f === "analytics.js" || f === "consent.js") continue;
    for (const m of read(f).matchAll(re)) {
      offenders.push(`${f}: dynamic ${read(f).slice(m.index, m.index + 18)}…`);
    }
  }
  assert.deepEqual(offenders, [],
    `unexpected dynamic track() call sites:\n${offenders.join("\n")}`);
});
