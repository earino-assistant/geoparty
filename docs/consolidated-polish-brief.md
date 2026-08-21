# CONSOLIDATED POLISH BRIEF — GeoParty "made, not assembled"

**For:** Sonnet 5 (implementer) · **From:** Opus 4.8 (architect) · **Date:** 2026-08-21
**Mandate:** ONE coherent change (one batch). All items owner-approved; do not re-litigate design. Do **not** half-apply.

## 0. Guardrails — what must NOT change (read first)
- No build step, no npm deps, no server code. Works as static files, degrades on `file://`. Font is a static asset.
- Privacy/consent/replay inviolable. The basemap swap has a network-sanitizer consequence (§3 P0.1). `POSTHOG_INIT_OPTIONS` stays mutable; `blockSelector`/`maskAllInputs` not weakened; PostHog never referenced outside `consent.js`/`analytics.js`.
- Viewer rules: never construct `new mapillary.Viewer`/`moveTo` in a page module. This pass only CSS-restyles already-rendered Mapillary control DOM (P1.1).
- Do NOT touch `tools/`, `data/location_pool.json`, `data/pool_quarantine.json`, Firebase config, PostHog init key/options values, Mapillary/SRI pins.
- `html-contract.test.js` is live — keep element ids in sync with controllers. `howto.html` has no controller; do NOT add it to the PAGES map.
- Gate: `npm test` all green + `npm run check`.

## 1. Sequencing (do in this order; single coherent change)
1. Tokens + global element styles (`css/style.css` `:root`, `a`, `button:disabled`) — §2.
2. Self-host display font (`/assets` + `@font-face` + head preload) — §2.B.
3. Pure basemap helper + test, then repoint ALL ~12 tile call sites — §3 P0.1.
4. Per-surface CSS/HTML/JS: disabled labels, consent dock, Mapillary controls, TV code, void-fill, share buttons, host celebration, guess-bar declutter, skeletons, footers — §3–§4.
5. Meta/manifest URL swap — §3 P0.4.
6. Mark + icon regen — §2.B.
7. `howto.html` + screenshots into `/assets` — §6.
8. Tests + docs — §7.
9. `npm test` + `npm run check`; screenshot checklist §9.

Do not ship a partial (e.g. new palette without the disabled-button token, or CARTO basemap without the sanitizer test/doc update).

## 2. Foundation: palette, font, mark, tone

### 2.A Global link treatment
No global `a` rule today; only `.ld-footer a { color: var(--muted); }` (style.css:248). Body links (daily.html:142) fall back to browser blue on black.
Add to `css/style.css` near base element block (after button rules ~line 45):
```css
a { color: var(--accent); text-decoration: none; }
a:hover, a:focus-visible { color: var(--fg); text-decoration: underline; }
```
Keep `.ld-footer a { color: var(--muted); }` but add `.ld-footer a:hover { color: var(--fg); }`. `.daily-back-link` has its own class — verify reads well. No link anywhere falls back to default blue.

