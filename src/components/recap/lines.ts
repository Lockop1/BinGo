/**
 * Bingo lines for the recap summary only (rows, columns, both diagonals = 12).
 * Kept local so the recap does not depend on the live board's helpers; it only
 * counts lines on the final server state, it never decides game outcomes.
 */

export type LineName = string;

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

export const RECAP_LINES: readonly { name: LineName; positions: readonly number[] }[] = [
  ...range(5).map((r) => ({ name: `Row ${r + 1}`, positions: range(5).map((c) => r * 5 + c) })),
  ...range(5).map((c) => ({ name: `Column ${c + 1}`, positions: range(5).map((r) => r * 5 + c) })),
  { name: "Diagonal", positions: range(5).map((i) => i * 6) },
  { name: "Anti-diagonal", positions: range(5).map((i) => (i + 1) * 4) },
];

type SquareLike = { position: number; completed_at: string | null };

/** Names of every fully completed line on the board (free center counts as completed). */
export function completedLines(squares: readonly SquareLike[]): LineName[] {
  const done = new Set(squares.filter((s) => s.completed_at !== null).map((s) => s.position));
  return RECAP_LINES.filter((line) => line.positions.every((p) => done.has(p))).map((line) => line.name);
}
