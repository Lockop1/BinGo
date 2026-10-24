#!/usr/bin/env node
// Renders the master logo (public/icons/logo.svg) into every PNG icon and the favicon with
// the preinstalled Chromium (Playwright). Run: node scripts/make-icons.mjs
//
//   icon-192.png / icon-512.png   manifest purpose "any": the logo as drawn (rounded paper,
//                                 transparent corners)
//   icon-maskable-512.png         manifest purpose "maskable": full-bleed paper, artwork shrunk
//                                 so every stroke sits inside the 80% safe-zone circle
//   apple-touch-icon.png (180)    full-bleed paper, no transparency (iOS rounds the corners
//                                 itself and paints transparent pixels black)
//   favicon-32.png / favicon-16.png  browser tabs (rounded paper, transparent corners); the 16 px
//                                 one comes from logo-16.svg, the same mark redrawn on whole pixels
//   ../favicon.ico                the 16 and 32 PNGs in one ICO container (written by hand below)
//   icon.svg                      a copy of logo.svg, kept for links that still point at it
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const iconsDir = path.join(publicDir, "icons");
const PAPER = "#fbf8ef";

// Farthest stroke point from the centre is a frame corner: (196, 196) + a 22-unit round cap
// = 299 units of 512. The maskable safe zone is a circle of radius 0.4 * 512 = 204.8, so the
// artwork may use at most 204.8 / 299 = 0.685 of the canvas.
const MASKABLE_SCALE = 0.68;

const outputs = [
  { file: "icon-192.png", size: 192, fullBleed: false, scale: 1 },
  { file: "icon-512.png", size: 512, fullBleed: false, scale: 1 },
  { file: "icon-maskable-512.png", size: 512, fullBleed: true, scale: MASKABLE_SCALE },
  { file: "apple-touch-icon.png", size: 180, fullBleed: true, scale: 0.9 },
  { file: "favicon-32.png", size: 32, fullBleed: false, scale: 1 },
  { file: "favicon-16.png", size: 16, fullBleed: false, scale: 1, source: "logo-16.svg" },
];

/** ICO container: ICONDIR header, one ICONDIRENTRY per image, then the PNG payloads. */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 means 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // palette colours (none)
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8); // payload size
    entry.writeUInt32LE(offset, 12); // payload offset from the start of the file
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

async function dataUrl(file) {
  const svg = await readFile(path.join(iconsDir, file));
  return `data:image/svg+xml;base64,${svg.toString("base64")}`;
}

const rendered = new Map();
const browser = await chromium.launch();
try {
  for (const { file, size, fullBleed, scale, source = "logo.svg" } of outputs) {
    const src = await dataUrl(source);
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const inner = Math.round(size * scale);
    await page.setContent(`<!doctype html>
<html><body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:${
      fullBleed ? PAPER : "transparent"
    }"><img id="icon" src="${src}" width="${inner}" height="${inner}" alt=""></body></html>`);
    await page.locator("#icon").evaluate((img) => img.decode());
    const png = await page.screenshot({ path: path.join(iconsDir, file), omitBackground: !fullBleed });
    rendered.set(size, png);
    await page.close();
    console.log(`wrote public/icons/${file} (${size}x${size})`);
  }
} finally {
  await browser.close();
}

await writeFile(
  path.join(publicDir, "favicon.ico"),
  buildIco([16, 32].map((size) => ({ size, png: rendered.get(size) }))),
);
console.log("wrote public/favicon.ico (16x16, 32x32)");

await copyFile(path.join(iconsDir, "logo.svg"), path.join(iconsDir, "icon.svg"));
console.log("wrote public/icons/icon.svg (copy of logo.svg)");
