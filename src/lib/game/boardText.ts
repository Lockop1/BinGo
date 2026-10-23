/**
 * Board text helpers shared by the lobby grid (and later the live board).
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
