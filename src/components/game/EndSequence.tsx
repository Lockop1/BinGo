"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { BlackoutSequence } from "@/components/game/BlackoutSequence";
import { CreditsCard } from "@/components/game/CreditsCard";
import { BUZZER_MS, endSeenKey, endSteps, endVariant, type EndPhase } from "@/lib/game/endSequence";
import type { EndReason, Game, Player, Square } from "@/lib/game/types";
import { doublePulse } from "@/lib/haptics";
import type { BoardTheme } from "@/lib/settings/settings";
import { readLocal, writeLocal } from "@/lib/storage/local";

/** This phone already played the end sequence for this game (`bingo.endSeen.<gameId>`). */
export function endSequenceSeen(gameId: string): boolean {
  return readLocal(endSeenKey(gameId)) !== null;
}

/** The final buzzer: a hard cut to dark, a thick bar that snaps on and fades. */
function Buzzer({ theme, reason }: { theme: BoardTheme; reason: EndReason | null }) {
  const scoreboard = theme === "scoreboard";
  const word = reason === "host" ? "Game over" : "Time's up";
  const duration = BUZZER_MS / 1000;
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-6 overflow-hidden"
      style={{ backgroundColor: "var(--end-dark)" }}
      data-testid="end-buzzer"
    >
      <motion.div
        aria-hidden
        className="w-full"
        initial={{ opacity: 0, scaleY: 0.3 }}
        animate={{ opacity: [0, 1, 1, 0], scaleY: [0.3, 1.18, 1, 1] }}
        transition={{ duration, times: [0, 0.05, 0.4, 1], ease: "linear" }}
      >
        {scoreboard ? (
          <div className="h-7 w-full" style={{ backgroundColor: "var(--buzzer-bar)" }} />
        ) : (
          <svg viewBox="0 0 400 40" preserveAspectRatio="none" className="h-9 w-full">
            <path
              d="M -6 21 Q 120 15 210 20 T 406 18"
              fill="none"
              stroke="var(--buzzer-bar)"
              strokeWidth={26}
              strokeLinecap="round"
            />
          </svg>
        )}
      </motion.div>
      <motion.p
        className={`font-board leading-none ${scoreboard ? "text-5xl uppercase tracking-[0.12em]" : "text-4xl"}`}
        style={{ color: "var(--end-ink)" }}
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 1, 1, 0] }}
        transition={{ duration, times: [0, 0.06, 0.6, 1], ease: "linear" }}
      >
        {word}
      </motion.p>
    </div>
  );
}

const ANNOUNCE: Record<EndPhase, string> = {
  blackout: "Blackout! Every square crossed off.",
  dark: "The game is over.",
  buzzer: "The game is over.",
  credits: "Final credits.",
};

/**
 * The end of a live game on this phone (GameScreen mounts it over the freshly
 * mounted recap on a live active → ended flip only): a blackout gets the
 * marquee, then a dark beat; a host or deadline end gets the final buzzer
 * (with a double buzz); both then show the credits card, which moves on by
 * itself after a few seconds or straight away on Skip, revealing the recap.
 * The phase list and timings live in lib/game/endSequence.ts.
 *
 * Plays once per phone: it marks `bingo.endSeen.<gameId>` as it starts, so a
 * remount never plays it again; a reload mid-way lands on the recap (the
 * reloaded screen never sees the game live). Reduced motion: a plain fade, the
 * static "BLACKOUT" title card (blackout only) and the static credits card.
 * Purely visual: it only reads the game.
 */
export function EndSequence({
  gameId,
  reason,
  theme,
  game,
  players,
  squares,
  onDone,
}: {
  gameId: string;
  reason: EndReason | null;
  theme: BoardTheme;
  game: Pick<Game, "name" | "ended_at" | "deadline_at">;
  players: readonly Player[];
  squares: readonly Pick<Square, "completed_at">[];
  onDone: () => void;
}) {
  const reduce = useReducedMotion() ?? false;
  // Decided once: a settings or preference change mid-way must not restart it.
  const [{ variant, reduced, steps }] = useState(() => {
    const v = endVariant(reason);
    return { variant: v, reduced: reduce, steps: endSteps(v, reduce) };
  });
  const [index, setIndex] = useState(0);
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    writeLocal(endSeenKey(gameId), variant);
    doublePulse();
  }, [gameId, variant]);

  const over = index >= steps.length;
  useEffect(() => {
    if (over) {
      // Let the overlay fade off the recap first (it no longer takes taps).
      const timer = window.setTimeout(() => doneRef.current(), (reduced ? 0.3 : 0.25) * 1000);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => setIndex((i) => i + 1), steps[index].ms);
    return () => window.clearTimeout(timer);
  }, [index, over, steps, reduced]);

  const phase: EndPhase | null = over ? null : steps[index].phase;
  const fade = { duration: reduced ? 0.3 : 0.25 };

  return (
    <motion.div
      className={`end-sequence board-tokens fixed inset-0 z-[90] overflow-hidden ${over ? "pointer-events-none" : ""}`}
      style={{ backgroundColor: "var(--end-dark)" }}
      data-testid="end-sequence"
      data-theme={theme}
      data-variant={variant}
      data-phase={phase ?? "done"}
      data-reduced={reduced || undefined}
      // A blackout fades up from the board; the buzzer is a hard cut.
      initial={{ opacity: variant === "buzzer" && !reduced ? 1 : 0 }}
      animate={{ opacity: over ? 0 : 1 }}
      transition={over ? fade : { duration: reduced ? 0.3 : 0.15 }}
    >
      <p className="sr-only" role="status" aria-live="polite">
        {phase ? ANNOUNCE[phase] : ""}
      </p>
      <AnimatePresence>
        {phase ? (
          <motion.div
            key={phase}
            className="absolute inset-0"
            initial={{ opacity: phase === "buzzer" ? 1 : 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={fade}
          >
            {phase === "blackout" ? (
              <BlackoutSequence theme={theme} reduced={reduced} />
            ) : phase === "buzzer" ? (
              <Buzzer theme={theme} reason={reason} />
            ) : phase === "credits" ? (
              <CreditsCard
                theme={theme}
                reduced={reduced}
                game={game}
                players={players}
                squares={squares}
                onSkip={() => setIndex(steps.length)}
              />
            ) : (
              <div className="absolute inset-0" style={{ backgroundColor: "var(--end-dark)" }} data-testid="end-dark" />
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}
