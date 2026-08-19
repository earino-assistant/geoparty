#!/usr/bin/env python3
"""
Score every location in data/location_pool.json with a difficulty tier.

The game wants to separate "recognizable place" (a Tokyo intersection, a
Paris boulevard) from "impossible rural road". Recognizability R (0-100)
combines three signals:

  - URBAN ANCHOR (55%): how big a city the pano effectively sits in.
    For every GeoNames cities500 place within ~35 km we compute a distance-
    decayed "pull" pop / (1 + (d_km/8)^2) and keep the max. A 2M metro at
    1 km pulls ~2M; a 100k city 24 km away pulls only ~10k. Log-scaled:
    1k effective -> 0, ~3M effective -> full marks. Big cities mean dense
    signage, famous skylines, recognizable scripts and street furniture.

  - SETTLEMENT DENSITY (15%): count of cities500 places within 15 km,
    saturating at 12. A cheap offline proxy for POI/landmark density —
    conurbations are full of guessable clues even between their centers,
    while an isolated town scores low no matter its own size.

  - IMAGERY DENSITY (30%): Mapillary images inside a ~450 m box around the
    pano (capped at 200). Where many people photograph, roads are traveled
    and recognizable; a lone stray capture is exactly the "unnamed rural
    road" we want in the hard tier. This is the only networked signal; it
    is fetched once per image id into tools/.cache/imagery_density.json and
    reused forever. While a density is unknown the other two signals are
    rescaled to 100%, so tiers exist (a bit coarser) before the fetch
    completes and sharpen as the cache fills.

Tiers (persisted per entry as an ADDITIVE `difficulty` field; every
existing field is untouched and old clients simply ignore it) are POOL-
RELATIVE: entries are ranked by R and cut at quantiles —
    1 = easy   (top 45% by R)  — the Casual pool, every room's opening round
    2 = medium (middle 35%)
    3 = hard   (bottom 20%)    — the Expert pool
Quantiles rather than absolute R thresholds because the pool build is
GeoNames-city-seeded: nearly everything sits near SOME city, so absolute
cuts left the hard tier nearly empty (3 of 5,312 on the offline signals).
The host's choice means "this pool's recognizable slice" vs "this pool's
brutal slice" — that is a rank, not an absolute. Ties break on image_id,
so tiers are deterministic and every tier is always big enough to play.

Usage (stdlib only):
    python3 tools/score_location_pool.py                  # score + write tiers
    python3 tools/score_location_pool.py --fetch-density  # long networked pass:
        # only fills the density cache (checkpointed, rate-limit-friendly,
        # resumable — it skips ids already cached). Run it in the background,
        # then re-run the plain command to sharpen the persisted tiers.
        # Combine with --sample N to prove the fetch on the first N entries.
    python3 tools/score_location_pool.py --sample 300     # score + tier only
        # the first N entries (quantiles over that slice — a proving run)
    python3 tools/score_location_pool.py --stats          # print R histogram,
        # tier counts and examples; still writes unless --dry-run
    python3 tools/score_location_pool.py --self-test      # offline unit checks

Determinism: same pool + same density cache -> byte-identical tiers, so the
whole run can be interrupted and repeated freely.
"""

import argparse
import json
import math
import os
import sys
import threading
import time

import urllib.error
import urllib.parse
import urllib.request

from concurrent.futures import ThreadPoolExecutor

# Reuse the build pipeline's GeoNames loader, pool IO and API config.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scale_location_pool import (  # noqa: E402
    ACCESS_TOKEN, SEARCH_API, CACHE, load_geonames, load_pool, save_pool,
)

DENSITY_CACHE = os.path.join(CACHE, "imagery_density.json")

# --- heuristic constants (change = re-tiering the whole pool; keep stable) --
PULL_HALF_KM = 8.0        # a city's pull halves at this distance
ANCHOR_LOG_LO = 3.0       # log10(effective pop): 1k -> 0 anchor score
ANCHOR_LOG_HI = 6.5       # ~3.2M effective -> full anchor score
DENSITY_RADIUS_KM = 15.0  # settlement-density neighborhood
DENSITY_SAT = 12          # places within the radius for full marks
IMG_BOX_HALF = 0.002      # ~450 m box, matches the build's dedupe grid scale
IMG_CAP = 200             # one API page; enough dynamic range on a log scale
W_ANCHOR, W_SETTLE, W_IMG = 0.55, 0.15, 0.30
TIER_EASY_FRAC = 0.45     # top fraction of the pool by R -> tier 1
TIER_HARD_FRAC = 0.20     # bottom fraction by R -> tier 3


