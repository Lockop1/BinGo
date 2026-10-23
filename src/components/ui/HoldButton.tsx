"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { PencilButton, pencilButtonClass } from "@/components/ui/PencilButton";

const MOVE_TOLERANCE_PX = 12;

type Props = {
  onConfirm: () => void;
  /** Label for the hold action ("Hold to complete"). */
  children: ReactNode;
  /** Label when there is no hold (reduced motion): tap, then confirm. */
  tapLabel?: ReactNode;
  /** How long to hold, in ms. */
  holdMs?: number;
  holdingLabel?: ReactNode;
  confirmLabel?: ReactNode;
  disabled?: boolean;
  testId?: string;
  className?: string;
};

/**
 * A deliberate press: hold for ~600 ms (a fill shows the progress) and it
 * fires. Moving the finger, leaving the button or lifting early cancels.
 * Works with mouse, touch and pen (pointer events).
 *
 * Fallback for keyboard users, reduced motion and anyone who just taps: a
 * tap arms it and shows "Confirm" (`data-testid="complete-confirm"`); a
 * second, explicit tap fires. With reduced motion there is no hold at all.
 */
export function HoldButton({
  onConfirm,
  children,
  tapLabel = "Complete",
  holdMs = 600,
  holdingLabel = "Keep holding…",
  confirmLabel = "Confirm",
  disabled = false,
  testId = "complete-hold",
  className = "",
}: Props) {
  const reduce = useReducedMotion();
  const hintId = useId();
  const [phase, setPhase] = useState<"idle" | "holding" | "armed">("idle");
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const stopTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => stopTimer, []);

  useEffect(() => {
    if (phase === "armed") confirmRef.current?.focus({ preventScroll: true });
  }, [phase]);

  const cancelHold = () => {
    stopTimer();
    origin.current = null;
    setPhase((p) => (p === "holding" ? "idle" : p));
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    // A long press that ended without a click must not swallow this tap's click.
    fired.current = false;
    if (disabled || reduce || event.button !== 0) return;
    origin.current = { x: event.clientX, y: event.clientY };
    setPhase("holding");
    stopTimer();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      origin.current = null;
      fired.current = true;
      setPhase("idle");
      onConfirm();
    }, holdMs);
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const start = origin.current;
    if (!start) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_TOLERANCE_PX) cancelHold();
  };

  const onClick = () => {
    // The click that ends a successful hold is not a second request.
    if (fired.current) {
      fired.current = false;
      return;
    }
    if (!disabled) setPhase("armed");
  };

  if (phase === "armed") {
    return (
      <div className="flex min-w-0 flex-col gap-2" data-testid={`${testId}-armed`}>
        <div className="flex min-w-0 items-center gap-3">
          <PencilButton
            ref={confirmRef}
            onClick={() => {
              setPhase("idle");
              onConfirm();
            }}
            className={`flex-1 text-2xl ${className}`}
            data-testid="complete-confirm"
          >
            {confirmLabel}
          </PencilButton>
          <PencilButton variant="quiet" onClick={() => setPhase("idle")} data-testid="complete-cancel">
            Cancel
          </PencilButton>
        </div>
      </div>
    );
  }

  const holding = phase === "holding";
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <button
        type="button"
        disabled={disabled}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={cancelHold}
        onPointerLeave={cancelHold}
        onPointerCancel={cancelHold}
        onClick={onClick}
        onContextMenu={(event) => event.preventDefault()}
        aria-describedby={hintId}
        data-testid={testId}
        data-holding={holding || undefined}
        className={pencilButtonClass(
          "primary",
          `relative w-full touch-manipulation overflow-hidden text-2xl [-webkit-touch-callout:none] ${className}`,
        )}
      >
        <span
          aria-hidden
          className="absolute inset-0 origin-left bg-ink/25"
          style={{
            transform: holding ? "scaleX(1)" : "scaleX(0)",
            transition: holding ? `transform ${holdMs}ms linear` : "transform 160ms ease-out",
          }}
        />
        <span className="relative">{holding ? holdingLabel : reduce ? tapLabel : children}</span>
      </button>
      <span id={hintId} className="text-base leading-[22px] text-ink-soft">
        {reduce ? "Tap, then confirm." : "Press and hold, or tap then confirm."}
      </span>
    </div>
  );
}
