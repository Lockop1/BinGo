import { paletteEntry, playerColor, type PaletteTheme } from "@/lib/palette";

/**
 * A player's color as a small marker dot, in the shade for the board's theme
 * (PlayerSwatch follows the phone's color scheme instead, for paper screens).
 */
export function BoardSwatch({ color, theme, className }: { color: number; theme: PaletteTheme; className?: string }) {
  return (
    <span
      data-testid="player-swatch"
      data-color={color}
      data-shade={theme}
      aria-hidden
      title={paletteEntry(color).name}
      className={`inline-block size-6 shrink-0 rounded-[48%_52%_45%_55%/55%_45%_52%_48%] border-2 border-ink ${className ?? ""}`}
      style={{ backgroundColor: playerColor(color, theme).fill }}
    />
  );
}
