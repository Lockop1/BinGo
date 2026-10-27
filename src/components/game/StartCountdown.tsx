"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { countdownSecondsLeft } from "@/lib/game/types";
import { serverNow } from "@/lib/game/serverClock";
import { pulse } from "@/lib/haptics";

/**
 * Hand-drawn digits 1–5 in a 100 × 140 box: single pencil strokes, drawn in
 * the order a hand would write them.
 */
const DIGITS: Record<number, string[]> = {
  1: ["M 33 41 C 42 35 50 27 56 15 C 55 50 56 88 55 124", "M 35 125 Q 55 121.5 76 124"],
  2: ["M 23 47 C 24 22 47 11 64 17 C 84 25 83 50 68 66 C 54 81 36 99 21 124 C 43 120.5 63 120 83 123"],
  3: ["M 24 31 C 40 12 73 11 76 35 C 78 55 59 63 43 66 C 64 64 84 77 80 100 C 76 126 41 133 21 112"],
  4: ["M 61 15 C 48 43 34 66 19 91 C 43 89 66 88 87 90", "M 65 50 C 63.5 75 64.5 101 63 127"],
  5: ["M 36 19 C 33 37 31 49 28 63 C 45 51 71 53 78 77 C 85 104 60 129 35 122 C 28 120 23 116 20 110", "M 35 18.5 C 49 17 62 18.5 76 17"],
};

/** The whole draw-in of one digit (its strokes one after the other). */
const DRAW_S = 0.4;

function Stroke({
  d,
  width,
  opacity,
  delay,
  duration,
  reduce,
  shift = false,
}: {
  d: string;
  width: number;
  opacity: number;
  delay: number;
  duration: number;
  reduce: boolean;
  shift?: boolean;
}) {
  return (
    <motion.path
      d={d}
      fill="none"
      stroke="var(--ink)"
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      transform={shift ? "translate(1.6 1.1)" : undefined}
      // Hidden until its turn: a zero-length round-capped stroke would show as a dot.
      initial={reduce ? false : { pathLength: 0, opacity: 0 }}
      animate={{ pathLength: 1, opacity }}
      transition={{
        pathLength: { duration, delay, ease: "easeInOut" },
        opacity: { duration: 0.01, delay },
      }}
    />
  );
}

function Digit({ n, reduce }: { n: number; reduce: boolean }) {
  const strokes = DIGITS[n] ?? [];
  const total = strokes.length;
  return (
    <motion.svg
      viewBox="0 0 100 140"
      aria-hidden
      className="absolute inset-0 size-full overflow-visible"
      data-digit-svg={n}
      // The previous digit lifts off as the next one is drawn.
      initial={reduce ? { opacity: 0 } : { opacity: 1, scale: 1 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={reduce ? { opacity: 0, transition: { duration: 0.2 } } : { opacity: 0, scale: 1.08, transition: { duration: 0.18 } }}
      transition={{ duration: reduce ? 0.2 : 0 }}
    >
      {strokes.map((d, i) => {
        const delay = (i * DRAW_S) / total;
        const duration = DRAW_S / total;
        return (
          <g key={i}>
            {/* Graphite: a firm stroke, then a lighter second pass just off it. */}
            <Stroke d={d} width={7} opacity={0.88} delay={delay} duration={duration} reduce={reduce} />
            <Stroke d={d} width={2.4} opacity={0.45} delay={delay + 0.05} duration={duration} reduce={reduce} shift />
          </g>
        );
      })}
    </motion.svg>
  );
}

/**
 * The shared start countdown, sketched in pencil over the dimmed paper lobby:
 * 5, 4, 3, 2, 1, each digit drawn in (~400 ms) as its second begins. The
 * number is the whole seconds left until the server's `countdown_ends_at` on
 * the skew-corrected clock (`serverNow`), so two phones show the same digit at
 * the same moment, and a phone that opens mid-countdown picks up where it is.
 * Each tick buzzes (`pulse`, where the phone supports it). At zero GameScreen
 * swaps in the board and the start transition (this never shows "0").
 *
 * Reduced motion: the digits simply fade in and out.
 */
export function StartCountdown({ name, endsAt }: { name: string; endsAt: string }) {
  const reduce = useReducedMotion() ?? false;
  const [, setTick] = useState(0);
  const left = Math.max(1, countdownSecondsLeft({ countdown_ends_at: endsAt }, serverNow()));

  // Wake just after the next whole-second boundary (re-armed after every render).
  useEffect(() => {
    const remaining = Date.parse(endsAt) - serverNow();
    if (!(remaining > 0)) return;
    const timer = window.setTimeout(() => setTick((t) => t + 1), (remaining % 1000 || 1000) + 15);
    return () => window.clearTimeout(timer);
  });

  // One buzz per digit (the first one included).
  const buzzed = useRef<number | null>(null);
  useEffect(() => {
    if (buzzed.current === left) return;
    buzzed.current = left;
    pulse();
  }, [left]);

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-[70] flex flex-col items-center justify-center px-4 pb-[12vh]"
      data-testid="start-countdown-overlay"
    >
      <p className="sr-only">{name} is starting.</p>
      <p aria-hidden className="lobby-title text-[34px]! leading-[44px]!">
        Starting in
      </p>
      <div
        role="timer"
        aria-label={`Starting in ${left}`}
        className="relative mt-2 aspect-[100/140] w-[min(56vw,15rem)]"
        data-testid="start-countdown"
        data-digit={left}
        data-seconds={left}
        data-reduced={reduce || undefined}
      >
        {/* The only text in here: e2e reads the number from it. */}
        <span className="sr-only">{left}</span>
        <AnimatePresence initial>
          <Digit key={left} n={left} reduce={reduce} />
        </AnimatePresence>
      </div>
    </div>
  );
}
