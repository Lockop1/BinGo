"use client";

import { Camera, Share2, Undo2 } from "lucide-react";
import { BoardSwatch } from "@/components/board/BoardSwatch";
import { HoldButton } from "@/components/ui/HoldButton";
import { PencilButton } from "@/components/ui/PencilButton";
import type { DisplaySquare } from "@/lib/game/boardState";
import { GAME_ERROR_COPY } from "@/lib/game/errors";
import type { Settled } from "@/lib/game/pendingActions";
import type { Player } from "@/lib/game/types";
import type { SyncState } from "@/lib/game/useGame";
import type { PaletteTheme } from "@/lib/palette";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export function squareTitle(square: DisplaySquare | undefined): string {
  if (!square) return "";
  if (square.free) return "Free space";
  return square.label.trim() || `Square ${square.position + 1}`;
}

/**
 * The complete-square sheet: full text and details, counter state, who
 * crossed it off and when, and the actions this player may take. The RPCs
 * decide; this only offers what makes sense (Undo for the completer or the
 * host).
 */
export function SquareSheetBody({
  square,
  players,
  me,
  isHost,
  theme,
  outcome,
  syncState,
  onComplete,
  onIncrement,
  onUndo,
}: {
  square: DisplaySquare;
  players: Player[];
  me: Player | null;
  isHost: boolean;
  /** Player-color shade for the board's theme. */
  theme: PaletteTheme;
  outcome: Settled | undefined;
  syncState: SyncState;
  onComplete: () => void;
  onIncrement: () => void;
  onUndo: () => void;
}) {
  const done = square.completed_at !== null;
  const counter = square.target_count > 1;
  const completer = square.completed_by_player_id
    ? (players.find((p) => p.id === square.completed_by_player_id) ?? null)
    : null;
  const mine = me !== null && square.completed_by_player_id === me.id;
  const canUndo = done && !square.free && me !== null && (mine || isHost);
  const label = square.label.trim();

  // "Jake got it first": my completion lost the race (applied = false).
  const beatenBy =
    outcome?.outcome === "not_applied" &&
    outcome.action.kind !== "undo" &&
    outcome.row?.completed_by_player_id &&
    outcome.row.completed_by_player_id !== outcome.action.playerId &&
    outcome.row.completed_by_player_id === square.completed_by_player_id
      ? (completer?.display_name ?? "Someone")
      : null;
  const failure = outcome?.outcome === "failed" && outcome.errorCode ? GAME_ERROR_COPY[outcome.errorCode] : null;

  return (
    <div className="flex min-w-0 flex-col gap-[14px] pb-2" data-testid="square-sheet-body" data-position={square.position}>
      {square.free && label && label.toUpperCase() !== "FREE" ? (
        <p className="text-xl leading-7 break-words">{label}</p>
      ) : null}
      {square.details.trim() ? (
        <p className="text-xl leading-7 whitespace-pre-line break-words text-ink-soft" data-testid="square-details-text">
          {square.details.trim()}
        </p>
      ) : null}

      {counter ? (
        <p className="flex items-baseline gap-2" data-testid="counter-value">
          <span className="text-6xl leading-none tabular-nums">{square.current_count}</span>
          <span className="text-3xl leading-none text-ink-soft tabular-nums">/{square.target_count}</span>
        </p>
      ) : null}

      <p className="flex min-h-7 min-w-0 flex-wrap items-center gap-x-2 text-lg leading-7" data-testid="square-status">
        {square.free ? (
          <span className="text-ink-soft">On the house: crossed off from the start.</span>
        ) : done ? (
          <>
            {completer ? <BoardSwatch color={completer.color} theme={theme} className="size-5" /> : null}
            <span className="min-w-0 break-words">
              Crossed off by {mine ? "you" : (completer?.display_name ?? "someone")}
              {square.completed_at ? ` at ${timeFormat.format(new Date(square.completed_at))}` : ""}
            </span>
          </>
        ) : (
          <span className="text-ink-soft">{counter ? `${square.target_count - square.current_count} to go.` : "Still open."}</span>
        )}
        {square.pending ? (
          <span className="text-ink-soft" data-testid="square-pending">
            {syncState === "offline" ? "· waiting for signal" : "· saving"}
          </span>
        ) : null}
      </p>

      {beatenBy ? (
        <p className="text-lg leading-7 text-ink-soft" data-testid="square-outcome">
          {beatenBy} got it first.
        </p>
      ) : null}
      {failure ? (
        <p role="alert" className="text-lg leading-7 text-danger" data-testid="square-error">
          {failure}
        </p>
      ) : null}

      {me && !done && !counter ? <HoldButton onConfirm={onComplete}>Hold to complete</HoldButton> : null}

      {me && !done && counter ? (
        <PencilButton onClick={onIncrement} className="w-full text-3xl" data-testid="increment" aria-label="Add one">
          +1
        </PencilButton>
      ) : null}

      {canUndo ? (
        <PencilButton variant="secondary" onClick={onUndo} className="self-start" data-testid="undo">
          <Undo2 aria-hidden className="size-5" strokeWidth={2.25} />
          Undo
        </PencilButton>
      ) : null}

      {/* Phase 6: camera-first capture and sharing. Shown so the layout is real. */}
      <div className="flex min-w-0 flex-wrap gap-2 pt-1" aria-label="Coming soon">
        <PencilButton variant="secondary" disabled className="px-3 text-lg" data-testid="add-media">
          <Camera aria-hidden className="size-5" strokeWidth={2.25} />
          Photo/video
        </PencilButton>
        <PencilButton variant="secondary" disabled className="px-3 text-lg" data-testid="share-square">
          <Share2 aria-hidden className="size-5" strokeWidth={2.25} />
          Share
        </PencilButton>
      </div>
    </div>
  );
}
