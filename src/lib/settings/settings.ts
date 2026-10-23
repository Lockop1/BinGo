import { readLocal, writeLocal } from "@/lib/storage/local";
import type { PaletteTheme } from "@/lib/palette";

/**
 * The three per-phone settings (CLAUDE.md "Settings"), stored in localStorage
 * under `bingo.settings`. Nothing here is game state: it only changes how this
 * phone draws the board.
 */

export type BoardTheme = "scoreboard" | "whiteboard";
export type TextSize = "normal" | "large" | "xlarge";
export type SquareSize = "normal" | "tall";

export type Settings = {
  /** `null` follows the phone: dark color scheme → Dark Scoreboard, light → Whiteboard. */
  theme: BoardTheme | null;
  textSize: TextSize;
  squareSize: SquareSize;
};

/** What may be in storage: anything (an old version, a hand edit), so every field is checked. */
export type StoredSettings = Partial<Record<keyof Settings, unknown>>;

export const SETTINGS_KEY = "bingo.settings";

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  theme: null,
  textSize: "normal",
  squareSize: "normal",
});

export const BOARD_THEMES: readonly BoardTheme[] = ["scoreboard", "whiteboard"];
export const TEXT_SIZES: readonly TextSize[] = ["normal", "large", "xlarge"];
export const SQUARE_SIZES: readonly SquareSize[] = ["normal", "tall"];

/** Label multiplier per text size (`--board-text-scale`, mirrored in globals.css). */
export const TEXT_SCALE: Readonly<Record<TextSize, number>> = { normal: 1, large: 1.2, xlarge: 1.45 };
/** Cell height ÷ width per square size (`--board-cell-ratio`, mirrored in globals.css). */
export const CELL_RATIO: Readonly<Record<SquareSize, number>> = { normal: 1, tall: 1.35 };

function oneOf<T extends string>(options: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}

/** Valid fields are kept, anything else falls back to its default (never throws). */
export function parseSettings(value: unknown): Settings {
  const raw: StoredSettings = value && typeof value === "object" && !Array.isArray(value) ? (value as StoredSettings) : {};
  return {
    theme: oneOf(BOARD_THEMES, raw.theme) ? raw.theme : null,
    textSize: oneOf(TEXT_SIZES, raw.textSize) ? raw.textSize : DEFAULT_SETTINGS.textSize,
    squareSize: oneOf(SQUARE_SIZES, raw.squareSize) ? raw.squareSize : DEFAULT_SETTINGS.squareSize,
  };
}

export function sameSettings(a: Settings, b: Settings): boolean {
  return a.theme === b.theme && a.textSize === b.textSize && a.squareSize === b.squareSize;
}

/** The theme the phone itself asks for. */
export function systemTheme(prefersDark: boolean): BoardTheme {
  return prefersDark ? "scoreboard" : "whiteboard";
}

/** The pinned theme, or the phone's if none is pinned. */
export function resolveTheme(settings: Pick<Settings, "theme">, prefersDark: boolean): BoardTheme {
  return settings.theme ?? systemTheme(prefersDark);
}

/** Player-color shade for a board theme (dark shades on the Scoreboard, light ones on white). */
export function paletteThemeFor(theme: BoardTheme): PaletteTheme {
  return theme === "scoreboard" ? "dark" : "light";
}

export function loadSettings(): Settings {
  return parseSettings(readLocal(SETTINGS_KEY));
}

/** Merge `patch` into the stored settings and persist (same-tab and other-tab listeners are notified). */
export function saveSettings(patch: Partial<Settings>): Settings {
  const next = parseSettings({ ...loadSettings(), ...patch });
  writeLocal(SETTINGS_KEY, next);
  return next;
}
