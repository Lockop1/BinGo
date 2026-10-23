"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { Scribble } from "@/components/board/Scribble";
import type { DisplaySquare } from "@/lib/game/boardState";
import { boardLabelSize, initialOf } from "@/lib/game/boardText";
import { BOARD_SIZE, CENTER_POSITION, type Player } from "@/lib/game/types";
import { playerColor, type PaletteTheme } from "@/lib/palette";

const versionKey = (s: Pick<DisplaySquare, "position" | "completed_at">) => `${s.position}:${s.completed_at}`;

/** Cell boundaries at 0%, 20% … 100%: 6 horizontal and 6 vertical lines. */
const LINE_STOPS = ["0%", "20%", "40%", "60%", "80%", "100%"];

/**
 * The grid lines, drawn over the cell boundaries in px units (percentage
 * coordinates, no viewBox) so stroke width and the scoreboard's lamp spacing
 * stay in screen pixels at every cell ratio. Look comes from the theme tokens
 * (--board-line, --board-line-width, --board-line-dash in globals.css).
 */
export function BoardLines() {
  return (
    <svg aria-hidden className="board-lines" data-testid="board-lines">
      {LINE_STOPS.map((at, i) => (
        <line key={`h${i}`} x1="0%" x2="100%" y1={at} y2={at} />
      ))}
      {LINE_STOPS.map((at, i) => (
        <line key={`v${i}`} x1={at} x2={at} y1="0%" y2="100%" />
      ))}
    </svg>
  );
}

/**
 * The live 5×5 grid. Always exactly the available width (no horizontal
 * scroll at any setting): minmax(0, 1fr) columns, cell height from
 * --board-cell-ratio, label size from --board-text-scale.
 */
export function BoardGrid({
  board,
  players,
  theme,
  highlight,
  onSelect,
}: {
  board: DisplaySquare[];
  players: Player[];
  theme: PaletteTheme;
  /** Cells of a line being celebrated right now. */
  highlight: readonly number[];
  onSelect: (position: number) => void;
}) {
  // Squares already crossed off when the board appeared draw instantly; later ones draw in.
  const [initial] = useState(() => new Set(board.filter((s) => s.completed_at !== null).map(versionKey)));
  const byId = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const byPosition = useMemo(() => new Map(board.map((s) => [s.position, s])), [board]);
  const lit = useMemo(() => new Set(highlight), [highlight]);

  return (
    <div className="board-frame" data-testid="board-grid">
      <ol className="board-grid" aria-label="Board">
        {Array.from({ length: BOARD_SIZE }, (_, position) => {
          const square = byPosition.get(position);
          return (
            <li key={position} className="board-cell" data-celebrate={lit.has(position) || undefined}>
              {square ? (
                <BoardCell
                  square={square}
                  completer={square.completed_by_player_id ? (byId.get(square.completed_by_player_id) ?? null) : null}
                  theme={theme}
                  animate={square.pending || !initial.has(versionKey(square))}
                  onSelect={onSelect}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
      <BoardLines />
    </div>
  );
}

function BoardCell({
  square,
  completer,
  theme,
  animate,
  onSelect,
}: {
  square: DisplaySquare;
  completer: Player | null;
  theme: PaletteTheme;
  animate: boolean;
  onSelect: (position: number) => void;
}) {
  const done = square.completed_at !== null;
  const counter = square.target_count > 1;
  const text = square.label.trim();
  const label = square.free ? "FREE" : text;
  const extra = square.free && text && text.toUpperCase() !== "FREE" ? text : "";
  const swatch = completer ? playerColor(completer.color, theme) : null;
  const n = square.position + 1;

  const name = [
    square.free ? "Free space" : text || `Square ${n}`,
    counter ? `${square.current_count} of ${square.target_count}` : "",
    done && !square.free ? `crossed off by ${completer?.display_name ?? "someone"}` : "",
    square.pending ? "saving" : "",
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <button
      type="button"
      onClick={() => onSelect(square.position)}
      data-testid={`cell-${square.position}`}
      data-position={square.position}
      data-completed={done}
      data-completed-by={square.completed_by_player_id ?? undefined}
      data-pending={square.pending || undefined}
      data-free={square.free || undefined}
      data-count={counter ? `${square.current_count}/${square.target_count}` : undefined}
      aria-label={name}
      style={swatch ? ({ "--cell-color": swatch.fill } as CSSProperties) : undefined}
      className="relative flex size-full min-w-0 flex-col items-center justify-center overflow-hidden px-[5cqi] py-[7cqi] text-board-ink focus-visible:outline-[3px] focus-visible:-outline-offset-[3px] focus-visible:outline-board-ink"
    >
      {label ? (
        <span
          className="board-label"
          data-size={square.free ? "xl" : boardLabelSize(label)}
          data-done={(done && !square.free) || undefined}
          style={square.free ? { color: "var(--board-muted)", letterSpacing: "0.04em" } : undefined}
        >
          {label}
        </span>
      ) : null}
      {extra ? (
        <span className="board-label text-board-muted" data-size="sm" style={{ ["--label-lines" as string]: 2 }}>
          {extra}
        </span>
      ) : null}
      {counter ? (
        <span className="board-count" data-testid="cell-count">
          {square.current_count}/{square.target_count}
        </span>
      ) : null}
      {done ? (
        <Scribble
          key={square.completed_by_player_id ?? "free"}
          seed={square.position === CENTER_POSITION && square.free ? 99 : square.position}
          color={swatch ? swatch.fill : "var(--board-muted)"}
          animate={animate && !square.free}
          pending={square.pending}
          muted={square.free}
        />
      ) : null}
      {done && completer && swatch ? (
        <span
          className="board-badge"
          data-testid="cell-badge"
          aria-hidden
          style={{ backgroundColor: swatch.fill, color: swatch.ink, opacity: square.pending ? 0.55 : 1 }}
        >
          {initialOf(completer.display_name)}
        </span>
      ) : null}
    </button>
  );
}
