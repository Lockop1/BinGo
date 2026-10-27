"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";
import { jitter } from "@/lib/game/boardText";
import { BOARD_SIZE, type Game, type Player, type Square } from "@/lib/game/types";
import { playerColor } from "@/lib/palette";
import type { BoardTheme } from "@/lib/settings/settings";

/** When the game ended: `ended_at`, or the deadline that ended it on this phone's clock first. */
function endedOn(game: Pick<Game, "ended_at" | "deadline_at">): string {
  const at = new Date(game.ended_at ?? game.deadline_at);
  if (Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(at);
}

/** A separator: a row of scoreboard lamps, or a hand-drawn marker stroke. */
function Rule({ theme }: { theme: BoardTheme }) {
  if (theme === "scoreboard") {
    return (
      <svg viewBox="0 0 200 6" aria-hidden className="h-1.5 w-40">
        <line
          x1={3}
          x2={197}
          y1={3}
          y2={3}
          stroke="var(--end-rule)"
          strokeWidth={5}
          strokeLinecap="round"
          strokeDasharray="0 11.2"
        />
      </svg>
    );
  }
  const d = `M 4 ${6 + jitter(51) * 1.5} Q 60 ${2 + jitter(52) * 1.5} 100 ${5 + jitter(53)} T 196 ${4 + jitter(54) * 1.5}`;
  return (
    <svg viewBox="0 0 200 10" aria-hidden className="h-2.5 w-40 overflow-visible">
      <path d={d} fill="none" stroke="var(--end-rule)" strokeWidth={3.5} strokeLinecap="round" opacity={0.85} />
    </svg>
  );
}

/** One block of the card, rising in after the one before it (no movement with reduced motion). */
function Line({ i, reduced, children, className = "" }: { i: number; reduced: boolean; children: ReactNode; className?: string }) {
  return (
    <motion.div
      className={`flex min-w-0 flex-col items-center ${className}`}
      initial={reduced ? false : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay: 0.1 + i * 0.14, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  );
}

/**
 * The "final credits" title card between the end of a game and its recap:
 * the game name, the date, the players in their colors and the squares
 * crossed off, like a cinema title card on a dark backdrop. Dark Scoreboard
 * sets it in condensed scoreboard type with lamp-dot rules; Whiteboard in
 * marker with hand-drawn rules. Player colors use the palette's dark-theme
 * shades (the card is dark in both themes). EndSequence moves on after a few
 * seconds; Skip goes straight to the recap.
 */
export function CreditsCard({
  theme,
  reduced,
  game,
  players,
  squares,
  onSkip,
}: {
  theme: BoardTheme;
  reduced: boolean;
  game: Pick<Game, "name" | "ended_at" | "deadline_at">;
  players: readonly Player[];
  squares: readonly Pick<Square, "completed_at">[];
  onSkip: () => void;
}) {
  const scoreboard = theme === "scoreboard";
  const done = squares.filter((s) => s.completed_at !== null).length;
  const cast = [...players].sort((a, b) => a.joined_at.localeCompare(b.joined_at));
  const label = scoreboard ? "font-board text-lg tracking-[0.3em]" : "font-board text-base tracking-wide";

  return (
    <div
      className="absolute inset-0 flex flex-col overflow-hidden"
      style={{ backgroundColor: "var(--end-dark)", color: "var(--end-ink)" }}
      data-testid="credits-card"
      data-theme={theme}
      data-reduced={reduced || undefined}
    >
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 overflow-y-auto px-6 pb-4 pt-[max(2rem,env(safe-area-inset-top))] text-center">
        <Line i={0} reduced={reduced}>
          <p className={label} style={{ color: "var(--end-accent)" }}>
            {scoreboard ? "FINAL" : "Final credits"}
          </p>
        </Line>
        <Line i={1} reduced={reduced} className="gap-1">
          <h2
            className={`max-w-full break-words font-board leading-none ${
              scoreboard ? "text-[clamp(2.75rem,15vw,5rem)] tracking-[0.03em]" : "text-[clamp(2rem,10vw,3.5rem)] leading-[1.1]"
            }`}
            data-testid="credits-name"
          >
            {game.name}
          </h2>
          <p className="font-board text-lg" style={{ color: "var(--end-muted)" }} data-testid="credits-date">
            {endedOn(game)}
          </p>
        </Line>
        <Line i={2} reduced={reduced} className="gap-3">
          <Rule theme={theme} />
          <p className={label} style={{ color: "var(--end-muted)" }}>
            {scoreboard ? "STARRING" : "Starring"}
          </p>
          <ul className="flex min-w-0 max-w-full flex-col items-center gap-0.5" data-testid="credits-players">
            {cast.map((p) => (
              <li
                key={p.id}
                className={`max-w-full truncate font-board leading-tight ${scoreboard ? "text-3xl tracking-[0.04em]" : "text-2xl"}`}
                style={{ color: playerColor(p.color, "dark").fill }}
                data-testid="credits-player"
              >
                {p.display_name}
              </li>
            ))}
          </ul>
          <Rule theme={theme} />
        </Line>
        <Line i={3} reduced={reduced} className="gap-0.5">
          <p
            className={`font-board leading-none tabular-nums ${scoreboard ? "text-6xl" : "text-5xl"}`}
            style={{ color: "var(--end-accent)" }}
            data-testid="credits-squares"
          >
            {`${done}/${BOARD_SIZE}`}
          </p>
          <p className="font-board text-lg" style={{ color: "var(--end-muted)" }}>
            {scoreboard ? "SQUARES CROSSED OFF" : "squares crossed off"}
          </p>
        </Line>
      </div>
      <div className="flex justify-end px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          onClick={onSkip}
          className={`min-h-11 min-w-11 px-4 font-board text-xl underline decoration-2 underline-offset-4 ${
            scoreboard ? "tracking-[0.12em]" : ""
          }`}
          style={{ color: "var(--end-ink)" }}
          data-testid="credits-skip"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
