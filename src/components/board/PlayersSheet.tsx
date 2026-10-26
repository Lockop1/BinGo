"use client";

import { useState } from "react";
import { BoardSwatch } from "@/components/board/BoardSwatch";
import { PencilButton } from "@/components/ui/PencilButton";
import type { DisplaySquare } from "@/lib/game/boardState";
import { MAX_PLAYERS, type Game, type Player } from "@/lib/game/types";
import type { PaletteTheme } from "@/lib/palette";

const deadlineFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

/** The game's deadline as "Sat 9:41 PM" in the viewer's locale and time zone. */
export function deadlineLabel(deadlineAt: string | null): string | null {
  if (!deadlineAt) return null;
  const date = new Date(deadlineAt);
  return Number.isNaN(date.getTime()) ? null : deadlineFormat.format(date);
}

function Tag({ children }: { children: string }) {
  return <span className="pencil-border-alt shrink-0 px-1.5 text-sm leading-5 text-ink-soft">{children}</span>;
}

/** Everyone in the game, how many squares each crossed off, and (host only) End game. */
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
}) {
  const [confirming, setConfirming] = useState(false);
  const counts = new Map<string, number>();
  for (const square of board) {
    const by = square.completed_by_player_id;
    if (by && square.completed_at) counts.set(by, (counts.get(by) ?? 0) + 1);
  }
  const ends = deadlineLabel(game.deadline_at);

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
          Ends automatically at {ends}.
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
            <PencilButton variant="secondary" onClick={() => setConfirming(true)} className="self-start" data-testid="end-game">
              End game
            </PencilButton>
          )}
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
