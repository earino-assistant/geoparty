#!/usr/bin/env python3
"""
Add a human-readable `name` to each entry of data/location_pool.json.

Reverse-geocodes each entry's coordinates ONCE, offline from gameplay, via
Nominatim (OSM). The reveal UI renders this name from the pool data, so the
game itself never makes a geocoding call. Idempotent: entries that already
have a non-empty `name` are skipped, so re-running after a pool top-up only
names the new entries.

Nominatim usage policy: max 1 request/second and a descriptive User-Agent.
We sleep 1.1s between requests and identify ourselves.

Usage (stdlib only):
    python3 tools/name_location_pool.py            # from the repo root
"""

import json
import os
import sys
import time

import urllib.error
import urllib.parse
import urllib.request

NOMINATIM = "https://nominatim.openstreetmap.org/reverse"
USER_AGENT = "GeoParty-pool-namer/1.0 (github.com/earino; earino@gmail.com)"

# Address keys that make a good shoutable locality, most specific first.
# zoom=10 asks Nominatim for city-level results, but the best key present
# still varies by place.
LOCALITY_KEYS = (
    "city", "town", "village", "hamlet", "municipality",
    "suburb", "county", "state_district", "state",
)


def reverse_geocode(lat, lng, tries=3):
    """One polite city-level reverse geocode. Returns the parsed JSON or None."""
    params = {
        "lat": f"{lat:.6f}",
        "lon": f"{lng:.6f}",
        "format": "jsonv2",
        "zoom": 10,               # city / district level, not street level
        "accept-language": "en",
    }
    url = NOMINATIM + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                print("    429, backing off 15s", file=sys.stderr)
                time.sleep(15)
            else:
                print(f"    HTTP {e.code}: {e.reason}", file=sys.stderr)
                time.sleep(3 + attempt * 3)
        except (urllib.error.URLError, OSError) as e:
            print(f"    request error: {e}", file=sys.stderr)
            time.sleep(3 + attempt * 3)
    return None


def pick_name(geo):
    """'Yakutsk, Russia'-style name from a Nominatim reverse response."""
    if not geo or "error" in geo:
        return None
    addr = geo.get("address", {})
    locality = next(
        (addr[k] for k in LOCALITY_KEYS if addr.get(k)), None
    ) or geo.get("name")
    country = addr.get("country")
    if locality and country:
        return f"{locality}, {country}"
    if locality:
        return locality
    if country:
        return country
    # Last resort: the coarsest end of display_name is better than nothing.
    display = geo.get("display_name")
    if display:
        parts = [p.strip() for p in display.split(",")]
        return ", ".join(parts[-2:]) if len(parts) >= 2 else display
    return None


def fill_names(pool_path):
    """Name every entry in pool_path that lacks one. Returns (named, failed)."""
    with open(pool_path) as f:
        pool = json.load(f)

    todo = [e for e in pool if not e.get("name")]
    print(f"{len(pool)} entries, {len(todo)} need names.")
    named = failed = 0
    for i, entry in enumerate(todo):
        geo = reverse_geocode(entry["lat"], entry["lng"])
        name = pick_name(geo)
        if name:
            entry["name"] = name
            named += 1
            print(f"  [{i + 1}/{len(todo)}] {entry['image_id']}: {name}")
        else:
            failed += 1
            print(f"  [{i + 1}/{len(todo)}] {entry['image_id']}: FAILED",
                  file=sys.stderr)
        if i < len(todo) - 1:
            time.sleep(1.1)  # Nominatim policy: ~1 req/sec

    if named:
        with open(pool_path, "w") as f:
            json.dump(pool, f, indent=2)
    print(f"Done: {named} named, {failed} failed, written to {pool_path}")
    return named, failed


def main():
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    _, failed = fill_names(os.path.join(repo, "data", "location_pool.json"))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
