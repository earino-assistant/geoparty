#!/usr/bin/env python3
"""
Fast top-up generator for the GeoParty location pool.

Rationale: build_location_pool.py samples one random bbox per candidate, which
means hundreds of serial API calls when the Mapillary API is flaky. This script
instead queries a curated list of cities with dense pano coverage ONCE each
with a high limit, harvesting many verified panos per request. It merges with
any existing pool (root location_pool.json checkpoint and/or the shipped
data/location_pool.json) and writes data/location_pool.json.

Usage (stdlib only, no pip install needed):
    python3 tools/topup_location_pool.py           # from the repo root
"""

import json
import os
import random
import sys
import time

import urllib.error
import urllib.parse
import urllib.request

ACCESS_TOKEN = "MLY|27836274156038423|1a03dd8caa7860d5d118f46a2100d09a"
API = "https://graph.mapillary.com/images"
MIN_YEAR = 2018
PER_CITY = 3          # max picks per city, keeps the pool geographically varied
TARGET = 45           # stop early once the pool is comfortably large
HALF_DEG = 0.002      # bbox half-width (~400m). The API rejects data-heavy
                      # boxes with a 500 regardless of `limit`; in dense city
                      # centers only sub-kilometer boxes reliably return 200,
                      # and even those yield dozens of panos per request.

# (name, center_lng, center_lat) — cities with reliably dense Mapillary
# pano coverage, spread across continents.
CITIES = [
    ("Amsterdam",     4.895,   52.370),
    ("Berlin",        13.405,  52.520),
    ("Paris",         2.349,   48.857),
    ("Barcelona",     2.170,   41.387),
    ("Helsinki",      24.941,  60.170),
    ("Vilnius",       25.280,  54.687),
    ("Warsaw",        21.012,  52.230),
    ("Lisbon",        -9.139,  38.722),
    ("San Francisco", -122.42, 37.775),
    ("Seattle",       -122.33, 47.606),
    ("Toronto",       -79.383, 43.653),
    ("Sao Paulo",     -46.633, -23.551),
    ("Tokyo",         139.692, 35.690),
    ("Melbourne",     144.963, -37.814),
    ("Bangkok",       100.502, 13.756),
    ("Cape Town",     18.424,  -33.925),
]


def fetch_city(lng, lat, half=HALF_DEG, tries=3):
    """One high-limit pano query for a city bbox. Shrinks the box and backs
    off on 500s (data-heavy box or transient flake), sleeps on 429."""
    for attempt in range(tries):
        box = (lng - half, lat - half, lng + half, lat + half)
        params = {
            "access_token": ACCESS_TOKEN,
            "fields": "id,computed_geometry,is_pano,captured_at,thumb_1024_url",
            "bbox": ",".join(f"{v:.6f}" for v in box),
            "is_pano": "true",
            "limit": 50,
        }
        url = API + "?" + urllib.parse.urlencode(params)
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                return json.load(r).get("data", [])
        except urllib.error.HTTPError as e:
            if e.code == 429:
                print("    429, backing off 10s", file=sys.stderr)
                time.sleep(10)
            elif e.code >= 500:
                half *= 0.5
                time.sleep(1 + attempt)
            else:
                print(f"    HTTP {e.code}: {e.reason}", file=sys.stderr)
                time.sleep(2)
        except (urllib.error.URLError, OSError) as e:
            print(f"    request error: {e}", file=sys.stderr)
            time.sleep(2)
    return []


def main():
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_path = os.path.join(repo, "data", "location_pool.json")

    pool, seen_ids, seen_cells = [], set(), set()

    def absorb(entry):
        cell = (round(entry["lng"], 1), round(entry["lat"], 1))
        if entry["image_id"] in seen_ids or cell in seen_cells:
            return False
        seen_ids.add(entry["image_id"])
        seen_cells.add(cell)
        pool.append(entry)
        return True

    # Seed from existing pools (checkpoint at repo root, or a prior shipped pool).
    for seed in (os.path.join(repo, "location_pool.json"), out_path):
        try:
            with open(seed) as f:
                for e in json.load(f):
                    absorb(e)
        except (OSError, ValueError):
            pass
    print(f"Seeded {len(pool)} locations from existing pools.")

    cutoff_ms = (MIN_YEAR - 1970) * 31_557_600_000
    # A single ~400m box falls inside one 0.1-degree dedupe cell, so probe a
    # few points ~5km apart per city to let each city contribute PER_CITY
    # spread-out locations.
    offsets = [(0.0, 0.0), (0.05, 0.05), (-0.05, -0.05)]
    for name, lng, lat in CITIES:
        if len(pool) >= TARGET:
            break
        added = 0
        for dx, dy in offsets:
            if added >= PER_CITY:
                break
            images = fetch_city(lng + dx, lat + dy)
            good = [im for im in images
                    if im.get("is_pano") and im.get("computed_geometry")
                    and im.get("captured_at", 0) >= cutoff_ms]
            random.shuffle(good)
            for im in good:
                if added >= PER_CITY:
                    break
                coords = im["computed_geometry"]["coordinates"]
                if absorb({
                    "image_id": im["id"],
                    "lng": coords[0],
                    "lat": coords[1],
                    "viewer_url": f"https://www.mapillary.com/app/?pKey={im['id']}&focus=photo",
                    "thumb": im.get("thumb_1024_url"),
                }):
                    added += 1
            time.sleep(0.3)
        print(f"  {name}: {added} added (pool={len(pool)})")

    with open(out_path, "w") as f:
        json.dump(pool, f, indent=2)
    print(f"\nDone: {len(pool)} verified pano locations in {out_path}")

    # The reveal UI shows each entry's pre-geocoded `name`; fill it in for
    # any new entries (skips ones that already have it).
    from name_location_pool import fill_names
    fill_names(out_path)


if __name__ == "__main__":
    main()
