/**
 * Hand-drawn 5x5 whiteboard board for the invite card, as SVG path data in a 520x520 box
 * (grid from 10 to 510, 100 per cell). Fixed wobble, so every card looks the same; no player
 * data. Same idea as the logo: thick marker strokes that are not quite straight.
 */

export const BOARD_BOX = 520;
const START = 10;
const CELL = 100;

// Per-line wobble (bow at the middle, and end offsets), in board units. Hand-picked.
const BOW = [-3, 4, -5, 3, -4, 2];
const END_A = [2, -3, 1, -2, 3, -1];
const END_B = [-2, 2, -3, 1, -1, 3];

function line(i: number, vertical: boolean): string {
  const at = START + i * CELL;
  const a = at + END_A[i];
  const b = at + END_B[i];
  const mid = at + BOW[i];
  // Ends overshoot the frame a touch on inner lines, like a quick marker stroke.
  const lo = i === 0 || i === 5 ? START - 2 : START + 1;
  const hi = i === 0 || i === 5 ? START + 5 * CELL + 2 : START + 5 * CELL - 1;
  return vertical
    ? `M${a} ${lo} Q${mid + BOW[(i + 2) % 6]} ${(lo + hi) / 2} ${b} ${hi}`
    : `M${lo} ${a} Q${(lo + hi) / 2} ${mid + BOW[(i + 3) % 6]} ${hi} ${b}`;
}

/** 12 strokes: 6 vertical then 6 horizontal (frame included). */
export const BOARD_LINES: readonly string[] = [
  ...Array.from({ length: 6 }, (_, i) => line(i, true)),
  ...Array.from({ length: 6 }, (_, i) => line(i, false)),
];

/** Top-left corner of a cell (row, col) in board units. */
export function cellOrigin(row: number, col: number): { x: number; y: number } {
  return { x: START + col * CELL, y: START + row * CELL };
}

/** A quick marker X over a cell (two strokes and a second pass), like the live board's cross-off. */
export function crossOff(row: number, col: number): string[] {
  const { x, y } = cellOrigin(row, col);
  const p = (dx: number, dy: number) => `${x + dx} ${y + dy}`;
  return [
    `M${p(16, 18)} Q${p(52, 46)} ${p(86, 84)}`,
    `M${p(84, 15)} Q${p(46, 54)} ${p(17, 86)}`,
    `M${p(26, 33)} Q${p(56, 58)} ${p(79, 85)}`,
  ];
}

/** The two crossed-off cells: on the rising diagonal, echoing the logo's winning line. */
export const CROSSED_CELLS: readonly (readonly [number, number])[] = [
  [3, 1],
  [1, 3],
];

/**
 * A few handwritten square labels (generic, app-store-safe examples; no game data) as
 * [row, col, text]. Cells left blank read as squares still being filled in.
 */
export const SAMPLE_LABELS: readonly (readonly [number, number, string])[] = [
  [0, 0, "Group selfie"],
  [0, 3, "Dance move"],
  [1, 1, "High five"],
  [1, 3, "Karaoke"],
  [2, 4, "Find a dog"],
  [3, 1, "Sing along"],
  [3, 3, "New snack"],
  [4, 0, "Make a toast"],
  [4, 2, "Mural photo"],
];

/** Centre of a cell (row, col) in board units. */
export function cellCenter(row: number, col: number): { x: number; y: number } {
  const { x, y } = cellOrigin(row, col);
  return { x: x + CELL / 2, y: y + CELL / 2 };
}
