# Scaling the GeoParty location pool to 2000+

> **Executed — the pool is at 5,312 entries, built by
> `tools/scale_location_pool.py`.** §"Results / operations" is the live
> runbook (including the periodic `--refresh-thumbs` re-run);
> §"Problem" and §"Research findings" are the rationale record.
> Difficulty tiers are assigned afterwards by
> `tools/score_location_pool.py`.

## Problem

`data/location_pool.json` shipped with 29 entries. The game needs thousands.
The original generator (`tools/build_location_pool.py`, kept as-is) samples one
random bbox per candidate — hundreds of serial Mapillary requests for a handful
of hits, made worse by a known Mapillary regression (since Nov 2025) where
bbox `/images` searches over data-dense areas return HTTP 500 timeouts.

## Research findings (Aug 2026)

- **Graph API `/images` bbox search**: `limit` maxes at 2000, but dense-area
  boxes 500 (Mapillary staff confirmed these are timeouts; the fix is much
  smaller boxes). No pagination for plain bbox queries. Rate limit: 10,000
  req/min — not the bottleneck. Empirically, ~0.005°-wide boxes with a high
  `limit` succeed reliably and return up to ~200 panos in one request,
  including `thumb_1024_url` — so one request can yield several pool entries.
- **Vector tiles** (`mly1_public`, z14 image points): good for discovery but
  capped at 50,000 req/day, needs an MVT/protobuf decoder (no pip packages in
  this environment), and does **not** carry thumbnail URLs — every image would
  still need an entity lookup. Net loss vs. bbox search for this volume.
- **Bulk export**: Mapillary offers no downloadable coverage dataset.
- **Naming**: Nominatim's policy is max 1 req/sec, bulk discouraged — 2000+
  lookups is impractical and impolite. GeoNames (`cities500.zip`,
  ~13 MB, CC-BY 4.0) enables fully offline nearest-city reverse geocoding.

## Chosen strategy — implemented in `tools/scale_location_pool.py`

1. **Seed from GeoNames, not random sampling.** Download `cities500.zip` +
   `countryInfo.txt` once (cached in `tools/.cache/`). Take all cities with
   population ≥ 50k (~12,400 across 188 countries), cap seeds per country, and
   interleave countries round-robin so an early stop still leaves a global
   spread.
2. **One high-limit bbox request per seed.** ~0.005°-wide box centered on the
   city, `is_pano=true`, `limit=200`, requesting
   `id,computed_geometry,captured_at,thumb_1024_url` — everything the schema
   needs except `name`, in a single request. On HTTP 500 the box shrinks and
   retries (dense-area timeout); 429 backs off; other errors skip the seed.
   A modest thread pool (default 8) keeps total wall time ~tens of minutes
   while staying far below Mapillary's documented limits.
3. **Filter + spread.** Keep panos captured ≥ 2018 with geometry and a thumb;
   dedupe globally on image id and a ~0.004° (~450 m) grid; cap picks per seed
   so no city dominates. Checkpoints merge into `data/location_pool.json` as
   the run progresses, so interruptions never lose work; existing entries are
   preserved.
4. **Name offline via GeoNames.** Nearest populated place (grid-indexed
   nearest-neighbor over cities500) formatted as `"City, Country"`, matching
   the existing pool's style — zero geocoding API calls. GeoNames data is
   CC-BY 4.0 (attribution: geonames.org).
5. **Validate.** `tools/validate_location_pool.py` asserts exact schema keys,
   sane coordinate ranges, unique ids, non-empty names, and minimum count.

## Results / operations

- Run `python3 tools/scale_location_pool.py` (stdlib only) to (re)build;
  it resumes/merges by default. `--target`, `--workers`, `--max-seeds` tune it.
- Caveat: `thumb` URLs are signed CDN links that expire after roughly a month
  (true of the original 29 entries too). Re-run the tool periodically — with
  `--refresh-thumbs` it re-resolves thumbs for existing entries by image id via
  the entity API (60k req/min quota) without changing anything else.
