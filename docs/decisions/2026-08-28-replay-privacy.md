# Decision record — replay privacy relaxation (2026-08-28)

**Owner:** Eduardo Ariño de la Rubia · **Scope:** GeoParty only
**Status:** DECIDED; implemented on this branch. Flag Party (flagparty.social)
is explicitly out of scope — its masking is unchanged.

## Ruling

After a debugging session was hampered by over-masking, the owner ruled:

> Guesses and where the person is navigating are not really personal
> information. Masking them just made it hard to debug an error.

## Policy

**Still masked (identity / live secrets) — unchanged:**
- Team names (people type real names), room codes (live joinable identifiers)
- Everything typed (`maskAllInputs`), all `data-ph-mask` surfaces
- `.leaflet-tooltip` pin labels (they carry team names)
- Network bodies/headers; query strings (Mapillary access tokens); tile hosts
  stay out of the network waterfall
- Consent gating; the aggregate-only event schema; the §10.4 diagnostic lane

**Now visible in replay (gameplay — owner's ruling):**
- The guess map and the reveal map (`.leaflet-container` dropped from
  `blockSelector`; `[data-ph-block]` remains the escape hatch)
- The street-view pano — `captureCanvas: { recordCanvas: true, canvasFps: 2,
  canvasQuality: "0.5" }`

## Measured constraints (spike, 2026-08-28; posthog-js 1.422.2, mapillary-js 4.1.2)

- The **object form is required**: posthog-js reads
  `captureCanvas.recordCanvas`; a bare `captureCanvas: true` is silently a
  no-op (falls through to the project-side dial, which is off).
- posthog-js forces `preserveDrawingBuffer: true` on WebGL contexts created
  **after** init — no Mapillary viewer change needed, but a viewer built
  before opt-in yields no frames until rebuilt.
- Verified by decoding rrweb canvas-mutation frames from a live capture:
  mean luminance ≈ 143/255 with real scene content — not black frames, not
  the placeholder gray. ~40 KB/frame at desktop size, 2 fps.

## Consent copy

The banner promise was restated in the same change (commit `714d70f`): the
recording shows "what the game showed you — maps and street view included";
the "never" list is now "your name, your room code, or anything you type."
A test guards that the banner never promises a masking posture the config
does not have.

## Boundaries this decision does NOT move

- Nothing derived from a user's guess is ever *sent* as an analytics
  property (no coordinates, no raw Mapillary image ids, no team names).
- The Daily Ghost Duel URL-fragment boundary (approved 2026-08-20) is
  unchanged: it governs the payload's transport, not pixels of a duel the
  recipient chose to play on their own screen.
- The pre-decision rationale ("a tile URL is a coordinate") survives where
  it is still true: tile hosts are dropped from the network waterfall, and
  the event schema still strips coordinate-shaped keys.
- Flag Party's masking (masked toast, masked guesses, no console recording)
  is untouched by this decision and remains a separate owner call.

*Dated records in `docs/` that predate this decision (EM/incident reviews,
retired plans, the 2026-08-23 content audit) are intentionally left as
history — do not "fix" them.*