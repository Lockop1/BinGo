"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { splitLead, type Toast } from "@/lib/game/toasts";
import { playerColor, type PaletteTheme } from "@/lib/palette";

/**
 * The toast lives in the top bar's centre slot: while one is showing it covers
 * the game name (same box, absolutely positioned, so nothing shifts), and the
 * players / settings / album buttons beside it stay visible and tappable.
 * Nothing ever sits over the grid. Tapping it opens that square's sheet.
 * Drops in a few pixels; fades only with reduced motion.
 *
 * Render inside a `relative` box the size of the slot (see TopBar).
 */
export function Toasts({
  toast,
  theme,
  names,
  onTap,
}: {
  toast: Toast | null;
  theme: PaletteTheme;
  /** Display names in the game: the one a toast starts with is capped so the square stays readable. */
  names: readonly string[];
  onTap: (toast: Toast) => void;
}) {
  const reduce = useReducedMotion();
  const split = toast ? splitLead(toast.text, names) : null;
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center" aria-live="polite" role="status">
      <AnimatePresence mode="wait" initial={false}>
        {toast ? (
          <motion.button
            key={toast.id}
            type="button"
            onClick={() => onTap(toast)}
            data-testid="toast"
            data-tone={toast.tone}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
            transition={{ duration: reduce ? 0.12 : 0.2, ease: "easeOut" }}
            className={`pointer-events-auto flex h-11 w-full min-w-0 items-center gap-1.5 rounded-[10px_6px_9px_7px] border-2 px-2 text-left font-board text-sm leading-[1.1] ${
              toast.tone === "error"
                ? "border-board-danger bg-board-bg text-board-danger"
                : "border-board-line bg-board-bg text-board-ink"
            }`}
          >
            {toast.color !== null ? (
              <span
                aria-hidden
                className="inline-block size-3 shrink-0 rounded-full"
                style={{ backgroundColor: playerColor(toast.color, theme).fill }}
              />
            ) : null}
            {/* Up to two lines; a long name is cut with an ellipsis on its own so the square still shows. */}
            <span className="line-clamp-2 min-w-0 flex-1 break-words" data-testid="toast-text">
              {split ? (
                <>
                  <span className="inline-block max-w-[min(14ch,40%)] truncate align-bottom" data-testid="toast-lead">
                    {split.lead}
                  </span>
                  {split.rest}
                </>
              ) : (
                toast.text
              )}
            </span>
          </motion.button>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
