#!/usr/bin/env node
// diag_lookup.mjs — map an opaque PostHog `pool_entry` diag id back to the
// real pool entry, LOCALLY (field-observability plan §8).
//
// The dashboard shows `pool_entry: "k3x9q0ar"`. That is deliberately not
// reversible from the data PostHog holds — no coordinates, no raw Mapillary
// image id ever leaves the device. The mapping lives here, next to the pool
// file, where it belongs.
//
//   node tools/diag_lookup.mjs k3x9q0ar [more ids...]
//   node tools/diag_lookup.mjs --id 1263588815098567   # forward direction
//   node tools/diag_lookup.mjs --json k3x9q0ar         # machine-readable
//
// Reverse direction is a full-pool scan (5k entries, instant).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { poolDiagId } from "../js/imagery.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const POOL_FILE = join(HERE, "..", "data", "location_pool.json");

function usage() {
  console.error("usage: node tools/diag_lookup.mjs [--json] <diagid...>");
  console.error("       node tools/diag_lookup.mjs --id <image_id...>");
  return 2;
}

function main(argv) {
  const json = argv.includes("--json");
  const forward = argv.includes("--id");
  const args = argv.filter((a) => a !== "--json" && a !== "--id");
  if (!args.length) return usage();

  if (forward) {
    const out = args.map((id) => ({ image_id: id, pool_entry: poolDiagId(id) }));
    console.log(json ? JSON.stringify(out, null, 2)
      : out.map((o) => `${o.image_id} -> ${o.pool_entry}`).join("\n"));
    return 0;
  }

  const pool = JSON.parse(readFileSync(POOL_FILE, "utf8"));
  const index = new Map();
  for (const entry of pool) index.set(poolDiagId(entry.image_id), entry);

  const found = [];
  let missing = 0;
  for (const wanted of args) {
    const entry = index.get(wanted.trim().toLowerCase());
    if (!entry) {
      missing++;
      if (!json) {
        console.log(`${wanted}: NOT IN POOL ` +
          "(already removed, or from a different pool revision)");
      }
      continue;
    }
    found.push({
      pool_entry: wanted,
      image_id: entry.image_id,
      name: entry.name || null,
      difficulty: entry.difficulty ?? null,
      lat: entry.lat,
      lng: entry.lng,
      viewer_url: entry.viewer_url ||
        `https://www.mapillary.com/app/?pKey=${entry.image_id}&focus=photo`,
    });
  }

  if (json) {
    console.log(JSON.stringify(found, null, 2));
  } else {
    for (const e of found) {
      console.log(`${e.pool_entry}  ->  ${e.image_id}`);
      console.log(`  name       ${e.name || "(unnamed)"}`);
      console.log(`  difficulty ${e.difficulty ?? "(unscored)"}`);
      console.log(`  coords     ${e.lat}, ${e.lng}`);
      console.log(`  viewer     ${e.viewer_url}`);
    }
  }
  return missing && !found.length ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
