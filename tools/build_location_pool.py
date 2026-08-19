#!/usr/bin/env python3
"""
Build a verified pool of Mapillary 360-degree pano locations for a geoguessing game.

Usage:
    pip install requests
    python build_location_pool.py --count 50 --mode weighted
    python build_location_pool.py --count 50 --mode wild      # fully random globe, slower, more exotic

Output: location_pool.json with image IDs, coords, and viewer URLs.
"""

import argparse
import json
import random
import sys
import time

import requests

ACCESS_TOKEN = "MLY|27836274156038423|1a03dd8caa7860d5d118f46a2100d09a"
API = "https://graph.mapillary.com/images"

# Rough land bounding boxes (min_lng, min_lat, max_lng, max_lat) with sampling weights.
# Weighted mode favors regions where Mapillary coverage is dense.
REGIONS = [
    ("Western Europe",   (-10.0, 36.0, 20.0, 60.0), 30),
    ("Eastern Europe",   (14.0, 41.0, 40.0, 60.0), 20),
    ("Nordics/Baltics",  (5.0, 55.0, 31.0, 70.0), 10),
    ("North America",    (-125.0, 25.0, -66.0, 50.0), 15),
    ("Latin America",    (-82.0, -35.0, -34.0, 20.0), 8),
    ("East Asia",        (100.0, 20.0, 145.0, 45.0), 8),
    ("SE Asia/Oceania",  (95.0, -40.0, 155.0, 15.0), 6),
    ("Africa/Mideast",   (-17.0, -35.0, 50.0, 35.0), 3),
]

def random_point_weighted():
    names, boxes, weights = zip(*[(n, b, w) for n, b, w in REGIONS])
    box = random.choices(boxes, weights=weights, k=1)[0]
    lng = random.uniform(box[0], box[2])
    lat = random.uniform(box[1], box[3])
    return lng, lat

def random_point_wild():
    # Uniform over the globe, latitude-corrected so we don't oversample poles.
    lng = random.uniform(-180, 180)
    lat = 90 - (180 / 3.14159) * __import__("math").acos(random.uniform(-1, 1))
    return lng, lat

def query_raw(box, budget):
    # One bbox request. Returns a list on success, or None when the API says
    # the box is too data-heavy (Mapillary 500s on dense/oversized boxes).
    budget[0] -= 1
    params = {
        "access_token": ACCESS_TOKEN,
        "fields": "id,computed_geometry,is_pano,captured_at,thumb_1024_url",
        "bbox": ",".join(f"{v:.6f}" for v in box),
        "is_pano": "true",
        "limit": 10,
    }
    r = requests.get(API, params=params, timeout=15)
    time.sleep(0.15)
    if r.status_code == 429:
        time.sleep(10)
        return []
    if r.status_code >= 500:
        return None
    r.raise_for_status()
    return r.json().get("data", [])

def query_bbox(lng, lat, half_deg=0.049, max_depth=4):
    # Mapillary caps bbox area at 0.010 sq deg and rejects data-heavy boxes
    # with a 500. A heavy box means imagery is nearby, so drill down quadtree
    # style until a sub-box returns actual results.
    budget = [12]  # max requests per sampled point

    def drill(box, depth):
        if budget[0] <= 0:
            return []
        data = query_raw(box, budget)
        if data:
            return data
        if data is not None or depth >= max_depth:
            return []  # genuinely empty, or too deep
        minx, miny, maxx, maxy = box
        midx, midy = (minx + maxx) / 2, (miny + maxy) / 2
        quads = [(minx, miny, midx, midy), (midx, miny, maxx, midy),
                 (minx, midy, midx, maxy), (midx, midy, maxx, maxy)]
        random.shuffle(quads)
        for q in quads:
            found = drill(q, depth + 1)
            if found:
                return found
        return []

    return drill((lng - half_deg, lat - half_deg, lng + half_deg, lat + half_deg), 0)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=50)
    ap.add_argument("--mode", choices=["weighted", "wild"], default="weighted")
    ap.add_argument("--min-year", type=int, default=2018,
                    help="Skip imagery captured before this year")
    args = ap.parse_args()

    sampler = random_point_weighted if args.mode == "weighted" else random_point_wild
    pool, seen_cells, attempts = [], set(), 0

    # Resume from a checkpoint left by an interrupted run.
    try:
        with open("location_pool.json") as f:
            pool = json.load(f)
        seen_cells = {(round(e["lng"], 1), round(e["lat"], 1)) for e in pool}
        if pool:
            print(f"Resuming from checkpoint with {len(pool)} locations.")
    except (OSError, ValueError):
        pass

    while len(pool) < args.count:
        attempts += 1
        lng, lat = sampler()
        # Dedupe on ~10km grid cells so the pool spreads out.
        cell = (round(lng, 1), round(lat, 1))
        if cell in seen_cells:
            continue
        try:
            images = query_bbox(lng, lat)
        except requests.RequestException as e:
            print(f"  request error: {e}", file=sys.stderr)
            time.sleep(2)
            continue

        # captured_at is epoch ms; filter out old imagery:
        cutoff_ms = (args.min_year - 1970) * 31_557_600_000
        recent = [im for im in images
                  if im.get("captured_at", 0) >= cutoff_ms and im.get("computed_geometry")]

        if not recent:
            if attempts % 25 == 0:
                print(f"  {attempts} attempts, {len(pool)} found so far...")
            continue

        im = random.choice(recent)
        coords = im["computed_geometry"]["coordinates"]
        seen_cells.add(cell)
        entry = {
            "image_id": im["id"],
            "lng": coords[0],
            "lat": coords[1],
            "viewer_url": f"https://www.mapillary.com/app/?pKey={im['id']}&focus=photo",
            "thumb": im.get("thumb_1024_url"),
        }
        pool.append(entry)
        print(f"[{len(pool)}/{args.count}] {coords[1]:.4f}, {coords[0]:.4f}  {entry['viewer_url']}")
        # Checkpoint after every find so an interrupted run still yields a pool.
        with open("location_pool.json", "w") as f:
            json.dump(pool, f, indent=2)
        if attempts > args.count * 40:
            print("Attempt budget exhausted; keeping what we have.", file=sys.stderr)
            break

    with open("location_pool.json", "w") as f:
        json.dump(pool, f, indent=2)
    print(f"\nDone: {len(pool)} verified pano locations in location_pool.json "
          f"({attempts} sample attempts)")

if __name__ == "__main__":
    main()
