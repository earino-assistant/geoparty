#!/usr/bin/env python3
"""
Scale the GeoParty location pool to thousands of verified Mapillary panos.

Strategy (see docs/pool-scale-plan.md): seed from GeoNames cities (pop >= 15k,
countries interleaved round-robin for global spread), issue ONE small-bbox
high-limit pano search per seed — Mapillary 500s on data-dense boxes, so the
box shrinks and retries — and name every entry offline via nearest-city lookup
against the same GeoNames data. No Nominatim, no per-image API calls.

Merges with the existing data/location_pool.json (existing entries win) and
checkpoints there as it goes, so an interrupted run keeps its progress.

Usage (stdlib only, no pip install needed):
    python3 tools/scale_location_pool.py                 # top up to the target
    python3 tools/scale_location_pool.py --target 2400 --workers 8
    python3 tools/scale_location_pool.py --refresh-thumbs  # re-sign expiring thumb URLs

GeoNames data (tools/.cache/) is CC-BY 4.0, (c) geonames.org.
"""

import argparse
import json
import math
import os
import random
import sys
import threading
import time
import zipfile

import urllib.error
import urllib.parse
import urllib.request

from concurrent.futures import ThreadPoolExecutor, as_completed

ACCESS_TOKEN = "MLY|27836274156038423|1a03dd8caa7860d5d118f46a2100d09a"
SEARCH_API = "https://graph.mapillary.com/images"
ENTITY_API = "https://graph.mapillary.com"
GEONAMES = "https://download.geonames.org/export/dump"

MIN_YEAR = 2018
CUTOFF_MS = (MIN_YEAR - 1970) * 31_557_600_000
GRID = 0.004          # ~450m dedupe cells: keeps entries visually distinct
PER_SEED = 5          # max picks per seed city, keeps any one city from dominating
SEED_MIN_POP = 15_000
PER_COUNTRY_CAP = 150
# The first full run used these; its seed list is deterministic, so we rebuild
# it to know which seeds were already tried and put fresh ones first.
PREV_MIN_POP = 50_000
PREV_COUNTRY_CAP = 40
# Dense areas 500 (server-side timeout); shrink the box and retry.
HALVES = (0.0025, 0.0012, 0.0006)

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(REPO, "tools", ".cache")
POOL_PATH = os.path.join(REPO, "data", "location_pool.json")


# ---------------------------------------------------------------- GeoNames