### 2.B Palette tokens
Update `:root` (style.css:5-16). Keep token names; change values + add disabled/surface-raised tokens:
```css
:root {
  --bg:       #0E0E12;
  --panel:    #17171E;
  --panel-2:  #22222C;
  --raised:   #2E2E3A;   /* NEW */
  --fg:       #F4F4F6;
  --muted:    #B0B0BC;   /* lightened for AA (P1.8) */
  --accent:   #FFCF3F;
  --team-1: #FFCF3F;  --team-2: #4DD6FF;  --team-3: #FF6EC7;  --team-4: #7DFF8A;
  --disabled-fg: #8A8A96; /* NEW */
  --action-bar-h: 80px;
}
```
- `manifest.webmanifest` `background_color`/`theme_color` (#111111) and every `<meta name="theme-color">` (5 files) → `#0E0E12`.
- Add `.leaflet-container { background: var(--bg); }` so tile-load flash isn't white.
- Icon dot colors in `assets/icon.svg`/`make-icons.mjs` currently `#ff6b6b/#5ac8fa/#7ee081` → re-point to constellation (Sky→`#4DD6FF`, Green→Mint `#7DFF8A`, red→Magenta `#FF6EC7`).

**Testability:** pure color-token changes not unit-testable — state so.

### 2.B Display font — Space Grotesk (self-host)
- Download variable woff2 (official OFL release / Google Fonts CSS API / floriankarsten/space-grotesk release) → `assets/SpaceGrotesk-Variable.woff2` (~40KB). Include `assets/SpaceGrotesk-OFL.txt` (license travels with font).
- `@font-face` at top of style.css after `:root`:
```css
@font-face { font-family:"Space Grotesk"; src:url("../assets/SpaceGrotesk-Variable.woff2") format("woff2"); font-weight:300 700; font-display:swap; font-style:normal; }
:root { --font-display: "Space Grotesk", system-ui, sans-serif; }
```
- Body stays system-ui. Apply `--font-display` to display surfaces: `.tv-title`/`.geo` wordmark, landing wordmark, `h1`/`h2` headings, `.room-code-huge`, stat big numerals (`.stat-card .big`, `.hud-item`, `.total-row .val`), countdown/score numerals. Anchor group at style.css:1898 (`.room-code-huge, .locked-rank, .stat-card .big, .hud-item, .h2h-lobby-code`).
- Preload in each of the 5 HTML `<head>`s: `<link rel="preload" href="assets/SpaceGrotesk-Variable.woff2" as="font" type="font/woff2" crossorigin>` (relative path).
- `npm run check` unaffected (CSS-only). file:// falls back to system-ui gracefully.

### 2.B Mark / icon
- Edit `assets/icon.svg` AND `mark()` template in `assets/make-icons.mjs` (must stay identical). Evolve pin → target/reticle: keep gold pin silhouette, replace plain punched hole with concentric ring + crosshair ticks in `--bg`/gold. Keep four constellation confetti dots (recolored). Update bg gradient stops to ink ramp (`#22222C`→`#0E0E12`).
- Align PWA tile gradient (BG_TOP/BG_BOTTOM in make-icons.mjs) + manifest background_color to ink ramp.
- PNG regen is TOOLED MANUAL step: `node assets/make-icons.mjs` (requires ffmpeg+librsvg). If available, run + commit regenerated PNGs. If not, commit SVG/source and FLAG in summary that owner must run it before deploy. Never hand-edit binary PNGs.
- Re-run `pwa.test.js`; update if it asserts colors.

### 2.B Tone — sentence case
Sweep visible copy in 5 HTML + `*-ui.js` string literals to sentence case; exactly two shouting stamps preserved: **LOCKED IN** and **SUPER SURE**. Fold "operator"→"host": screen.html:45 "Waiting for the operator…" → "Waiting for the host…". List touched strings in summary.

## 3. P0 fixes

### P0.1 — Dark basemap
~12 tile call sites: daily-ui.js:376,558 · host-ui.js:805,1286 · screen-ui.js:464,700,816 · player-ui.js:1059,1864 · screen-h2h.js:332,600. Do ALL.
Centralize into tested pure helper in `js/imagery.js`:
```js
export const BASEMAP_URL = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
export function basemapTileLayerConfig() {
  return { url: BASEMAP_URL, options: { maxZoom:19, subdomains:"abcd",
    attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>' } };
}
```
At each call site: `import { basemapTileLayerConfig } from "./imagery.js"; const bm = basemapTileLayerConfig(); L.tileLayer(bm.url, bm.options).addTo(theMap);`
CARTO not Stadia (keyless, free).

**PRIVACY TAIL (ship-blocker):**
- Replay masking unaffected (`blockSelector` blocks whole map element regardless of host).
- Network sanitizer: `basemaps.cartocdn.com` NOT on `NETWORK_HOST_ALLOWLIST`, so dropped by default — good. Update explanatory comment at analytics.js:98-103 to name the new host. Update test `tests/analytics.test.js:1296-1301` to assert a CARTO tile URL (`https://a.basemaps.cartocdn.com/dark_all/16/32791/21801.png`) is dropped + not allowlisted; keep OSM assertion. Update `docs/replay-mask-checklist.md:223`.
- `.leaflet-container { background: var(--bg) }` for offline dark void.

**Test:** `tests/imagery.test.js` — assert `basemapTileLayerConfig().url` is CARTO dark host, coordinate-shaped (`/{z}/{x}/{y}`), attribution present.

Zero-dep CSS-invert stopgap only if CARTO unreachable; note in summary, don't ship by default.

### P0.2 — Disabled primary button
```css
button:disabled { opacity:1; background:var(--raised); color:var(--disabled-fg); cursor:default; }
.btn-primary:disabled { background:var(--raised); color:var(--disabled-fg); }
```
Make guess CTAs (`#btnConfirmGuess`/`#btnDLockIn`/`#btnLockIn`) show gate text "Tap the map to drop your pin" when no pin, "Lock it in" once pin exists (two-line button pattern `.btn-main`/`.btn-sub` at style.css:614-628).
**Test:** put label decision in pure helper (`lockButtonLabel({hasPin})`) in js/game.js + unit test it.

### P0.3 — Consent banner + floating cookie
`.consent-banner` (style.css:1252) floats off bottom over CTA; `.consent-settings` (style.css:1277) is the floating "cookie".
- Dock banner to true bottom, one compact line: `left:0;right:0;bottom:0;border-radius:16px 16px 0 0;max-width:none`, reduce padding, one-line copy, inline actions.
- Never cover CTA: extend `body[data-play="1"] .consent-banner { display:none }` idea; on any surface with `.action-bar`, banner sits below/clear of it. Verify against guess map where it'd sit on "Lock It In".
- Floating cookie: demote `.consent-settings` from floating circle to quiet text link in footer/settings sheet. Keep reachable (revoke inviolable); do NOT weaken consent.js.
- Consent logic already tested (chrome.test.js); this is CSS/placement — not unit-testable.

### P0.4 — Canonical / OG / manifest URLs → geoparty.social
Replace `https://earino-assistant.github.io/geoparty/...` with `https://geoparty.social/...` in index.html:18-19, daily.html:20-21,25, host.html:18-19, player.html:19,21, screen.html:17-18,20 (all og:url, og:image, twitter:image). Add `<link rel="canonical" href="https://geoparty.social/…">` to each of 5 pages. manifest start_url/scope/id STAY relative. GitHub footer links (index.html:101-103) stay (Privacy/GitHub).
Update pwa.test.js/html-contract.test.js if they assert URLs.

### P0.5 — font: covered in §2.B.

## 4. P1 fixes
- **P1.1 Mapillary controls** (CSS only; anchors style.css:1017-1025): hide sequence scrubber `.viewer-full .mapillary-sequence-container { display:none; }`; restyle zoom/compass to dark+gold. Bearing outer class = `mapillary-bearing-indicator-container` (verified). Not unit-testable.
- **P1.2 TV room code**: `#roomInput` → `var(--font-display)`, `color:var(--fg)`, high weight, large letter-spacing; placeholder `var(--muted)`. Keep data-ph-mask. Use `.room-code-huge` for displayed codes.
- **P1.3 Void fill**: vertically center setup/intro columns; ≥768px center column + fill void using existing `.hero-pano` mechanism (dimmed drifting hero behind). Add `@media (min-width:768px)` block. Pure CSS.
- **P1.4 Share buttons**: `#btnPShareResult` (player.html:194) + `#btnShareResult` (host.html:211) → `class="btn-ghost"` (established secondary; style.css:1763). Others stay btn-primary. Demote 📤 emoji.
- **P1.5 Host game-over celebration**: call existing `celebrationSpec({won, champion, teamColor, seed, surface:"host"})` + fx-ui render at host game-over (host-ui.js:1466 area), mirroring player call site. Add fx.test.js case if `surface` gates. fx.js is pure+tested.
- **P1.6 Guess-bar declutter (h2h decoy chip)**: bar must be ≤2 controls. Move 🎭 decoy control into SUPER SURE sheet (css/style.css:1905+). Do NOT change decoy state logic (js/decoy.js tested). Update replay-mask-checklist if DOM position changes.
- **P1.7 Skeleton/placeholder**: `#roomCodeHuge` shows `······` (host.html:130); replace literal filler with `.skeleton` class (pulsing `var(--raised)`) or hold render. Do NOT show `Points 0`/`Distance —` as real. Add `.skeleton` utility; toggle in controllers until value lands. Keep data-ph-mask on `#roomCodeHuge`.
- **P1.8 Muted contrast**: done in §2.B. Not testable.
- **P1.9 Ownership line**: add to `.ld-footer` (index.html:98) + game-over screens: `© 2026 Eduardo Ariño de la Rubia · A game by Eduardo Ariño de la Rubia` (muted). Static copy — not testable.

## 5. P2 (as they fit cleanly — don't over-scope)
- Leaflet attribution restyle: `.leaflet-control-attribution` → `background: rgba(14,14,18,0.6); color: var(--muted);` links via global `a` rule.
- Emoji demotion: keep 🔥/🎭 meaning chips; demote decorative (📤 on share buttons, landing 📱🤳📺 strip replaced by screenshots in §6).
- Celebration rhythm cap: one hero stat, ≤2 supporting, rest quieter (CSS hierarchy pass). Note if deferred.
- "host" not "operator": folded into §2.B.
- icon dot colors → constellation: folded into §2.B.

## 6. Tutorial / How-to
- **New static page `howto.html`** — no controller, NOT blocking. Same `<head>` block (font preload, favicon, manifest, OG, canonical `https://geoparty.social/howto.html`, theme-color `#0E0E12`). Five illustrated steps, real screenshots, sentence case, ≤1 line each. Reuse css/style.css; no new JS module. Do NOT add to html-contract PAGES map.
- Move screenshots from `/opt/data/geoparty-qa-screens/` into `assets/` (01-landing, 05-daily-gameplay, 06-daily-guessmap, plus a reveal + TV/QR shot). Crop/downsize to ≤~150KB each. These are source for OG + landing strip.
- Five steps: 1) Open GeoParty / pick a way to play · 2) You're dropped somewhere in the world · 3) Look around, then tap the map to drop your pin · 4) Closer + faster = more points · 5) Put it on the TV / challenge friends (QR). Route first-timers to the Daily with prominent CTA.
- Link from landing footer + game-over screens (new `a`/`btn-ghost` styles).
- Upgrade landing 3-step strip (index.html:81-94): replace emoji `📱🤳📺` with small cropped real screenshots (`<img>` alt, lazy, captioned). Also upgrade two-emoji arts at index.html:48,53 if mode cards.
- **Test:** howto.html static — not unit-testable (state so). If a page-enumeration test lists HTML files, add howto.html.

