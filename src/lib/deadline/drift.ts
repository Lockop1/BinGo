import {
  DEADLINE_MIN_MS,
  computePreset,
  validateDeadline,
  type DeadlinePreset,
  type DeadlineValidity,
  type FixedDeadlinePreset,
} from "@/lib/deadline/presets";

/**
 * A picked deadline drifting while the screen stays open (pure, no React).
 *
 * A preset's value is computed once, when it is picked; minutes later the same
 * instant can be under the 10-minute minimum. The picker then re-resolves the
 * preset (`refreshDriftedPreset`) the moment that happens (`tooSoonFromMs`,
 * which both the picker's and the form's clocks wake up for) and says so in
 * one line (`presetRefreshNotice`) instead of silently jumping a day or a week.
 */

/**
 * The first instant (epoch ms) at which `value` is less than 10 minutes away,
 * i.e. `validateDeadline(value, at)` says `too_soon` (exactly 10 minutes is
 * still allowed).
 */
export function tooSoonFromMs(value: Date): number {
  return value.getTime() - DEADLINE_MIN_MS + 1;
}

/**
 * How long a clock that ticks every `intervalMs` should sleep at `nowMs` so it
 * also wakes right at `dueMs` (`tooSoonFromMs`): the sooner of the two. `null`
 * or a `dueMs` already reached means plain interval ticks.
 */
export function wakeDelayMs(intervalMs: number, dueMs: number | null, nowMs: number): number {
  const untilDue = dueMs === null ? Number.POSITIVE_INFINITY : dueMs - nowMs;
  return untilDue > 0 ? Math.min(intervalMs, untilDue) : intervalMs;
}

/**
 * The fresh value of a selected fixed preset whose held `value` has drifted
 * under the 10-minute minimum at `now` (Tonight at 02:51 gives tomorrow's
 * 3:00 AM), or `null` when there is nothing to refresh: no preset or Custom (a
 * typed time is never changed for the person), nothing held yet (the first
 * fill is not a drift), or the held value is still allowed.
 */
export function refreshDriftedPreset(
  preset: DeadlinePreset | null,
  value: Date | null,
  now: Date,
  timeZone: string,
): Date | null {
  if (preset === null || preset === "custom" || value === null) return null;
  if (validateDeadline(value, now) !== "too_soon") return null;
  return computePreset(preset, now, timeZone);
}

const NEXT_PRESET: Record<FixedDeadlinePreset, string> = {
  tonight: "the next 3 AM",
  day: "24 hours from now",
  weekend: "the next weekend",
};

/** The one-line notice shown after `refreshDriftedPreset` moved a preset. */
export function presetRefreshNotice(preset: FixedDeadlinePreset): string {
  return `Updated to ${NEXT_PRESET[preset]} — the earlier time is less than 10 minutes away`;
}

/** Why a picked deadline keeps Create disabled, or `null` when it does not. */
export function deadlineBlockMessage(validity: DeadlineValidity | null): string | null {
  if (validity === "too_soon") return "The end time is less than 10 minutes away. Pick a later one.";
  if (validity === "too_far") return "The end time is more than 7 days away. Pick an earlier one.";
  return null;
}