# ------------------------------------------------------------- geo helpers

class CityIndex:
    """Grid index over GeoNames cities500 for radius queries."""

    CELL = 0.5  # degrees

    def __init__(self, cities):
        self.index = {}
        for c in cities:  # (lat, lng, name, cc, pop)
            key = (int(c[0] // self.CELL), int(c[1] // self.CELL))
            self.index.setdefault(key, []).append(c)

    def near(self, lat, lng, radius_km):
        """Yield (city, d_km) for cities within radius_km."""
        # 1 deg lat ~ 111 km; pad the cell ring by one to cover the radius.
        ring = int(radius_km / (self.CELL * 111.0)) + 1
        ci, cj = int(lat // self.CELL), int(lng // self.CELL)
        for i in range(ci - ring, ci + ring + 1):
            for j in range(cj - ring, cj + ring + 1):
                for c in self.index.get((i, j), ()):
                    d = haversine_km(lat, lng, c[0], c[1])
                    if d <= radius_km:
                        yield c, d


def haversine_km(lat1, lng1, lat2, lng2):
    rad = math.radians
    a = (math.sin(rad(lat2 - lat1) / 2) ** 2
         + math.cos(rad(lat1)) * math.cos(rad(lat2))
         * math.sin(rad(lng2 - lng1) / 2) ** 2)
    return 2 * 6371 * math.asin(math.sqrt(a))


# ------------------------------------------------------------- the scoring

def clamp01(x):
    return 0.0 if x < 0 else 1.0 if x > 1 else x


def anchor_score(entry, cities):
    """0..1 from the distance-decayed pull of the strongest nearby city."""
    pull = 0.0
    for (clat, clng, _name, _cc, pop), d in cities.near(
            entry["lat"], entry["lng"], 35.0):
        pull = max(pull, pop / (1.0 + (d / PULL_HALF_KM) ** 2))
    if pull < 1:
        return 0.0
    return clamp01((math.log10(pull) - ANCHOR_LOG_LO)
                   / (ANCHOR_LOG_HI - ANCHOR_LOG_LO))


def settlement_score(entry, cities):
    """0..1 from the count of settlements within DENSITY_RADIUS_KM."""
    n = sum(1 for _ in cities.near(entry["lat"], entry["lng"],
                                   DENSITY_RADIUS_KM))
    return clamp01(n / DENSITY_SAT)


def imagery_score(count):
    """0..1 from a Mapillary image count, log-scaled; None if unknown."""
    if count is None:
        return None
    return clamp01(math.log10(1 + min(count, IMG_CAP)) / math.log10(1 + IMG_CAP))


def recognizability(anchor, settle, imagery):
    """Weighted 0-100; without imagery the other weights are rescaled."""
    if imagery is None:
        return 100.0 * (W_ANCHOR * anchor + W_SETTLE * settle) / (W_ANCHOR + W_SETTLE)
    return 100.0 * (W_ANCHOR * anchor + W_SETTLE * settle + W_IMG * imagery)


def tiers_by_rank(scored):
    """{key: tier} from [(r, key)] pairs: rank by R descending (key breaks
    ties deterministically) and cut at the TIER_EASY_FRAC / TIER_HARD_FRAC
    quantiles. Pool-relative by design — see the module docstring."""
    ranked = sorted(scored, key=lambda rk: (-rk[0], rk[1]))
    n = len(ranked)
    easy_end = round(n * TIER_EASY_FRAC)
    hard_start = n - round(n * TIER_HARD_FRAC)
    return {key: 1 if i < easy_end else (3 if i >= hard_start else 2)
            for i, (_r, key) in enumerate(ranked)}


# ------------------------------------------------------ imagery density I/O

def load_density_cache():
    try:
        with open(DENSITY_CACHE) as f:
            return {k: v for k, v in json.load(f).items() if isinstance(v, int)}
    except (OSError, ValueError):
        return {}


def save_density_cache(cache):
    os.makedirs(CACHE, exist_ok=True)
    tmp = DENSITY_CACHE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cache, f)
    os.replace(tmp, DENSITY_CACHE)


def fetch_density(entry):
    """Count Mapillary images in a small box around the pano; None on failure."""
    half = IMG_BOX_HALF
    box = (entry["lng"] - half, entry["lat"] - half,
           entry["lng"] + half, entry["lat"] + half)
    params = {
        "access_token": ACCESS_TOKEN,
        "fields": "id",
        "bbox": ",".join(f"{v:.6f}" for v in box),
        "limit": IMG_CAP,
    }
    url = SEARCH_API + "?" + urllib.parse.urlencode(params)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=25) as r:
                return len(json.load(r).get("data", []))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(20)       # rate limited: back off hard
            elif e.code >= 500:
                time.sleep(2 + attempt)  # dense-box timeout: brief retry
            else:
                return None
        except (urllib.error.URLError, OSError, ValueError):
            time.sleep(1 + attempt)
    return None


def fetch_density_pass(pool, workers):
    """Fill the density cache for every pool entry missing one. Resumable:
    already-cached ids are skipped, the cache is checkpointed every 100."""
    cache = load_density_cache()
    todo = [e for e in pool if e["image_id"] not in cache]
    print(f"Density cache has {len(cache)} entries; fetching {len(todo)} more "
          f"with {workers} workers (~450m bbox, limit {IMG_CAP})...")
    lock = threading.Lock()
    done = [0, 0]
    start = time.time()

    def one(entry):
        count = fetch_density(entry)
        with lock:
            done[0] += 1
            if count is None:
                done[1] += 1
            else:
                cache[entry["image_id"]] = count
            if done[0] % 100 == 0:
                save_density_cache(cache)
                rate = done[0] / max(1e-9, time.time() - start)
                eta = (len(todo) - done[0]) / max(rate, 1e-9) / 60
                print(f"  {done[0]}/{len(todo)} fetched "
                      f"({done[1]} failed), ~{eta:.0f} min left")

    with ThreadPoolExecutor(max_workers=workers) as ex:
        list(ex.map(one, todo))
    save_density_cache(cache)
    print(f"Done: {done[0]} fetched, {done[1]} failed (retried on next run), "
          f"cache={len(cache)} in {(time.time() - start) / 60:.1f} min")
    return cache


# --------------------------------------------------------------- main modes

def score_pool(args):
    print("Loading GeoNames data...")
    geo_cities, _country_names = load_geonames()
    cities = CityIndex(geo_cities)
    pool = load_pool()
    if not pool:
        sys.exit("No pool at data/location_pool.json")
    density = load_density_cache()
    targets = pool[: args.sample] if args.sample else pool

    print(f"Scoring {len(targets)}/{len(pool)} entries "
          f"({sum(1 for e in targets if e['image_id'] in density)} with "
          f"cached imagery density)...")
    raw = []
    for i, e in enumerate(targets):
        a = anchor_score(e, cities)
        s = settlement_score(e, cities)
        im = imagery_score(density.get(e["image_id"]))
        raw.append((recognizability(a, s, im), e))
        if (i + 1) % 1000 == 0:
            print(f"  {i + 1}/{len(targets)}")

    # Quantile tiers need every R first; the whole pass is local math (the
    # slow, networked part is --fetch-density), so one write at the end.
    tiers = tiers_by_rank([(r, e["image_id"]) for r, e in raw])
    scores = []
    changed = 0
    counts = {1: 0, 2: 0, 3: 0}
    for r, e in raw:
        t = tiers[e["image_id"]]
        scores.append((r, t, e))
        counts[t] += 1
        if e.get("difficulty") != t:
            e["difficulty"] = t
            changed += 1
    print(f"Tiers over the scored slice: easy={counts[1]} "
          f"medium={counts[2]} hard={counts[3]} (changed {changed})")

    if args.stats:
        print_stats(scores)
    if args.dry_run:
        print("--dry-run: pool not written.")
        return
    save_pool(pool)
    print(f"Wrote tiers for {len(targets)} entries.")


def print_stats(scores):
    rs = sorted(r for r, _t, _e in scores)
    print("\nRecognizability distribution:")
    for pct in (5, 25, 50, 75, 95):
        print(f"  p{pct}: {rs[min(len(rs) - 1, len(rs) * pct // 100)]:.1f}")
    buckets = [0] * 10
    for r in rs:
        buckets[min(9, int(r // 10))] += 1
    for b, n in enumerate(buckets):
        print(f"  {b * 10:3d}-{b * 10 + 10:3d}: {'#' * (n * 60 // max(1, max(buckets)))} {n}")
    by_tier = {1: [], 2: [], 3: []}
    for r, t, e in scores:
        by_tier[t].append((r, e["name"]))
    for t, label in ((1, "easy"), (2, "medium"), (3, "hard")):
        ex = sorted(by_tier[t])[:: max(1, len(by_tier[t]) // 5)][:5]
        print(f"  tier {t} ({label}) examples: "
              + "; ".join(f"{n} ({r:.0f})" for r, n in ex))


def self_test():
    """Offline checks of the scoring math on synthetic fixtures."""
    metro = [(48.8566, 2.3522, "Paris", "FR", 2_100_000)]
    for d_lat, want_hi in ((0.0, True), (0.05, True)):
        cities = CityIndex(metro)
        e = {"lat": 48.8566 + d_lat, "lng": 2.3522}
        a = anchor_score(e, cities)
        assert (a > 0.8) == want_hi, f"metro anchor {a} at dlat={d_lat}"

    town = [(45.0, 5.0, "Smallville", "XX", 3_000)]
    e = {"lat": 45.25, "lng": 5.0}  # ~28 km from a 3k town
    a = anchor_score(e, CityIndex(town))
    assert a < 0.05, f"remote anchor should be ~0, got {a}"

    nowhere = anchor_score({"lat": -45.0, "lng": -170.0}, CityIndex(metro))
    assert nowhere == 0.0

    dense = [(50.0 + i * 0.02, 8.0, f"c{i}", "DE", 20_000) for i in range(21)]
    s = settlement_score({"lat": 50.2, "lng": 8.0}, CityIndex(dense))
    assert s == 1.0, f"conurbation density should saturate, got {s}"
    s2 = settlement_score({"lat": 45.25, "lng": 5.0}, CityIndex(town))
    assert s2 <= 1 / DENSITY_SAT + 1e-9

    assert imagery_score(None) is None
    assert imagery_score(0) == 0.0
    assert imagery_score(IMG_CAP) == 1.0
    assert imagery_score(10_000) == 1.0  # capped
    assert 0.3 < imagery_score(5) < 0.5

    # Quantile tiers: the rank decides. A metro pano with dense imagery
    # outranks (and out-tiers) an imagery-unknown town, which outranks the
    # void — including entries scored on the imagery-less fallback.
    rs = [(recognizability(0.95, 1.0, 0.9), "metro"),
          (recognizability(0.45, 0.3, 0.3), "midtown"),
          (recognizability(0.30, 0.2, None), "town"),
          (recognizability(0.05, 0.1, 0.05), "village"),
          (recognizability(0.0, 0.0, 0.1), "void")]
    tiers = tiers_by_rank(rs)
    assert tiers["metro"] == 1 and tiers["midtown"] == 1, tiers
    assert tiers["town"] == 2 and tiers["village"] == 2, tiers
    assert tiers["void"] == 3, tiers

    # Cut fractions hold on a bigger pool: 45 easy / 35 medium / 20 hard.
    tiers = tiers_by_rank([(float(i), f"k{i:03d}") for i in range(100)])
    spread = {1: 0, 2: 0, 3: 0}
    for t in tiers.values():
        spread[t] += 1
    assert spread == {1: 45, 2: 35, 3: 20}, spread
    assert tiers["k099"] == 1 and tiers["k000"] == 3

    # Ties break on the key, deterministically.
    tied = [(50.0, k) for k in ("b", "a", "c", "e", "d")]
    assert tiers_by_rank(tied) == tiers_by_rank(list(reversed(tied)))
    assert tiers_by_rank(tied) == {"a": 1, "b": 1, "c": 2, "d": 2, "e": 3}

    # Determinism: recomputing gives identical values.
    assert recognizability(0.5, 0.5, 0.5) == recognizability(0.5, 0.5, 0.5)
    print("self-test OK")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--fetch-density", action="store_true",
                    help="Only fill the imagery-density cache (long, "
                         "networked, resumable). Does NOT write the pool.")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--sample", type=int, default=0,
                    help="Only the first N entries (0 = all): scoring slices "
                         "the tiering, --fetch-density slices the fetch")
    ap.add_argument("--stats", action="store_true",
                    help="Print the score distribution and tier examples")
    ap.add_argument("--dry-run", action="store_true",
                    help="Score and report, but do not write the pool")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        self_test()
    elif args.fetch_density:
        fetch_density_pass(load_pool()[: args.sample or None], args.workers)
    else:
        score_pool(args)


if __name__ == "__main__":
    main()
