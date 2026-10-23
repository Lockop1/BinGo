"use client";

import { animate, motion, useMotionValue, useReducedMotion, useTransform, type MotionValue } from "motion/react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { boardLabelSize, jitter, labelSize } from "@/lib/game/boardText";
import { BOARD_SIZE, CENTER_POSITION } from "@/lib/game/types";
import { pulse } from "@/lib/haptics";
import { CELL_RATIO, type BoardTheme, type SquareSize, type TextSize } from "@/lib/settings/settings";

/** Total run time; the last fifth is the fade that reveals the live board underneath. */
const DURATION_S = 1;
const REDUCED_DURATION_S = 0.3;
/** If animation frames stall (a backgrounded tab), the overlay still goes away. */
const SAFETY_MS = 2_000;

export type StartSquare = { position: number; label: string };

export type StartTransitionProps = {
  theme: BoardTheme;
  textSize: TextSize;
  squareSize: SquareSize;
  name: string;
  squares: readonly StartSquare[];
  freeCenter: boolean;
  onDone: () => void;
};

// Same geometry and seeds as the lobby's pencil grid (LobbyBoard), so the
// first frame looks like the paper board it replaces.
const W = 500;
const CELL = W / 5;
const WOBBLE = 3.2;

/**
 * Grid line `index` (0–5 horizontal, 6–11 vertical) in a W × H box, with the
 * pencil wobble scaled by `k` (1 = the lobby's crooked pencil line, 0 = a
 * dead-straight line on the cell boundary like the board's).
 */
function linePath(index: number, k: number, h: number): string {
  const i = index % 6;
  const a = jitter(i + 1) * WOBBLE * k;
  const b = jitter(i + 11) * WOBBLE * k;
  const c = jitter(i + 21) * WOBBLE * 0.8 * k;
  const f = (n: number) => n.toFixed(2);
  if (index < 6) {
    const at = (i * h) / 5;
    return `M ${f(-2 * k + c)} ${f(at + a)} Q ${f(W / 2 + b * 6)} ${f(at - b)} ${f(W + k - c)} ${f(at + c)}`;
  }
  const at = i * CELL;
  return `M ${f(at + b)} ${f(-k - c)} Q ${f(at - a)} ${f(h / 2 + a * 6)} ${f(at + c)} ${f(h + 2 * k + c)}`;
}

const LINES = Array.from({ length: 12 }, (_, i) => i);

/** Whiteboard: one line, drawn twice (pencil and marker) on shared, interpolated geometry. */
function MorphLine({
  index,
  h,
  t,
  layer,
}: {
  index: number;
  h: number;
  t: MotionValue<number>;
  layer: "pencil" | "marker";
}) {
  const d = useTransform(t, (v) => linePath(index, 1 - v, h));
  // Thin pencil (2px) thickens into the marker line (--board-line-width, 3.5px).
  const width = useTransform(t, [0, 1], [2, 3.5]);
  // Cross-dissolve: the grey pencil stroke hands over to the marker ink.
  const opacity = useTransform(t, [0, 1], layer === "pencil" ? [0.9, 0] : [0, 1]);
  return (
    <motion.path
      d={d}
      fill="none"
      stroke={layer === "pencil" ? "var(--ink)" : "var(--board-line)"}
      strokeLinecap="round"
      vectorEffect="non-scaling-stroke"
      style={{ strokeWidth: width, opacity }}
    />
  );
}

/** Scoreboard: when the sweep reaches a line, its pencil stroke goes out and its lamps come on. */
const SWEEP_STEP = 0.055;
const SWEEP_SNAP = 0.08;
function sweepStart(index: number): number {
  // Rows top to bottom, then columns left to right.
  return index < 6 ? 0.06 + index * SWEEP_STEP : 0.39 + (index - 6) * SWEEP_STEP;
}