## 7. Tests & docs summary
**Real testable logic added (must have tests):**
- `basemapTileLayerConfig()` → tests/imagery.test.js (CARTO host, coordinate shape, attribution).
- Network sanitizer: tests/analytics.test.js:1296 extended to assert CARTO tiles dropped + not allowlisted.
- `lockButtonLabel` helper (P0.2) → pure test.
- `celebrationSpec` host surface (P1.5) if surface gates → tests/fx.test.js case.
- `howto_opened` event (analytics) → schema + call + sanitizer test + docs/analytics.md.

**Explicitly NOT unit-testable (state in summary):** palette token values, @font-face/font asset, disabled-button CSS, consent banner CSS, Mapillary control CSS, TV code CSS, void-fill media queries, share-button class, footer/ownership copy, tone sweep, mark SVG, howto.html, attribution restyle.

**PostHog:** add `howto_opened` (source: footer|gameover) — schema in analytics.js (aggregate `source` enum only), track() in howto link handlers, sanitizer test, docs/analytics.md. This is genuine onboarding signal.

**Docs to update in-commit:** docs/replay-mask-checklist.md (CARTO host at :223; decoy-chip DOM move :136 if it changes), docs/analytics.md (howto_opened), docs/ui-ux-design-review.md §4 if guess-bar rule affected.

