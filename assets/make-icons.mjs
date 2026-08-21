#!/usr/bin/env node
// make-icons.mjs — regenerates every raster asset in assets/ from the SVG
// templates below. Dev-time only (never loaded by the site): the PNGs are
// committed, so serving stays static/no-build. Rerun after editing the mark:
//
//   node assets/make-icons.mjs        (requires ffmpeg with librsvg support)
//
// Outputs: icon.svg (the favicon, written verbatim), favicon-48.png,
// icon-192/512.png (manifest "any"), icon-maskable-192/512.png (mark held
// inside the 80% safe zone), apple-touch-icon.png (180, opaque full-bleed),
// og-image.png (1200x630 link card).

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = dirname(fileURLToPath(import.meta.url));

// Palette mirrors css/style.css: --bg #0E0E12, --panel-2 #22222C, --accent
// #FFCF3F, --team-2/3/4 (brand-launch ink ramp + constellation).
const ACCENT = "#FFCF3F";
const BG_TOP = "#22222C";
const BG_BOTTOM = "#0E0E12";
const HOLE = "#0E0E12";
// Sky/Green/red → the constellation's team-2/4/3 (team-1 gold is the pin
// itself, so the mark carries all four team colors between pin + dots).
const CONFETTI = ["#FF6EC7", "#4DD6FF", "#7DFF8A"];

// The mark: a map pin (circle r=134 at 256,218 tapering to a tip at 256,430)
// evolved from a plain punched hole into a target/reticle — a concentric
// ring + crosshair ticks, gold on the ink hole — plus a faint ground
// ellipse and three confetti dots (the "party"). At pinScale 0.88 the whole
// mark — confetti included, the widest element at radius ~219 from center —
// fits inside the maskable 80% safe-zone circle (r≈205): 219·0.88 + dot
// radius ≈ 204.
function mark(pinScale) {
  return `
  <g transform="translate(256 256) scale(${pinScale}) translate(-256 -256)">
    <circle cx="104" cy="118" r="17" fill="${CONFETTI[0]}"/>
    <circle cx="408" cy="98" r="13" fill="${CONFETTI[1]}"/>
    <circle cx="424" cy="178" r="11" fill="${CONFETTI[2]}"/>
    <ellipse cx="256" cy="441" rx="64" ry="13" fill="${ACCENT}" opacity="0.28"/>
    <path fill="${ACCENT}" d="M256,84 a134,134 0 0 1 134,134
      c0,100 -134,212 -134,212 s-134,-112 -134,-212
      a134,134 0 0 1 134,-134 z"/>
    <circle cx="256" cy="218" r="54" fill="${HOLE}"/>
    <circle cx="256" cy="218" r="34" fill="none" stroke="${ACCENT}" stroke-width="7"/>
    <g stroke="${ACCENT}" stroke-width="7" stroke-linecap="round">
      <line x1="256" y1="148" x2="256" y2="172" />
      <line x1="256" y1="264" x2="256" y2="288" />
      <line x1="186" y1="218" x2="210" y2="218" />
      <line x1="302" y1="218" x2="326" y2="218" />
    </g>
  </g>`;
}

// rounded: transparent rounded-corner tile (favicon); square otherwise
// (manifest / apple-touch, where the platform applies its own mask).
function iconSvg({ px, rounded, pinScale }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${BG_TOP}"/>
      <stop offset="1" stop-color="${BG_BOTTOM}"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="${rounded ? 96 : 0}" fill="url(#bg)"/>
  ${mark(pinScale)}
</svg>
`;
}

// 1200x630 link card: mark on the left, wordmark + tagline on the right.
// DejaVu Sans ships with librsvg-capable environments; the PNG is committed,
// so viewers never depend on the font.
function ogSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${BG_TOP}"/>
      <stop offset="1" stop-color="${BG_BOTTOM}"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="1050" cy="80" r="200" fill="#ffffff" opacity="0.03"/>
  <circle cx="120" cy="560" r="260" fill="#ffffff" opacity="0.03"/>
  <g transform="translate(36 59)">
    ${'' /* mark occupies 512x512 at this offset */}
    <g>${mark(1.05)}</g>
  </g>
  <g font-family="DejaVu Sans" text-anchor="start">
    <text x="540" y="266" font-size="96" font-weight="bold">
      <tspan fill="${ACCENT}">Geo</tspan><tspan fill="#ffffff">Party</tspan>
    </text>
    <text x="543" y="336" font-size="32" fill="#e8e8ef">Guess where in the world you are.</text>
    <text x="543" y="384" font-size="32" fill="#e8e8ef">Phones in, pins down.</text>
    <text x="543" y="452" font-size="25" fill="#8f8f9c">Free in the browser · no app, no accounts</text>
  </g>
</svg>
`;
}

function render(svg, outName, px, height) {
  const tmp = mkdtempSync(join(tmpdir(), "geoparty-icons-"));
  const svgPath = join(tmp, "in.svg");
  writeFileSync(svgPath, svg);
  const r = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-width", String(px), "-height", String(height ?? px),
    "-i", svgPath, "-frames:v", "1", "-y", join(OUT, outName),
  ]);
  rmSync(tmp, { recursive: true, force: true });
  if (r.status !== 0) {
    throw new Error(`ffmpeg failed for ${outName}: ${r.stderr}`);
  }
  console.log("wrote", outName);
}

// The favicon SVG is served as-is (rounded tile, scalable).
writeFileSync(join(OUT, "icon.svg"), iconSvg({ px: 512, rounded: true, pinScale: 1.12 }));
console.log("wrote icon.svg");

render(iconSvg({ px: 48, rounded: true, pinScale: 1.12 }), "favicon-48.png", 48);
render(iconSvg({ px: 192, rounded: false, pinScale: 1.12 }), "icon-192.png", 192);
render(iconSvg({ px: 512, rounded: false, pinScale: 1.12 }), "icon-512.png", 512);
render(iconSvg({ px: 192, rounded: false, pinScale: 0.88 }), "icon-maskable-192.png", 192);
render(iconSvg({ px: 512, rounded: false, pinScale: 0.88 }), "icon-maskable-512.png", 512);
render(iconSvg({ px: 180, rounded: false, pinScale: 1.12 }), "apple-touch-icon.png", 180);
render(ogSvg(), "og-image.png", 1200, 630);