function PencilLine({ index, h, progress, sweep }: { index: number; h: number; progress: MotionValue<number>; sweep: boolean }) {
  const s = sweepStart(index);
  const opacity = useTransform(progress, [s, s + SWEEP_SNAP], sweep ? [0.9, 0] : [0.9, 0.9]);
  return (
    <motion.path
      d={linePath(index, 1, h)}
      fill="none"
      stroke="var(--ink)"
      strokeWidth={2}
      strokeLinecap="round"
      vectorEffect="non-scaling-stroke"
      style={{ opacity }}
    />
  );
}

function LampLine({ index, progress }: { index: number; progress: MotionValue<number> }) {
  const s = sweepStart(index);
  const opacity = useTransform(progress, [s, s + SWEEP_SNAP], [0, 1]);
  const i = index % 6;
  const at = `${i * 20}%`;
  return index < 6 ? (
    <motion.line x1="0%" x2="100%" y1={at} y2={at} style={{ opacity }} />
  ) : (
    <motion.line x1={at} x2={at} y1="0%" y2="100%" style={{ opacity }} />
  );
}

/**
 * The ~1 s "game on" moment between the paper lobby and the live board, on
 * every phone as the start arrives (GameScreen plays it on a live
 * lobby → active flip only). It draws the board twice over the live board,
 * which is already mounted underneath:
 *
 * - Whiteboard: the lobby's thin, wobbly pencil grid straightens and
 *   thickens into marker lines while the paper whitens and the handwritten
 *   labels cross-fade into marker type.
 * - Dark Scoreboard: a sweep across the rows, then the columns, turns each
 *   grey pencil stroke into a row of amber lamps while the paper darkens to
 *   near-black and the labels snap to condensed type.
 *
 * Then it fades out. Reduced motion: a 300 ms cross-fade from the paper grid
 * to the board, nothing moves. Nothing is stored, so a reload mid-way simply
 * lands on the board.
 */
