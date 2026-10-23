"use client";

import { AnimatePresence, motion, useDragControls, useReducedMotion, type PanInfo } from "motion/react";
import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

type SheetProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** Element to focus when the sheet opens (defaults to the first focusable one). */
  initialFocus?: RefObject<HTMLElement | null>;
  testId?: string;
};

/**
 * Bottom sheet on paper: slides up (fades only with reduced motion), traps
 * focus, closes on Escape, on the backdrop and by dragging the handle down.
 * Focus returns to whatever was focused before it opened.
 */
export function Sheet({ open, onClose, title, children, initialFocus, testId }: SheetProps) {
  // Portals need document; the sheet only ever opens after a tap, so there is
  // nothing to render on the server.
  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence>
      {open ? (
        <SheetPanel key="sheet" onClose={onClose} title={title} initialFocus={initialFocus} testId={testId}>
          {children}
        </SheetPanel>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

function SheetPanel({ onClose, title, children, initialFocus, testId }: Omit<SheetProps, "open">) {
  const reduce = useReducedMotion();
  const drag = useDragControls();
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Focus in, lock page scroll, Escape / Tab trap; restore on close.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = panel.current;
    const target = initialFocus?.current ?? node?.querySelector<HTMLElement>(FOCUSABLE) ?? node;
    target?.focus({ preventScroll: true });

    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (items.length === 0) {
        event.preventDefault();
        node.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !node.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !node.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = overflow;
      previous?.focus({ preventScroll: true });
    };
    // initialFocus is read once on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.y > 90 || info.velocity.y > 600) onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <motion.div
        aria-hidden
        className="absolute inset-0 bg-ink/35"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: reduce ? 0 : 0.18 }}
        onClick={onClose}
      />
      <motion.div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={testId}
        className="paper sheet-edge relative mx-auto flex max-h-[88dvh] w-full min-w-0 max-w-xl flex-col overflow-y-auto overflow-x-hidden pb-[max(1.25rem,env(safe-area-inset-bottom))] pl-[calc(var(--margin-x)+12px)] pr-4 outline-none"
        initial={reduce ? { opacity: 0 } : { y: "100%" }}
        animate={reduce ? { opacity: 1 } : { y: 0 }}
        exit={reduce ? { opacity: 0 } : { y: "100%" }}
        transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 38 }}
        drag={reduce ? false : "y"}
        dragControls={drag}
        dragListener={false}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.7 }}
        onDragEnd={onDragEnd}
      >
        <div
          className="-ml-[calc(var(--margin-x)+12px)] -mr-4 flex h-7 shrink-0 cursor-grab touch-none items-center justify-center"
          onPointerDown={(event) => drag.start(event)}
          aria-hidden
        >
          <span className="h-1.5 w-12 rounded-[3px_5px_4px_6px] bg-ink-faint" />
        </div>
        <div className="flex min-h-11 items-center justify-between gap-2">
          <h2 id={titleId} className="min-w-0 text-2xl leading-7 break-words">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            data-testid="sheet-close"
            className="-mr-2 inline-flex size-11 shrink-0 items-center justify-center text-ink-soft focus-visible:outline-2 focus-visible:outline-ink"
          >
            <X aria-hidden className="size-6" strokeWidth={2.25} />
          </button>
        </div>
        {children}
      </motion.div>
    </div>
  );
}
