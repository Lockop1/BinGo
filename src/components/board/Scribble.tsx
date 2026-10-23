"use client";

import { useMemo, useState } from "react";
import { jitter } from "@/lib/game/boardText";

const r = (n: number) => n.toFixed(1);

/**
 * Two or three marker strokes crossing the cell, wobbled by a fixed per-square
 * seed so every phone draws the same scribble for the same square.
 * Coordinates are in a 0–100 box.
 */
export function scribblePaths(seed: number): string[] {
  const j = (n: number, amp: number) => jitter(seed * 7.31 + n) * amp;
  const a = { x: 15 + j(1, 5), y: 17 + j(2, 5) };
  const b = { x: 85 + j(3, 5), y: 83 + j(4, 5) };
  const c = { x: 50 + j(5, 9), y: 50 + j(6, 9) };
  const d = { x: 84 + j(7, 5), y: 15 + j(8, 5) };
  const e = { x: 16 + j(9, 5), y: 85 + j(10, 5) };
  const f = { x: 50 + j(11, 9), y: 50 + j(12, 9) };
  const paths = [
    `M ${r(a.x)} ${r(a.y)} Q ${r(c.x)} ${r(c.y)} ${r(b.x)} ${r(b.y)}`,
    `M ${r(d.x)} ${r(d.y)} Q ${r(f.x)} ${r(f.y)} ${r(e.x)} ${r(e.y)}`,
  ];
  // Most squares get a quick second pass over the first stroke, like a marker
  // going back over its line.
  if (jitter(seed * 3.7 + 20) > -0.3) {
    const s = { x: a.x + 9 + j(13, 3), y: a.y + 14 + j(14, 3) };
    const t = { x: b.x - 6 + j(15, 3), y: b.y + 1 + j(16, 3) };
    paths.push(`M ${r(s.x)} ${r(s.y)} Q ${r(c.x + 5)} ${r(c.y + 7)} ${r(t.x)} ${r(t.y)}`);
  }
  return paths;
}

const STROKE_DELAY_MS = 150;

/**
 * The cross-off. Draws in (stroke-dashoffset, under 0.7 s in total) only when
 * it appears after the board was already on screen; squares that were done
 * at load are drawn instantly. Reduced motion: a short fade (globals.css).
 * `pending`: an optimistic completion not yet confirmed (shown fainter).
 */
export function Scribble({
  seed,
  color,
  animate = false,
  pending = false,
  muted = false,
}: {
  seed: number;
  color: string;
  animate?: boolean;
  pending?: boolean;
  muted?: boolean;
}) {
  // Decided once, at mount: confirming a pending scribble must not redraw it.
  const [drawIn] = useState(animate);
  const paths = useMemo(() => scribblePaths(seed), [seed]);
  return (
    <span
      aria-hidden
      data-testid="scribble"
      data-pending={pending || undefined}
      className="pointer-events-none absolute inset-0 transition-opacity duration-300"
      style={{ opacity: pending ? 0.4 : muted ? 0.75 : 0.92 }}
    >
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="scribble size-full overflow-visible"
        data-animate={drawIn || undefined}
      >
        {paths.map((d, i) => (
          <path
            key={i}
            d={d}
            pathLength={1}
            fill="none"
            strokeWidth={muted ? 4.5 : i === 2 ? 5.5 : 7}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ stroke: color, animationDelay: drawIn ? `${i * STROKE_DELAY_MS}ms` : undefined }}
          />
        ))}
      </svg>
    </span>
  );
}
