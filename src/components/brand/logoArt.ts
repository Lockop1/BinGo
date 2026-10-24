/**
 * The Bingo Night mark as data: a 3x3 bingo card in thick marker strokes with one winning
 * line scribbled through it in red, on a paper square. Mirrors public/icons/logo.svg (the
 * master the PNG icons and favicon are rendered from); logoArt.test.ts keeps the two in sync.
 */

export const LOGO_VIEWBOX = 512;
export const LOGO_PAPER = "#fbf8ef";
export const LOGO_PAPER_RADIUS = 104;
export const LOGO_INK = "#24272a";
export const LOGO_RED = "#c8302a";

/** Grid strokes (44/512, above 1/12 of the width so the grid reads at 32 px). */
export const LOGO_GRID_WIDTH = 44;
export const LOGO_GRID_PATHS: readonly string[] = [
  "M62 64 Q180 56 300 61 Q390 65 450 58",
  "M452 60 Q458 180 450 300 Q446 390 453 452",
  "M452 450 Q340 458 220 451 Q120 446 60 453",
  "M60 452 Q54 340 60 220 Q64 120 58 62",
  "M192 61 Q186 190 193 320 Q196 400 190 451",
  "M321 60 Q327 180 320 300 Q317 400 323 452",
  "M59 193 Q180 185 300 192 Q390 196 451 189",
  "M58 320 Q170 326 290 319 Q380 315 452 323",
];

/**
 * The winning line: one quick marker scribble through the three diagonal cell centres, in
 * three visibly offset, slightly curved passes (up, a hooked turn and back down, then half-way
 * up again), so it reads as a hand-drawn cross-off rather than a clean strike-through.
 */
export const LOGO_STRIKE: readonly { d: string; width: number }[] = [
  { d: "M108 365 Q226 229 365 113", width: 48 },
  { d: "M365 113 Q395 109 382 141 Q280 273 161 388", width: 30 },
  { d: "M161 388 Q154 414 185 392 Q250 311 327 242", width: 30 },
];
