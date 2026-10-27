"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { lineName } from "@/lib/game/bingo";
import { jitter } from "@/lib/game/boardText";
import type { ActiveCelebration } from "@/lib/game/celebrations";
import { playerColor, type PaletteTheme } from "@/lib/palette";

function subtitle(celebration: ActiveCelebration): string {
  if (celebration.blackout) return "Every square crossed off.";
  const names = celebration.lines.map(lineName);
  return names.length > 1 ? `${names.length} lines: ${names.join(" + ")}` : (names[0] ?? "");
}

/** Two quick marker underlines under the word (fixed shape, no gradients or glow). */
function Strokes({ color, reduce }: { color: string; reduce: boolean }) {
  const paths = [
    `M 6 ${30 + jitter(1) * 3} Q 150 ${18 + jitter(2) * 4} 294 ${26 + jitter(3) * 3}`,
    `M 40 ${44 + jitter(4) * 3} Q 160 ${36 + jitter(5) * 4} 262 ${42 + jitter(6) * 3}`,
  ];
  return (
    <svg viewBox="0 0 300 56" className="h-auto w-[min(78vw,26rem)] overflow-visible" aria-hidden>
      {paths.map((d, i) => (
        <motion.path
          key={i}
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={i === 0 ? 9 : 6}
          strokeLinecap="round"
          initial={reduce ? { opacity: 0 } : { pathLength: 0 }}
          animate={reduce ? { opacity: 1 } : { pathLength: 1 }}
          transition={reduce ? { duration: 0.15 } : { duration: 0.32, delay: 0.12 + i * 0.16, ease: "easeOut" }}
        />
      ))}
    </svg>
  );
}

/**
 * Bingo / blackout celebration. Phases come from the celebration queue:
 * `highlight` (the grid pulses the line; this layer only announces it) and
 * `overlay` (full-screen "BINGO!", tap to skip). A blackout ends the game on
 * the server, so the board (and this overlay) soon give way to the recap.
 * `skipBlackoutOverlay`: the game screen's end sequence gives the blackout its
 * own moment (components/game/BlackoutSequence.tsx), so this layer draws no
 * "BLACKOUT!" overlay of its own (the grid's highlight still pulses).
 */
export function Celebration({
  celebration: showing,
  theme,
  onDismiss,
  skipBlackoutOverlay = false,
}: {
  celebration: ActiveCelebration | null;
  theme: PaletteTheme;
  onDismiss: () => void;
  skipBlackoutOverlay?: boolean;
}) {
  const reduce = useReducedMotion() ?? false;
  const color = showing?.color != null ? playerColor(showing.color, theme).fill : "var(--board-ink)";
  const word = showing?.blackout ? "BLACKOUT!" : "BINGO!";
  const overlay = showing !== null && !(showing.blackout && skipBlackoutOverlay);

  return (
    <AnimatePresence>
      {showing ? (
        <div
          key={showing.id}
          className="pointer-events-none fixed inset-0 z-[60]"
          data-testid="celebration"
          data-phase={showing.phase}
          data-kind={showing.blackout ? "blackout" : "bingo"}
          data-overlay={overlay ? undefined : "skipped"}
        >
          {overlay ? (
            <p className="sr-only" role="status" aria-live="assertive">
              {word} {subtitle(showing)}
            </p>
          ) : null}
          <AnimatePresence>
            {overlay && showing.phase === "overlay" ? (
              <motion.button
                key="overlay"
                type="button"
                onClick={onDismiss}
                aria-label={`${word} Tap to continue`}
                data-testid="celebration-overlay"
                className="pointer-events-auto absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-board-ink"
                style={{ backgroundColor: "color-mix(in srgb, var(--board-bg) 90%, transparent)" }}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduce ? 0.12 : 0.18 }}
              >
                <motion.span
                  className={`font-board leading-none tracking-wide ${
                    showing.blackout ? "text-[clamp(3.25rem,17vw,8rem)]" : "text-[clamp(4.5rem,24vw,10rem)]"
                  }`}
                  initial={reduce ? { opacity: 0 } : { scale: 0.6, rotate: -6, opacity: 0 }}
                  animate={reduce ? { opacity: 1 } : { scale: 1, rotate: -3, opacity: 1 }}
                  transition={reduce ? { duration: 0.12 } : { type: "spring", stiffness: 420, damping: 16 }}
                >
                  {word}
                </motion.span>
                <Strokes color={color} reduce={reduce} />
                <span className="font-board text-xl text-board-muted">{subtitle(showing)}</span>
              </motion.button>
            ) : null}
          </AnimatePresence>
        </div>
      ) : null}
    </AnimatePresence>
  );
}