def _download(url, dest):
    if os.path.exists(dest):
        return
    print(f"  downloading {url} ...")
    tmp = dest + ".part"
    req = urllib.request.Request(url, headers={"User-Agent": "GeoParty-pool/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
        while chunk := r.read(1 << 16):
            f.write(chunk)
    os.replace(tmp, dest)


def load_geonames():
    """Returns (cities, country_names). cities: list of (lat, lng, name, cc, pop)."""
    os.makedirs(CACHE, exist_ok=True)
    gi = os.path.join(CACHE, ".gitignore")
    if not os.path.exists(gi):
        with open(gi, "w") as f:
            f.write("*\n")
    zpath = os.path.join(CACHE, "cities500.zip")
    cpath = os.path.join(CACHE, "countryInfo.txt")
    _download(f"{GEONAMES}/cities500.zip", zpath)
    _download(f"{GEONAMES}/countryInfo.txt", cpath)

    country_names = {}
    with open(cpath, encoding="utf-8") as f:
        for line in f:
            if line.startswith("#"):
                continue
            cols = line.rstrip("\n").split("\t")
            if len(cols) > 4:
                country_names[cols[0]] = cols[4]

    cities = []
    # Skip city subsections (PPLX) and gone places so names read like
    # "Paris, France" rather than "Paris 04 Hôtel-de-Ville, France".
    skip_codes = {"PPLX", "PPLQ", "PPLW", "PPLH"}
    with zipfile.ZipFile(zpath) as z:
        for line in z.read("cities500.txt").decode("utf-8").splitlines():
            cols = line.split("\t")
            try:
                lat, lng = float(cols[4]), float(cols[5])
                pop = int(cols[14] or 0)
            except (ValueError, IndexError):
                continue
            if cols[7] in skip_codes:
                continue
            cities.append((lat, lng, cols[1], cols[8], pop))
    return cities, country_names


class Namer:
    """Offline nearest-city reverse geocoder over GeoNames cities500."""

    CELL = 0.5  # degrees per index bucket

    def __init__(self, cities, country_names):
        self.country_names = country_names
        self.index = {}
        for city in cities:
            key = (int(city[0] // self.CELL), int(city[1] // self.CELL))
            self.index.setdefault(key, []).append(city)

    NEAR2 = 0.09 ** 2  # ~10km: within this, prefer the biggest city over
    CITY_POP = 10_000  # the nearest hamlet/district ("Paris", not "Paris 04")

    def name(self, lat, lng):
        ci, cj = int(lat // self.CELL), int(lng // self.CELL)
        coslat = max(0.05, math.cos(math.radians(lat)))
        best, best_d2, big = None, None, None
        for ring in range(5):  # up to ~2.5 degrees out
            for i in range(ci - ring, ci + ring + 1):
                for j in range(cj - ring, cj + ring + 1):
                    if ring and max(abs(i - ci), abs(j - cj)) != ring:
                        continue  # only the new outer ring
                    for c in self.index.get((i, j), ()):
                        dlat = c[0] - lat
                        dlng = (c[1] - lng) * coslat
                        d2 = dlat * dlat + dlng * dlng
                        if best_d2 is None or d2 < best_d2:
                            best, best_d2 = c, d2
                        if (d2 < self.NEAR2 and c[4] >= self.CITY_POP
                                and (big is None or c[4] > big[4])):
                            big = c
            if best is not None and best_d2 < (ring * self.CELL) ** 2:
                break  # rings searched so far cover NEAR2 and beat farther ones
        best = big or best
        if best is None:
            return None
        country = self.country_names.get(best[3], best[3])
        return f"{best[2]}, {country}" if country else best[2]


def build_seeds(cities, rng, min_pop=SEED_MIN_POP, cap=PER_COUNTRY_CAP):
    """Cities above min_pop, capped per country, countries interleaved round-robin."""
    by_country = {}
    for c in cities:
        if c[4] >= min_pop:
            by_country.setdefault(c[3], []).append(c)
    queues = []
    for cc, group in by_country.items():
        group.sort(key=lambda c: -c[4])
        queues.append(group[:cap])
    rng.shuffle(queues)
    seeds, depth = [], 0
    while any(len(q) > depth for q in queues):
        for q in queues:
            if len(q) > depth:
                seeds.append(q[depth])
        depth += 1
    return seeds


# ---------------------------------------------------------------- Mapillary

def api_get(url, timeout=25):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.load(r)


def fetch_seed(lng, lat):
    """One pano search per seed; shrink the bbox on dense-area 500s."""
    for attempt, half in enumerate(HALVES):
        box = (lng - half, lat - half, lng + half, lat + half)
        params = {
            "access_token": ACCESS_TOKEN,
            "fields": "id,computed_geometry,is_pano,captured_at,thumb_1024_url",
            "bbox": ",".join(f"{v:.6f}" for v in box),
            "is_pano": "true",
            "limit": 200,
        }
        try:
            got = api_get(SEARCH_API + "?" + urllib.parse.urlencode(params))
            return got.get("data", [])
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(15)
            elif e.code >= 500:
                continue  # dense box: shrink and retry
            else:
                return []
        except (urllib.error.URLError, OSError, ValueError):
            continue  # timeouts behave like dense-box 500s
    return []


# ---------------------------------------------------------------- pool build

def load_pool():
    try:
        with open(POOL_PATH) as f:
            return json.load(f)
    except (OSError, ValueError):
        return []


def save_pool(pool):
    tmp = POOL_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(pool, f, indent=2)
    os.replace(tmp, POOL_PATH)


def grid_cell(lng, lat):
    return (round(lng / GRID), round(lat / GRID))


def build(args):
    print("Loading GeoNames data...")
    cities, country_names = load_geonames()
    namer = Namer(cities, country_names)
    seeds = build_seeds(cities, random.Random(20260819))
    # Seeds the first full run already tried go last: fresh cities yield new
    # entries, while retries mostly hit the dedupe grid.
    prev_tried = set(build_seeds(cities, random.Random(20260819),
                                 PREV_MIN_POP, PREV_COUNTRY_CAP))
    fresh = [s for s in seeds if s not in prev_tried]
    retries = [s for s in seeds if s in prev_tried]
    seeds = fresh + retries
    if args.max_seeds:
        seeds = seeds[: args.max_seeds]
    print(f"{len(seeds)} seed cities across {len({s[3] for s in seeds})} countries "
          f"({len(fresh)} fresh, {len(retries)} previously tried).")

    pool = load_pool()
    lock = threading.Lock()
    seen_ids = {e["image_id"] for e in pool}
    seen_cells = {grid_cell(e["lng"], e["lat"]) for e in pool}
    print(f"Seeded {len(pool)} existing entries.")

    stats = {"tried": 0, "productive": 0}

    def absorb(images, seed):
        """Filter, spread, name, and add picks from one seed's results."""
        good = [im for im in images
                if im.get("is_pano") and im.get("computed_geometry")
                and im.get("thumb_1024_url")
                and im.get("captured_at", 0) >= CUTOFF_MS]
        rng_local = random.Random(seed[2])
        rng_local.shuffle(good)
        added = 0
        with lock:
            stats["tried"] += 1
            for im in good:
                if added >= PER_SEED or len(pool) >= args.target:
                    break
                lng, lat = im["computed_geometry"]["coordinates"]
                cell = grid_cell(lng, lat)
                if im["id"] in seen_ids or cell in seen_cells:
                    continue
                name = namer.name(lat, lng)
                if not name:
                    continue
                seen_ids.add(im["id"])
                seen_cells.add(cell)
                pool.append({
                    "image_id": im["id"],
                    "lng": lng,
                    "lat": lat,
                    "viewer_url": f"https://www.mapillary.com/app/?pKey={im['id']}&focus=photo",
                    "thumb": im["thumb_1024_url"],
                    "name": name,
                })
                added += 1
            if added:
                stats["productive"] += 1
                if stats["productive"] % 20 == 0:
                    save_pool(pool)
            if stats["tried"] % 100 == 0:
                print(f"  {stats['tried']}/{len(seeds)} seeds tried, "
                      f"{stats['productive']} productive, pool={len(pool)}")
        return added

    start = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {}
        it = iter(seeds)
        # Keep a bounded queue of in-flight seeds so hitting the target
        # stops promptly instead of draining thousands of futures.
        def top_up():
            while len(futures) < args.workers * 4:
                try:
                    s = next(it)
                except StopIteration:
                    return
                futures[ex.submit(fetch_seed, s[1], s[0])] = s

        top_up()
        while futures:
            done = next(as_completed(list(futures)))
            seed = futures.pop(done)
            try:
                absorb(done.result() or [], seed)
            except Exception as e:  # one bad seed must not kill the run
                print(f"  seed {seed[2]} failed: {e}", file=sys.stderr)
            with lock:
                if len(pool) >= args.target:
                    for f in futures:
                        f.cancel()
                    break
            top_up()

    save_pool(pool)
    mins = (time.time() - start) / 60
    print(f"\nDone: pool={len(pool)} after {stats['tried']} seeds "
          f"({stats['productive']} productive) in {mins:.1f} min -> {POOL_PATH}")


# ---------------------------------------------------------------- thumbs

def refresh_thumbs(args):
    """Re-resolve expiring signed thumb URLs by image id (entity API)."""
    pool = load_pool()
    print(f"Refreshing thumbs for {len(pool)} entries...")
    lock = threading.Lock()
    done = [0, 0]

    def one(entry):
        params = {"access_token": ACCESS_TOKEN, "fields": "thumb_1024_url"}
        url = f"{ENTITY_API}/{entry['image_id']}?" + urllib.parse.urlencode(params)
        for attempt in range(3):
            try:
                got = api_get(url, timeout=20)
                thumb = got.get("thumb_1024_url")
                with lock:
                    done[0] += 1
                    if thumb:
                        entry["thumb"] = thumb
                    else:
                        done[1] += 1
                    if done[0] % 200 == 0:
                        print(f"  {done[0]}/{len(pool)}")
                        save_pool(pool)
                return
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    time.sleep(15)
                else:
                    break
            except (urllib.error.URLError, OSError, ValueError):
                time.sleep(1 + attempt)
        with lock:
            done[0] += 1
            done[1] += 1

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        list(ex.map(one, pool))
    save_pool(pool)
    print(f"Done: {done[0]} processed, {done[1]} failed/kept old thumb.")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--target", type=int, default=2400)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--max-seeds", type=int, default=0,
                    help="Cap the number of seed cities tried (0 = all)")
    ap.add_argument("--refresh-thumbs", action="store_true",
                    help="Only re-resolve thumb URLs for existing entries")
    args = ap.parse_args()
    if args.refresh_thumbs:
        refresh_thumbs(args)
    else:
        build(args)


if __name__ == "__main__":
    main()
