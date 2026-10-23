import { BOARD_SIZE } from "@/lib/game/types";

/**
 * Bingo lines on the 5×5 board (row-major positions, 12 = center).
 * Display-only: the server never scores lines, this only drives the
 * celebration and highlights.
 */

export type LineKind = "row" | "col" | "diag";

export type BingoLine = {
  /** Stable id: `r0`–`r4`, `c0`–`c4`, `d0` (top-left to bottom-right), `d1` (top-right to bottom-left). */
  id: string;
  kind: LineKind;
  positions: readonly number[];
};

const N = 5;

function buildLines(): BingoLine[] {
  const lines: BingoLine[] = [];
  for (let r = 0; r < N; r++) {
    lines.push({ id: `r${r}`, kind: "row", positions: Array.from({ length: N }, (_, c) => r * N + c) });
  }
  for (let c = 0; c < N; c++) {
    lines.push({ id: `c${c}`, kind: "col", positions: Array.from({ length: N }, (_, r) => r * N + c) });
  }
  lines.push({ id: "d0", kind: "diag", positions: Array.from({ length: N }, (_, i) => i * N + i) });
  lines.push({ id: "d1", kind: "diag", positions: Array.from({ length: N }, (_, i) => i * N + (N - 1 - i)) });
  return lines;
}

/** The 12 lines: 5 rows, 5 columns, 2 diagonals. */
export const LINES: readonly BingoLine[] = buildLines();

const BY_ID = new Map(LINES.map((line) => [line.id, line]));

export function lineById(id: string): BingoLine | undefined {
  return BY_ID.get(id);
}

type Completable = { position: number; completed_at: string | null };

/** Positions whose square is crossed off (free center included). */
export function completedPositions(squares: readonly Completable[]): Set<number> {
  const done = new Set<number>();
  for (const square of squares) {
    if (square.completed_at !== null) done.add(square.position);
  }
  return done;
}

/** Ids of every fully crossed-off line, in `LINES` order. */
export function completedLines(squares: readonly Completable[]): string[] {
  const done = completedPositions(squares);
  return LINES.filter((line) => line.positions.every((p) => done.has(p))).map((line) => line.id);
}

/** All 25 squares crossed off. */
export function isBlackout(squares: readonly Completable[]): boolean {
  const done = completedPositions(squares);
  for (let p = 0; p < BOARD_SIZE; p++) if (!done.has(p)) return false;
  return true;
}

/** Union of the positions of the given lines (sorted). */
export function linePositions(ids: readonly string[]): number[] {
  const set = new Set<number>();
  for (const id of ids) lineById(id)?.positions.forEach((p) => set.add(p));
  return [...set].sort((a, b) => a - b);
}

/** "Row 2", "Column 3", "Diagonal" for the celebration subtitle. */
export function lineName(id: string): string {
  const line = lineById(id);
  if (!line) return "";
  const n = Number(id.slice(1)) + 1;
  if (line.kind === "row") return `Row ${n}`;
  if (line.kind === "col") return `Column ${n}`;
  return "Diagonal";
}
