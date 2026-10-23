#!/usr/bin/env node
// Renders public/icons/icon.svg into the PWA / home-screen PNGs with the
// preinstalled Chromium (Playwright). Run: node scripts/make-icons.mjs
//
//   icon-192.png / icon-512.png   purpose "any": the SVG as drawn (rounded paper, transparent corners)
//   icon-maskable-512.png         purpose "maskable": full-bleed paper, artwork shrunk into the
//                                 80% safe-zone circle so any launcher mask keeps the whole grid
//   apple-touch-icon.png (180)    full-bleed paper (iOS rounds the corners itself and paints
//                                 transparent pixels black)
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = path.join(root, "public", "icons");
const PAPER = "#fbf8ef";

const outputs = [
  { file: "icon-192.png", size: 192, fullBleed: false, scale: 1 },
  { file: "icon-512.png", size: 512, fullBleed: false, scale: 1 },
  { file: "icon-maskable-512.png", size: 512, fullBleed: true, scale: 0.8 },
  { file: "apple-touch-icon.png", size: 180, fullBleed: true, scale: 1 },
];

const svg = await readFile(path.join(iconsDir, "icon.svg"), "utf8");
const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

const browser = await chromium.launch();
try {
  for (const { file, size, fullBleed, scale } of outputs) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const inner = Math.round(size * scale);
    await page.setContent(`<!doctype html>
<html><body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:${
      fullBleed ? PAPER : "transparent"
    }"><img id="icon" src="${src}" width="${inner}" height="${inner}" alt=""></body></html>`);
    await page.locator("#icon").evaluate((img) => img.decode());
    await page.screenshot({ path: path.join(iconsDir, file), omitBackground: !fullBleed });
    await page.close();
    console.log(`wrote public/icons/${file} (${size}x${size})`);
  }
} finally {
  await browser.close();
}
