/**
 * The 10-player palette. `players.color` (0–9, assigned by the DB) indexes it.
 *
 * Each color has a tuned shade per theme:
 * - `light` sits on white / paper (Whiteboard, Lobby): deep 700-ish shades,
 *   ≥3:1 against white so marks read, with white `ink` for text on the fill.
 * - `dark` sits on the near-black Scoreboard: bright 300/400-ish shades, ≥3:1
 *   against #0b0d10, with near-black `ink` for text on the fill.
 * Contrast and pairwise distinctness are checked in palette.test.ts.
 */

export type PaletteTheme = "light" | "dark";

export type Swatch = {
  /** The color itself: swatches, cross-offs, lit squares. */
  fill: string;
  /** Text color to use on top of `fill`. */
  ink: string;
};

export type PlayerColor = {
  name: string;
  light: Swatch;
  dark: Swatch;
};

const WHITE = "#ffffff";
const NEAR_BLACK = "#111214";

export const PALETTE: readonly PlayerColor[] = [
  { name: "Red", light: { fill: "#a8141b", ink: WHITE }, dark: { fill: "#ff6b6b", ink: NEAR_BLACK } },
  { name: "Orange", light: { fill: "#c24600", ink: WHITE }, dark: { fill: "#ff9a3c", ink: NEAR_BLACK } },
  { name: "Amber", light: { fill: "#7a6a00", ink: WHITE }, dark: { fill: "#ffd23f", ink: NEAR_BLACK } },
  { name: "Green", light: { fill: "#2e7d32", ink: WHITE }, dark: { fill: "#5ee07a", ink: NEAR_BLACK } },
  { name: "Teal", light: { fill: "#00796b", ink: WHITE }, dark: { fill: "#2ee6d6", ink: NEAR_BLACK } },
  { name: "Blue", light: { fill: "#1d4ed8", ink: WHITE }, dark: { fill: "#5ea8ff", ink: NEAR_BLACK } },
  { name: "Violet", light: { fill: "#6d28d9", ink: WHITE }, dark: { fill: "#b69cff", ink: NEAR_BLACK } },
  { name: "Pink", light: { fill: "#c2185b", ink: WHITE }, dark: { fill: "#ff7ec4", ink: NEAR_BLACK } },
  { name: "Brown", light: { fill: "#6b3e26", ink: WHITE }, dark: { fill: "#d2a679", ink: NEAR_BLACK } },
  { name: "Slate", light: { fill: "#4a5a6a", ink: WHITE }, dark: { fill: "#cfd8dc", ink: NEAR_BLACK } },
];

/** Palette entry for a player color index (wraps defensively; the DB keeps it 0–9). */
export function paletteEntry(index: number): PlayerColor {
  const i = ((Math.trunc(index) % PALETTE.length) + PALETTE.length) % PALETTE.length;
  return PALETTE[i];
}

export function playerColor(index: number, theme: PaletteTheme): Swatch {
  return paletteEntry(index)[theme];
}
