"use client";

import { motion } from "motion/react";
import { useMemo } from "react";
import { jitter } from "@/lib/game/boardText";
import { BLACKOUT_MS, BULB_COUNT, bulbTrack, marqueePoints, wordTrack } from "@/lib/game/endSequence";
import type { BoardTheme } from "@/lib/settings/settings";

// The marquee sign, in its own 340 × 210 box: bulbs every 42 units round a
// 294 × 168 rectangle (7 × 4 spacings, so a bulb sits on every corner).
const VIEW_W = 340;
const VIEW_H = 210;
const RING = { x: 23, y: 21, width: 294, height: 168 };
const POINTS = marqueePoints(BULB_COUNT, RING);
const DURATION_S = BLACKOUT_MS / 1000;
/** The screen goes fully dark over the last moments, after the last bulb. */
const DARK_FROM = 3_330 / BLACKOUT_MS;

const f = (n: number) => n.toFixed(1);

/** A slightly wobbly marker circle (four curves, fixed per-bulb seed). */
function markerCircle(cx: number, cy: number, r: number, seed: number): string {
  const k = 0.552 * r;
  const w = (n: number) => jitter(seed * 5.3 + n) * 0.9;
  const top = { x: cx + w(1), y: cy - r + w(2) };
  const right = { x: cx + r + w(3), y: cy + w(4) };
  const bottom = { x: cx + w(5), y: cy + r + w(6) };
  const left = { x: cx - r + w(7), y: cy + w(8) };
  return [
    `M ${f(top.x)} ${f(top.y)}`,
    `C ${f(top.x + k)} ${f(top.y)} ${f(right.x)} ${f(right.y - k)} ${f(right.x)} ${f(right.y)}`,
    `C ${f(right.x)} ${f(right.y + k)} ${f(bottom.x + k)} ${f(bottom.y)} ${f(bottom.x)} ${f(bottom.y)}`,
    `C ${f(bottom.x - k)} ${f(bottom.y)} ${f(left.x)} ${f(left.y + k)} ${f(left.x)} ${f(left.y)}`,
    // Overshoot past the start, like a marker closing a loop.
    `C ${f(left.x)} ${f(left.y - k)} ${f(top.x - k)} ${f(top.y)} ${f(top.x + 2)} ${f(top.y - 0.4)}`,
  ].join(" ");
}

/** The sign's outline, drawn in marker (whiteboard). */
function markerFrame(): string {
  const x0 = 7 + jitter(31) * 1.2;
  const y0 = 6 + jitter(32) * 1.2;
  const x1 = VIEW_W - 7 + jitter(33) * 1.2;
  const y1 = VIEW_H - 6 + jitter(34) * 1.2;
  const r = 12;
  return [
    `M ${f(x0 + r)} ${f(y0)}`,
    `Q ${f(VIEW_W / 2)} ${f(y0 - 1.5)} ${f(x1 - r)} ${f(y0 + 0.8)}`,
    `Q ${f(x1)} ${f(y0)} ${f(x1)} ${f(y0 + r)}`,
    `Q ${f(x1 + 1.2)} ${f(VIEW_H / 2)} ${f(x1 - 0.6)} ${f(y1 - r)}`,
    `Q ${f(x1)} ${f(y1)} ${f(x1 - r)} ${f(y1)}`,
    `Q ${f(VIEW_W / 2)} ${f(y1 + 1.4)} ${f(x0 + r)} ${f(y1 - 0.6)}`,
    `Q ${f(x0)} ${f(y1)} ${f(x0)} ${f(y1 - r)}`,
    `Q ${f(x0 - 1)} ${f(VIEW_H / 2)} ${f(x0 + 0.4)} ${f(y0 + r)}`,
    `Q ${f(x0)} ${f(y0)} ${f(x0 + r + 3)} ${f(y0 - 0.5)}`,
  ].join(" ");
}

/**
 * One bulb. Its unlit fill is always there (dim, solid); the lit layer on top
 * is a solid fill whose opacity alone is the bulb's "brightness": no glow,
 * blur or gradient. `animated`: the lit layer plays its keyframes; otherwise
 * it is simply on (the reduced-motion title card).
 */
