"use client";

import { useState } from "react";
import { BoardSwatch } from "@/components/board/BoardSwatch";
import { PencilButton } from "@/components/ui/PencilButton";
import { useCountdown } from "@/lib/deadline/useNow";
import type { DisplaySquare } from "@/lib/game/boardState";
import { MAX_PLAYERS, type Game, type Player } from "@/lib/game/types";
import type { PaletteTheme } from "@/lib/palette";

/**
 * The board sheets' deadline line: "Ends tonight 3:00 AM (4h 12m)", in the
 * phone's time zone, live (re-rendered when the countdown label changes).
 * Null until mounted, without a deadline, and once it has passed.
 */
export function useDeadlineLine(deadlineAt: string | null): string | null {
  const { countdown, describe } = useCountdown(deadlineAt);
  if (!countdown || !describe || countdown.tier === "passed") return null;
  // "Ends tonight 3:00 AM", like the lobby's summary line.
  const when = describe.replace(/^(Tonight|Today|Tomorrow)\b/, (word) => word.toLowerCase());
  return `Ends ${when} (${countdown.label})`;
}

function Tag({ children }: { children: string }) {
  return <span className="pencil-border-alt shrink-0 px-1.5 text-sm leading-5 text-ink-soft">{children}</span>;
}

/**
 * Everyone in the game, how many squares each crossed off, the deadline and
 * (host only) Extend deadline, once, and End game. Both are enforced in SQL
 * (`extend_deadline`, `end_game`); non-hosts never see them.
 */
export function PlayersSheetBody({
  game,
  players,
  board,
  meId,
  isHost,
  theme,
  ending,
  error,
  onEndGame,
  onExtend,
}: {
  game: Game;
  players: Player[];
  board: DisplaySquare[];
  meId: string | null;
  isHost: boolean;
  /** Player-color shade for the board's theme. */
  theme: PaletteTheme;
  ending: boolean;
  error: string | null;
  onEndGame: () => void;
  /** Opens the host's extend sheet. */
  onExtend?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const counts = new Map<string, number>();
  for (const square of board) {
    const by = square.completed_by_player_id;
    if (by && square.completed_at) counts.set(by, (counts.get(by) ?? 0) + 1);
  }
  const ends = useDeadlineLine(game.deadline_at);
  const extended = (game.deadline_extended_at ?? null) !== null;

  return (
    <div className="flex min-w-0 flex-col gap-[14px] pb-2" data-testid="players-sheet-body">
      <p className="text-lg leading-7 text-ink-soft" data-testid="players-total">
        {players.length}/{MAX_PLAYERS} playing
      </p>
      <ul className="flex flex-col" data-testid="board-players">
        {players.map((p) => {
          const n = counts.get(p.id) ?? 0;
          return (
            <li key={p.id} data-testid="board-player" data-color={p.color} className="flex min-h-11 min-w-0 items-center gap-3">
              <BoardSwatch color={p.color} theme={theme} />
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="min-w-0 truncate text-xl">{p.display_name}</span>
                {p.user_id === game.host_user_id ? <Tag>host</Tag> : null}
                {p.id === meId ? <Tag>you</Tag> : null}
              </span>
              <span className="shrink-0 text-lg text-ink-soft tabular-nums">
                {n} {n === 1 ? "square" : "squares"}
              </span>
            </li>
          );
        })}
      </ul>

      {ends ? (
        <p className="text-lg leading-7 text-ink-soft" data-testid="auto-end">
          {ends}
        </p>
      ) : null}

      {isHost ? (
        <div className="flex min-w-0 flex-col gap-2 border-t-2 border-dashed border-ink-faint pt-[14px]">
          {confirming ? (
            <>
              <p className="text-xl leading-7">End the game for everyone? The board locks and the album opens.</p>
              <div className="flex flex-wrap items-center gap-3">
                <PencilButton onClick={onEndGame} busy={ending} data-testid="end-game-confirm">
                  End game
                </PencilButton>
                <PencilButton variant="quiet" onClick={() => setConfirming(false)} data-testid="end-game-cancel">
                  Keep playing
                </PencilButton>
              </div>
            </>
          ) : (
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              {!extended && onExtend ? (
                <PencilButton variant="secondary" onClick={onExtend} data-testid="extend-deadline">
                  Extend deadline
                </PencilButton>
              ) : null}
              <PencilButton variant="secondary" onClick={() => setConfirming(true)} data-testid="end-game">
                End game
              </PencilButton>
            </div>
          )}
          {extended && !confirming ? (
            <p className="text-lg leading-7 text-ink-soft" data-testid="deadline-extended">
              Deadline extended once
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-lg leading-7 text-danger" data-testid="end-game-error">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