export function StartTransition({ theme, textSize, squareSize, name, squares, freeCenter, onDone }: StartTransitionProps) {
  const reduce = useReducedMotion() ?? false;
  const progress = useMotionValue(0);
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  }, [onDone]);

  // Decided once: switching reduced motion mid-way must not restart it.
  const [reduced] = useState(reduce);
  useEffect(() => {
    pulse();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      doneRef.current();
    };
    const controls = animate(progress, 1, {
      duration: reduced ? REDUCED_DURATION_S : DURATION_S,
      ease: "linear",
      onComplete: finish,
    });
    const safety = window.setTimeout(finish, (reduced ? REDUCED_DURATION_S : DURATION_S) * 1000 + SAFETY_MS);
    return () => {
      controls.stop();
      window.clearTimeout(safety);
    };
  }, [progress, reduced]);

  const scoreboard = theme === "scoreboard";
  const motionful = !reduced;
  const h = W * CELL_RATIO[squareSize];

  // Shared timelines (progress 0 → 1).
  const overlayOpacity = useTransform(progress, reduced ? [0, 1] : [0.8, 1], [1, 0]);
  const paperOpacity = useTransform(progress, scoreboard ? [0, 0.7] : [0.1, 0.6], motionful ? [1, 0] : [1, 1]);
  const pencilText = useTransform(progress, scoreboard ? [0.45, 0.5] : [0.2, 0.65], motionful ? [1, 0] : [1, 1]);
  const boardText = useTransform(progress, scoreboard ? [0.45, 0.5] : [0.2, 0.65], motionful ? [0, 1] : [0, 0]);
  // Whiteboard geometry: pencil → marker over the first 70%.
  const morph = useTransform(progress, [0, 0.7], motionful ? [0, 1] : [0, 0], { clamp: true });

  const labels = new Map(squares.map((s) => [s.position, s.label.trim()]));

  return (
    <motion.div
      className="start-transition board-tokens fixed inset-0 z-[80] overflow-hidden"
      data-testid="start-transition"
      data-theme={theme}
      data-text-size={textSize}
      data-square-size={squareSize}
      data-variant={reduced ? "fade" : theme}
      style={{ opacity: overlayOpacity, backgroundColor: "var(--board-bg)" }}
    >
      <p className="sr-only" role="status">
        The game has started.
      </p>
      <motion.div aria-hidden className="paper absolute inset-0" style={{ opacity: paperOpacity }} />

      <div aria-hidden className="relative flex min-w-0 flex-col">
        {/* Same frame as BoardScreen's top bar and grid, so the reveal lines up. */}
        <div className="relative flex min-h-11 min-w-0 items-center pb-0.5 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.25rem,env(safe-area-inset-right))] pt-[max(0.25rem,env(safe-area-inset-top))]">
          <motion.span className="min-w-0 truncate font-pencil text-xl leading-tight text-ink" style={{ opacity: pencilText }}>
            {name}
          </motion.span>
          <motion.span
            className="absolute inset-x-0 min-w-0 truncate pl-[max(0.75rem,env(safe-area-inset-left))] font-board text-xl leading-tight text-board-ink"
            style={{ opacity: boardText }}
          >
            {name}
          </motion.span>
        </div>

        <div className="flex min-w-0 flex-col items-center pl-[max(0.375rem,env(safe-area-inset-left))] pr-[max(0.375rem,env(safe-area-inset-right))] pt-2">
          <div className="w-full min-w-0" style={{ maxWidth: "min(36rem, max(18rem, calc(100dvh - 5.5rem)))" }}>
            <div className="board-frame">
              <div className="board-grid">
                {Array.from({ length: BOARD_SIZE }, (_, position) => {
                  const free = freeCenter && position === CENTER_POSITION;
                  const label = free ? "FREE" : (labels.get(position) ?? "");
                  return (
                    <div key={position} className="start-cell">
                      {label ? (
                        <>
                          <motion.span
                            className="absolute inset-0 flex items-center justify-center p-1 text-center font-pencil text-ink"
                            style={{ opacity: pencilText, rotate: Number((jitter(position + 40) * 0.6).toFixed(2)) }}
                          >
                            {free ? (
                              <span className="text-xl leading-6 tracking-wider">FREE</span>
                            ) : (
                              <span className="square-label" data-size={labelSize(label)}>
                                {label}
                              </span>
                            )}
                          </motion.span>
                          <motion.span
                            className="absolute inset-0 flex items-center justify-center px-[5cqi] py-[7cqi] font-board"
                            style={{ opacity: boardText }}
                          >
                            <span
                              className="board-label"
                              data-size={free ? "xl" : boardLabelSize(label)}
                              style={free ? ({ color: "var(--board-muted)", letterSpacing: "0.04em" } as CSSProperties) : undefined}
                            >
                              {label}
                            </span>
                          </motion.span>
                        </>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              {/* Pencil layer (both variants), in the lobby's 500-wide box. */}
              <svg className="board-lines" viewBox={`0 0 ${W} ${h}`} preserveAspectRatio="none">
                {scoreboard || !motionful
                  ? LINES.map((i) => <PencilLine key={i} index={i} h={h} progress={progress} sweep={motionful} />)
                  : LINES.map((i) => <MorphLine key={i} index={i} h={h} t={morph} layer="pencil" />)}
              </svg>
              {/* Marker layer, or the scoreboard's lamps (styled like the board's own lines). */}
              {!motionful ? null : scoreboard ? (
                <svg className="board-lines">
                  {LINES.map((i) => (
                    <LampLine key={i} index={i} progress={progress} />
                  ))}
                </svg>
              ) : (
                <svg className="board-lines" viewBox={`0 0 ${W} ${h}`} preserveAspectRatio="none">
                  {LINES.map((i) => (
                    <MorphLine key={i} index={i} h={h} t={morph} layer="marker" />
                  ))}
                </svg>
              )}
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
