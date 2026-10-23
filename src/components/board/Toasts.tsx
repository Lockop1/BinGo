"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { Toast } from "@/lib/game/toasts";
import { playerColor, type PaletteTheme } from "@/lib/palette";

/**
 * One small banner at the very top (over the slim top bar, never over the
 * grid). Tapping it opens that square's sheet. Slides down; fades only with
 * reduced motion.
 */
export function Toasts({
  toast,
  theme,
  onTap,
}: {
  toast: Toast | null;
  theme: PaletteTheme;
  onTap: (toast: Toast) => void;
}) {
  const reduce = useReducedMotion();
  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[55] flex justify-center px-2 pt-[max(0.25rem,env(safe-area-inset-top))]"
      aria-live="polite"
      role="status"
    >
      <AnimatePresence mode="wait" initial={false}>
        {toast ? (
          <motion.button
            key={toast.id}
            type="button"
            onClick={() => onTap(toast)}
            data-testid="toast"
            data-tone={toast.tone}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -24 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -16 }}
            transition={{ duration: reduce ? 0.12 : 0.2, ease: "easeOut" }}
            className={`pointer-events-auto flex min-h-11 w-full min-w-0 max-w-md items-center gap-2 rounded-[10px_6px_9px_7px] border-2 px-3 py-1.5 text-left font-board text-lg leading-tight shadow-[0_2px_0_var(--board-line)] ${
              toast.tone === "error"
                ? "border-board-danger bg-board-bg text-board-danger"
                : "border-board-line bg-board-bg text-board-ink"
            }`}
          >
            {toast.color !== null ? (
              <span
                aria-hidden
                className="inline-block size-3.5 shrink-0 rounded-full"
                style={{ backgroundColor: playerColor(toast.color, theme).fill }}
              />
            ) : null}
            <span className="min-w-0 flex-1 truncate">{toast.text}</span>
          </motion.button>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
