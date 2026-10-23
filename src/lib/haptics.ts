/**
 * Tiny haptics helpers. `navigator.vibrate` is missing on iOS Safari and on
 * desktops, and may be blocked without a user gesture: every call is
 * guarded and never throws.
 */

function vibrate(pattern: number | number[]): void {
  try {
    if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
    navigator.vibrate(pattern);
  } catch {
    // Not allowed here: no buzz, no problem.
  }
}

/** Short pulse: this phone crossed a square off. */
export function pulse(): void {
  vibrate(18);
}

/** Double pulse: bingo. */
export function doublePulse(): void {
  vibrate([35, 70, 35]);
}
