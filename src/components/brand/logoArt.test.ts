import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LOGO_GRID_PATHS,
  LOGO_GRID_WIDTH,
  LOGO_INK,
  LOGO_PAPER,
  LOGO_PAPER_RADIUS,
  LOGO_RED,
  LOGO_STRIKE,
  LOGO_VIEWBOX,
} from "./logoArt";

const svg = readFileSync(join(process.cwd(), "public/icons/logo.svg"), "utf8");

describe("logo art", () => {
  it("matches the master public/icons/logo.svg", () => {
    expect(svg).toContain(`viewBox="0 0 ${LOGO_VIEWBOX} ${LOGO_VIEWBOX}"`);
    expect(svg).toContain(`<rect width="${LOGO_VIEWBOX}" height="${LOGO_VIEWBOX}" rx="${LOGO_PAPER_RADIUS}" fill="${LOGO_PAPER}"/>`);
    expect(svg).toContain(`stroke="${LOGO_INK}" stroke-width="${LOGO_GRID_WIDTH}"`);
    expect(svg).toContain(`stroke="${LOGO_RED}"`);

    const paths = [...svg.matchAll(/<path(?: stroke-width="(\d+)")? d="([^"]+)"\/>/g)].map(([, width, d]) => ({
      d,
      width: width ? Number(width) : null,
    }));
    expect(paths).toEqual([
      ...LOGO_GRID_PATHS.map((d) => ({ d, width: null })),
      ...LOGO_STRIKE.map(({ d, width }) => ({ d, width })),
    ]);
  });

  it("keeps grid strokes at least 1/12 of the width so the mark reads at 32 px", () => {
    expect(LOGO_GRID_WIDTH).toBeGreaterThanOrEqual(LOGO_VIEWBOX / 12);
    expect(LOGO_GRID_PATHS).toHaveLength(8); // 4 frame sides + 2 + 2 inner lines = 3x3
  });

  it("is the same artwork as the legacy icon.svg copy", () => {
    expect(readFileSync(join(process.cwd(), "public/icons/icon.svg"), "utf8")).toBe(svg);
  });
});