function Bulb({ index, theme, animated }: { index: number; theme: BoardTheme; animated: boolean }) {
  const { x, y } = POINTS[index];
  const track = useMemo(() => bulbTrack(index), [index]);
  const alt = index % 2 === 1;
  const lit =
    theme === "scoreboard" ? (
      <>
        <circle cx={x} cy={y} r={7.5} fill={alt ? "var(--bulb-lit-b)" : "var(--bulb-lit-a)"} />
        <circle cx={x - 0.6} cy={y - 0.8} r={2.8} fill={alt ? "var(--bulb-core-b)" : "var(--bulb-core-a)"} />
      </>
    ) : (
      <circle cx={x} cy={y} r={8.5} fill={alt ? "var(--bulb-lit-b)" : "var(--bulb-lit-a)"} />
    );
  return (
    <g data-bulb={index}>
      {theme === "scoreboard" ? (
        <>
          <circle cx={x} cy={y} r={11.5} fill="var(--bulb-housing)" stroke="var(--bulb-housing-line)" strokeWidth={1.5} />
          <circle cx={x} cy={y} r={7.5} fill="var(--bulb-off)" />
        </>
      ) : (
        <circle cx={x} cy={y} r={8.5} fill="var(--bulb-off)" />
      )}
      {animated ? (
        <motion.g
          data-animated="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: track.values }}
          transition={{ duration: DURATION_S, times: track.times, ease: "linear" }}
        >
          {lit}
        </motion.g>
      ) : (
        <g>{lit}</g>
      )}
      {theme === "whiteboard" ? (
        <path
          d={markerCircle(x, y, 10.5, index + 1)}
          fill="none"
          stroke="var(--marquee-line)"
          strokeWidth={3}
          strokeLinecap="round"
        />
      ) : null}
    </g>
  );
}

/**
 * "BLACKOUT" on a marquee sign: a ring of bulbs that switch on in a chase
 * round the sign, alternate like a theatre marquee, flash all together three
 * times, flicker unevenly and then die one by one until the screen is dark
 * (3.5 s, lib/game/endSequence.ts holds the timeline). Opacity and transform
 * only. Dark Scoreboard: warm amber / white filament bulbs in dark housings
 * on a black panel, condensed type. Whiteboard: marker-drawn bulbs (near-black
 * outlines, red / black when lit) on a white board, marker type.
 *
 * `reduced`: a static title card instead: every bulb simply lit, no chase
 * (`data-reduced`, no `data-animated` bulbs); EndSequence fades it in and out.
 */
export function BlackoutSequence({ theme, reduced }: { theme: BoardTheme; reduced: boolean }) {
  const word = useMemo(() => wordTrack(), []);
  const animated = !reduced;
  const scoreboard = theme === "scoreboard";
  return (
    <div
      className="absolute inset-0 flex items-center justify-center overflow-hidden px-4"
      style={{ backgroundColor: "var(--marquee-bg)" }}
      data-testid="blackout-sequence"
      data-theme={theme}
      data-reduced={reduced || undefined}
    >
      <div className="relative aspect-[340/210] w-full max-w-[30rem] [container-type:inline-size]">
        <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} aria-hidden className="absolute inset-0 size-full overflow-visible">
          {scoreboard ? (
            <rect
              x={4}
              y={3}
              width={VIEW_W - 8}
              height={VIEW_H - 6}
              rx={10}
              fill="var(--marquee-panel)"
              stroke="var(--marquee-panel-line)"
              strokeWidth={2}
            />
          ) : (
            <path d={markerFrame()} fill="none" stroke="var(--marquee-line)" strokeWidth={4} strokeLinecap="round" />
          )}
          {POINTS.map((_, i) => (
            <Bulb key={i} index={i} theme={theme} animated={animated} />
          ))}
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <motion.span
            className={`block font-board leading-none ${scoreboard ? "text-[21cqi] tracking-[0.05em]" : "-rotate-2 text-[12.5cqi]"}`}
            style={{ color: "var(--marquee-word)" }}
            data-animated={animated || undefined}
            initial={animated ? { opacity: 0, scale: 0.92 } : false}
            animate={animated ? { opacity: word.values, scale: 1 } : undefined}
            transition={
              animated
                ? {
                    opacity: { duration: DURATION_S, times: word.times, ease: "linear" },
                    scale: { duration: 0.35, ease: "easeOut" },
                  }
                : undefined
            }
          >
            BLACKOUT
          </motion.span>
        </div>
      </div>
      {/* Lights out: the screen goes fully dark once the last bulb has died. */}
      {animated ? (
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ backgroundColor: "var(--end-dark)" }}
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 0, 1] }}
          transition={{ duration: DURATION_S, times: [0, DARK_FROM, 1], ease: "easeIn" }}
        />
      ) : null}
    </div>
  );
}
