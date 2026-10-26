/**
 * The host's one live extension (pure, no React): quick choices, the custom
 * `datetime-local` bounds and validation. The server (`extend_deadline`) is the
 * judge: strictly later than the current deadline and at most one day later
 * (exact, no slack), once per game. These helpers only keep the UI from
 * offering anything it would refuse.
 */

import { localInputValue } from "@/lib/deadline/presets";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** The furthest an extension may move the deadline. */
export const EXTEND_MAX_MS = 24 * HOUR_MS;
/** The custom time must be at least this much later than the current deadline. */
export const EXTEND_MIN_MS = MINUTE_MS;

export type ExtendChoice = "1h" | "3h" | "24h" | "custom";
export type QuickExtendChoice = Exclude<ExtendChoice, "custom">;

export const EXTEND_QUICK: readonly { choice: QuickExtendChoice; label: string; ms: number }[] = [
  { choice: "1h", label: "+1 hour", ms: HOUR_MS },
  { choice: "3h", label: "+3 hours", ms: 3 * HOUR_MS },
  { choice: "24h", label: "+24 hours", ms: EXTEND_MAX_MS },
];

/** `current + ms`, clipped to the maximum (`current + 24 h`). */
export function extendBy(current: Date, ms: number): Date {
  return new Date(current.getTime() + Math.min(Math.max(ms, 0), EXTEND_MAX_MS));
}

export type ExtensionValidity = "ok" | "too_soon" | "too_far";

/** `ok` when `candidate` is 1 minute to 24 hours (inclusive) after `current`; invalid dates are `too_soon`. */
export function validateExtension(current: Date, candidate: Date): ExtensionValidity {
  const diff = candidate.getTime() - current.getTime();
  if (Number.isNaN(diff) || diff < EXTEND_MIN_MS) return "too_soon";
  if (diff > EXTEND_MAX_MS) return "too_far";
  return "ok";
}

/**
 * `min` / `max` for the custom input on the wall clock of `timeZone`: the
 * first whole minute at least 1 minute after `current`, and the last whole
 * minute at most 24 hours after it.
 */
export function extendInputBounds(current: Date, timeZone: string): { min: string; max: string } {
  const ms = current.getTime();
  const min = Math.ceil((ms + EXTEND_MIN_MS) / MINUTE_MS) * MINUTE_MS;
  const max = Math.floor((ms + EXTEND_MAX_MS) / MINUTE_MS) * MINUTE_MS;
  return { min: localInputValue(new Date(min), timeZone), max: localInputValue(new Date(max), timeZone) };
}
