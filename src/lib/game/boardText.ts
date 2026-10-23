/**
 * Board text helpers shared by the lobby grid and the live board.
 */

export type LabelSize = "lg" | "md" | "sm";

/** Font-size step for a square label by length: ≤12 large, ≤24 medium, else small. */
export function labelSize(label: string): LabelSize {
  const n = label.trim().length;
  if (n <= 12) return "lg";
  if (n <= 24) return "md";
  return "sm";
}

/** "ABCD2345" → "ABCD 2345": the invite code grouped for reading out loud. */
export function groupJoinCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
}

/**
 * Small deterministic jitter in [-1, 1] for hand-drawn lines (same on every
 * render and every phone, so lines do not wobble between renders).
 */
export function jitter(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/** Live-board label steps (font sizes scale with the cell, see `.board-label` in globals.css). */
export type BoardLabelSize = "xl" | "lg" | "md" | "sm";

const BOARD_STEPS: readonly BoardLabelSize[] = ["xl", "lg", "md", "sm"];

/**
 * Font step for a live-board square: shorter labels get bigger type, and a
 * long single word (which cannot wrap nicely) drops one more step so 2–4
 * words stay readable in a phone-width cell. The full text is in the sheet.
 */
export function boardLabelSize(label: string): BoardLabelSize {
  const text = label.replace(/\s+/g, " ").trim();
  const n = text.length;
  const longest = text.split(" ").reduce((max, word) => Math.max(max, word.length), 0);
  let step = n <= 9 ? 0 : n <= 18 ? 1 : n <= 28 ? 2 : 3;
  if (longest >= 10 && step < 2) step += 1;
  return BOARD_STEPS[step];
}

/** First letter of a display name, upper-cased (for the completer badge). */
export function initialOf(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toLocaleUpperCase() : "?";
}
