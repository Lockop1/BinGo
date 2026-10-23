import type { CSSProperties } from "react";
import { paletteEntry } from "@/lib/palette";

/**
 * A player's color as a pencil-edged dot. `theme="auto"` follows the color
 * scheme (paper summary); `"dark"` always uses the bright shade (the dark story
 * viewer). `data-color` carries the palette index for tests.
 */
export function ColorChip({
  color,
  theme = "auto",
  className,
}: {
  color: number;
  theme?: "auto" | "dark";
  className?: string;
}) {
  const entry = paletteEntry(color);
  const style =
    theme === "dark"
      ? ({ backgroundColor: entry.dark.fill } as CSSProperties)
      : ({
          "--swatch-light": entry.light.fill,
          "--swatch-light-ink": entry.light.ink,
          "--swatch-dark": entry.dark.fill,
          "--swatch-dark-ink": entry.dark.ink,
        } as CSSProperties);
  return (
    <span
      aria-hidden
      data-testid="color-chip"
      data-color={color}
      data-color-name={entry.name}
      style={style}
      className={`${theme === "dark" ? "border-white/80" : "swatch border-ink"} inline-block size-5 shrink-0 rounded-[48%_52%_45%_55%/55%_45%_52%_48%] border-2 ${className ?? ""}`}
    />
  );
}
