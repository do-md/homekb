#!/usr/bin/env node
/**
 * HomeKB icon generator — single source of truth for the app mark.
 *
 * The mark: a bold orange open book — the knowledge base. Two pages splay from a
 * central spine gutter, with a few short "text" lines carved out in negative
 * space. Orange (#ff8000, the brand primary) is the accent; the tile is the
 * near-black canvas from the design system (--hk-bg #0c0d10).
 *
 * Variants emitted from the same geometry:
 *   - rounded squircle tile (transparent corners) for the desktop app icon,
 *     consumed by `tauri icon` to regenerate every platform size + .icns/.ico.
 *   - full-bleed square, logo inside the ~80% maskable safe zone, for the PWA
 *     icons declared `purpose: "any maskable"` in the web manifest.
 *   - browser-tab favicon: the same rounded tile as app/icon.svg (crisp at any
 *     size) plus app/icon.png (raster fallback). Next App Router auto-links both.
 *
 * Usage:
 *   node scripts/gen-icons.mjs            # regenerate PWA + master PNGs + favicon
 *   node scripts/gen-icons.mjs && npx tauri icon <master.png>  # desktop icons
 */
import sharp from "sharp";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = resolve(HERE, "..");

// Brand tokens (icons are static, so the brand orange is fixed here).
const CANVAS = 1024;

/** Build the orange open-book mark as an SVG string. */
function buildSvg({ rounded, logoScale }) {
    const cx = CANVAS / 2;

    // Open book: two pages splayed from a central spine gutter (dark gap).
    // Each page is a quadrilateral; rounded stroke gives it weight + soft corners.
    const rightPage = "M542 340 L804 398 L796 650 L542 704 Z";
    const leftPage = "M482 340 L220 398 L228 650 L482 704 Z";

    // Short "text" lines carved out of each page (knowledge / reading).
    const textLines = [
        "M576 452 L760 452",
        "M576 520 L760 520",
        "M576 588 L748 588",
        "M448 452 L264 452",
        "M448 520 L264 520",
        "M448 588 L276 588",
    ];

    const rx = rounded ? 230 : 0;

    // A subtle scale keeps the mark inside the maskable safe circle (~80%).
    const t = `translate(${cx} ${cx}) scale(${logoScale}) translate(${-cx} ${-cx})`;

    // Hairline rim only on the rounded desktop tile (a maskable crop would clip it).
    const rim = rounded
        ? `<rect x="6" y="6" width="${CANVAS - 12}" height="${CANVAS - 12}" rx="${rx - 6}" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="2"/>`
        : "";

    const lines = textLines
        .map(
            (d) =>
                `<path d="${d}" fill="none" stroke="#101015" stroke-width="22" stroke-linecap="round"/>`,
        )
        .join("\n    ");

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <defs>
    <radialGradient id="bg" cx="50%" cy="30%" r="85%">
      <stop offset="0%" stop-color="#191b21"/>
      <stop offset="60%" stop-color="#101116"/>
      <stop offset="100%" stop-color="#0a0b0e"/>
    </radialGradient>
    <linearGradient id="brand" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffa53d"/>
      <stop offset="55%" stop-color="#ff8000"/>
      <stop offset="100%" stop-color="#ec6600"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${CANVAS}" height="${CANVAS}" rx="${rx}" fill="url(#bg)"/>
  ${rim}
  <g transform="${t}">
    <path d="${leftPage} ${rightPage}" fill-rule="evenodd"
          fill="url(#brand)" stroke="url(#brand)" stroke-width="36"
          stroke-linejoin="round" stroke-linecap="round"/>
    ${lines}
  </g>
</svg>`;
}

async function render(svg, size, outPath) {
    await mkdir(dirname(outPath), { recursive: true });
    await sharp(Buffer.from(svg)).resize(size, size).png().toFile(outPath);
    console.log("wrote", outPath);
}

async function main() {
    const roundedSvg = buildSvg({ rounded: true, logoScale: 1.12 });
    const maskableSvg = buildSvg({ rounded: false, logoScale: 1.0 });

    // Committed source of truth.
    await writeFile(resolve(CLIENT, "src-tauri/icons/icon.svg"), roundedSvg);

    // Master PNG for `tauri icon` (rounded desktop tile).
    await render(roundedSvg, 1024, resolve(CLIENT, "src-tauri/icons/icon-master.png"));

    // PWA maskable icons (full-bleed square, safe-zone logo).
    await render(maskableSvg, 512, resolve(CLIENT, "public/icon-512.png"));
    await render(maskableSvg, 192, resolve(CLIENT, "public/icon-192.png"));

    // Browser-tab favicon (Next App Router file convention: app/icon.{svg,png}).
    // SVG stays crisp at any tab size; PNG is the fallback for browsers without
    // SVG-favicon support. The rounded tile matches the desktop app mark.
    await writeFile(resolve(CLIENT, "app/icon.svg"), roundedSvg);
    await render(roundedSvg, 512, resolve(CLIENT, "app/icon.png"));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