**Gate:** npm test all green + npm run check.

## 8. Exact file manifest
- CSS (1): css/style.css.
- HTML (6): index/daily/host/player/screen.html + howto.html (new).
- JS (touch, minimal): js/imagery.js (basemapTileLayerConfig), ~12 tile call sites (daily-ui/host-ui/screen-ui/player-ui/screen-h2h), daily-ui/player-ui/host-ui (disabled-label, host celebration, decoy-chip relocation, skeleton toggles), js/game.js (lockButtonLabel), js/analytics.js (sanitizer comment + howto_opened schema+call), possibly js/fx.js (host surface).
- Assets (add): SpaceGrotesk-Variable.woff2, SpaceGrotesk-OFL.txt, howto-*.png (from qa-screens), edited icon.svg + regenerated PNGs + edited make-icons.mjs.
- Manifest: manifest.webmanifest (colors #0E0E12; URLs relative).
- Tests/docs: tests/imagery.test.js, tests/analytics.test.js, (opt) tests/fx.test.js, tests/pwa.test.js; docs/replay-mask-checklist.md, docs/analytics.md.

## 9. Owner real-device / screenshot checklist (post-implement)
1. Daily guess map — dark basemap; "Lock it in" real disabled (not olive), shows "Tap the map to drop your pin" until pin; attribution dim.
2. Daily reveal — dark basemap, pins legible.
3. TV entry — room code big, gold/--fg, Space Grotesk, readable from 4m.
4. Consent banner — docked bottom, one line, never covers CTA; floating cookie gone.
5. Landing — wordmark Space Grotesk; 3-step strip real screenshots; footer ownership + How to Play link; links gold.
6. howto.html — 5 steps render, images load, Daily CTA works.
7. Host game-over — confetti/bloom fires like player/daily.
8. h2h guess bar — ≤2 controls; decoy in SUPER SURE sheet.
9. OG/link preview — geoparty.social → regenerated OG image + correct URL.
10. PWA install — reticle mark icon; ink-ramp splash/theme.
11. Offline/file:// — dark void (not white flash); font falls back.
12. npm test + npm run check green locally and CI.

**One-batch reminder:** apply §1 in order, commit as single coherent change. Avoid partial apply. Land tokens + shared classes first.