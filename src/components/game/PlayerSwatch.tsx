import type { CSSProperties } from "react";
import { paletteEntry } from "@/lib/palette";

/** A player's palette color as a small pencil-edged dot (light/dark shade by color scheme). */
export function PlayerSwatch({ color, label, className }: { color: number; label?: string; className?: string }) {
  const entry = paletteEntry(color);
  const style = {
    "--swatch-light": entry.light.fill,
    "--swatch-light-ink": entry.light.ink,
    "--swatch-dark": entry.dark.fill,
    "--swatch-dark-ink": entry.dark.ink,
  } as CSSProperties;
  return (
    <span
      data-testid="player-swatch"
      data-color={color}
      role={label ? "img" : undefined}
      aria-label={label ? `${label}: ${entry.name}` : undefined}
      aria-hidden={label ? undefined : true}
      className={`swatch inline-block size-6 shrink-0 rounded-[48%_52%_45%_55%/55%_45%_52%_48%] border-2 border-ink ${className ?? ""}`}
      style={style}
    />
  );
}
