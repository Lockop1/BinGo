import { describe, expect, it } from "vitest";
import { PALETTE, playerColor } from "./palette";

function channel(c: number) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance(hex: string) {
  const [r, g, b] = rgb(hex).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** Euclidean distance in sRGB, weighted ("redmean"); good enough to catch near-duplicates. */
function distance(a: string, b: string) {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  const rm = (r1 + r2) / 2;
  return Math.sqrt((2 + rm / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - rm) / 256) * (b1 - b2) ** 2);
}

const WHITEBOARD = "#ffffff";
const PAPER = "#fbf8ef";
const SCOREBOARD = "#0b0d10";

describe("player palette", () => {
  it("has 10 colors", () => {
    expect(PALETTE).toHaveLength(10);
  });

  it("is legible on white/paper (light) and near-black (dark)", () => {
    for (const color of PALETTE) {
      expect(contrast(color.light.fill, WHITEBOARD), color.name).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color.light.fill, PAPER), color.name).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color.dark.fill, SCOREBOARD), color.name).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color.light.fill, color.light.ink), color.name).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color.dark.fill, color.dark.ink), color.name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps colors distinct within each theme", () => {
    for (const theme of ["light", "dark"] as const) {
      for (let i = 0; i < PALETTE.length; i++) {
        for (let j = i + 1; j < PALETTE.length; j++) {
          const d = distance(PALETTE[i][theme].fill, PALETTE[j][theme].fill);
          expect(d, `${theme}: ${PALETTE[i].name} vs ${PALETTE[j].name}`).toBeGreaterThan(100);
        }
      }
    }
  });

  it("playerColor indexes by theme", () => {
    expect(playerColor(0, "light")).toBe(PALETTE[0].light);
    expect(playerColor(9, "dark")).toBe(PALETTE[9].dark);
  });
});
