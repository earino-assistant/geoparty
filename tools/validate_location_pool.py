#!/usr/bin/env python3
"""
Validate data/location_pool.json: exact schema, sane values, unique ids.

Usage:
    python3 tools/validate_location_pool.py [--min-count 2000]
Exits non-zero on any violation.
"""

import argparse
import json
import os
import sys

SCHEMA_KEYS = ["image_id", "lng", "lat", "viewer_url", "thumb", "name"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-count", type=int, default=2000)
    args = ap.parse_args()

    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(repo, "data", "location_pool.json")
    with open(path) as f:
        pool = json.load(f)

    errors = []
    if not isinstance(pool, list) or not pool:
        errors.append("pool is not a non-empty list")
        pool = []
    if len(pool) < args.min_count:
        errors.append(f"only {len(pool)} entries, expected >= {args.min_count}")

    ids = set()
    for i, e in enumerate(pool):
        where = f"entry {i} ({e.get('image_id', '?')})"
        if sorted(e.keys()) != sorted(SCHEMA_KEYS):
            errors.append(f"{where}: keys {sorted(e.keys())} != {sorted(SCHEMA_KEYS)}")
            continue
        if not isinstance(e["image_id"], str) or not e["image_id"].isdigit():
            errors.append(f"{where}: bad image_id")
        if e["image_id"] in ids:
            errors.append(f"{where}: duplicate image_id")
        ids.add(e["image_id"])
        if not (isinstance(e["lng"], (int, float)) and -180 <= e["lng"] <= 180):
            errors.append(f"{where}: bad lng {e['lng']}")
        if not (isinstance(e["lat"], (int, float)) and -90 <= e["lat"] <= 90):
            errors.append(f"{where}: bad lat {e['lat']}")
        if not (isinstance(e["viewer_url"], str)
                and e["viewer_url"].startswith("https://www.mapillary.com/app/?pKey=")):
            errors.append(f"{where}: bad viewer_url")
        if not (isinstance(e["thumb"], str) and e["thumb"].startswith("https://")):
            errors.append(f"{where}: bad thumb")
        if not (isinstance(e["name"], str) and e["name"].strip()):
            errors.append(f"{where}: missing name")

    countries = {}
    for e in pool:
        if isinstance(e.get("name"), str) and "," in e["name"]:
            countries[e["name"].rsplit(",", 1)[-1].strip()] = \
                countries.get(e["name"].rsplit(",", 1)[-1].strip(), 0) + 1

    for err in errors[:40]:
        print(f"ERROR: {err}", file=sys.stderr)
    if len(errors) > 40:
        print(f"...and {len(errors) - 40} more errors", file=sys.stderr)
    print(f"{len(pool)} entries, {len(ids)} unique ids, "
          f"{len(countries)} countries represented.")
    if countries:
        top = sorted(countries.items(), key=lambda kv: -kv[1])[:10]
        print("Top countries:", ", ".join(f"{c} ({n})" for c, n in top))
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
