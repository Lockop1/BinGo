/**
 * Deadline text for people (pure, no React): when it is ("Tonight 3:00 AM",
 * "Sun 11:59 PM") and how long is left ("4h 12m"). Wall-clock wording always
 * uses the given IANA `timeZone`, never the process zone.
 */

import { zonedParts } from "@/lib/deadline/presets";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Hour (local) before which a next-day deadline still reads as "Tonight". */
const NIGHT_ENDS_HOUR = 5;
/** Hour (local) from which "tonight" starts: evening, so tomorrow's small hours are tonight. */
const EVENING_STARTS_HOUR = 17;

/** The longest a countdown hook should sleep between label checks. */
export const MAX_TICK_MS = 60_000;
/** The shortest: never re-render a countdown more often than this. */
export const MIN_TICK_MS = 15_000;
/** Added to the wake-up time so a timer that fires a hair early still sees the new label. */
export const TICK_SLACK_MS = 200;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: string, timeZone: string, kind: "time" | "weekday" | "full"): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}|${kind}`;
  let f = formatters.get(key);
  if (!f) {
    const time = { hour: "numeric", minute: "2-digit" } as const;
    const options: Intl.DateTimeFormatOptions =
      kind === "time"
        ? { timeZone, ...time }
        : kind === "weekday"
          ? { timeZone, weekday: "short", ...time }
          : { timeZone, weekday: "short", month: "short", day: "numeric", ...time };
    f = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, f);
  }
  return f;
}

/**
 * ICU puts a narrow no-break space before "AM"/"PM" in newer versions and a
 * plain space in older ones; normalise every space variant to a plain space so
 * output is the same on every runtime (the UI keeps it on one line with
 * `whitespace-nowrap`).
 */
function clean(text: string): string {
  return text.replace(/[   ]/g, " ");
}

function calendarDayNumber(p: { year: number; month: number; day: number }): number {
  return Date.UTC(p.year, p.month - 1, p.day) / DAY_MS;
}

/**
 * Short text for when the deadline is, on the wall clock of `timeZone`:
 * - `"Passed"` when `deadline <= now`;
 * - `"Tonight 3:00 AM"`: the same local calendar day at night (before 5 AM or
 *   from 5 PM), or before 5 AM the next day while it is now 5 PM or later;
 * - `"Today 2:00 PM"`: the same local day in daytime (5 AM–5 PM), where
 *   "Tonight" would read wrong;
 * - `"Tomorrow 3:00 AM"`: the next local day otherwise;
 * - `"Sun 11:59 PM"`: 2–6 local days ahead;
 * - `"Sat, Oct 31, 8:00 PM"`: further out.
 * The relative words are English; dates and times follow `locale`.
 */
export function describeDeadline(deadline: Date, now: Date, timeZone: string, locale = "en-US"): string {
  const ms = deadline.getTime();
  if (Number.isNaN(ms) || ms <= now.getTime()) return "Passed";
  const d = zonedParts(deadline, timeZone);
  const n = zonedParts(now, timeZone);
  const dayDiff = calendarDayNumber(d) - calendarDayNumber(n);
  const time = () => clean(formatter(locale, timeZone, "time").format(deadline));

  const isNight = d.hour < NIGHT_ENDS_HOUR || d.hour >= EVENING_STARTS_HOUR;
  if (dayDiff === 0) return `${isNight ? "Tonight" : "Today"} ${time()}`;
  if (dayDiff === 1) {
    const tonight = d.hour < NIGHT_ENDS_HOUR && n.hour >= EVENING_STARTS_HOUR;
    return `${tonight ? "Tonight" : "Tomorrow"} ${time()}`;
  }
  if (dayDiff >= 2 && dayDiff <= 6) return clean(formatter(locale, timeZone, "weekday").format(deadline));
  return clean(formatter(locale, timeZone, "full").format(deadline));
}

export type CountdownTier = "days" | "hours" | "minutes" | "under-minute" | "passed";

export type Countdown = {
  /** Milliseconds until the deadline, never negative. */
  msLeft: number;
  /** "3d 4h", "4h 12m", "52m", "<1m" or "Ended" (zero parts dropped: "2d", "1h"). */
  label: string;
  tier: CountdownTier;
};

/**
 * Time left, rounded down: 1 day or more → days + hours, 1 hour or more →
 * hours + minutes, 1 minute or more → minutes, then "<1m", then "Ended" from
 * the deadline itself on. An invalid deadline counts as passed.
 */
export function countdown(deadline: Date, now: Date): Countdown {
  const diff = deadline.getTime() - now.getTime();
  if (Number.isNaN(diff) || diff <= 0) return { msLeft: 0, label: "Ended", tier: "passed" };
  if (diff < MINUTE_MS) return { msLeft: diff, label: "<1m", tier: "under-minute" };
  if (diff < HOUR_MS) return { msLeft: diff, label: `${Math.floor(diff / MINUTE_MS)}m`, tier: "minutes" };
  if (diff < DAY_MS) {
    const h = Math.floor(diff / HOUR_MS);
    const m = Math.floor((diff % HOUR_MS) / MINUTE_MS);
    return { msLeft: diff, label: m ? `${h}h ${m}m` : `${h}h`, tier: "hours" };
  }
  const d = Math.floor(diff / DAY_MS);
  const h = Math.floor((diff % DAY_MS) / HOUR_MS);
  return { msLeft: diff, label: h ? `${d}d ${h}h` : `${d}d`, tier: "days" };
}

/** True while 0 < time left < 1 hour (not once the deadline has passed). */
export function isUnderOneHour(deadline: Date, now: Date): boolean {
  const diff = deadline.getTime() - now.getTime();
  return diff > 0 && diff < HOUR_MS;
}

/**
 * Milliseconds until `countdown(deadline, …).label` next changes, capped at
 * 60 s (and 60 s once passed, when it never changes again). The label shows
 * whole minutes (whole hours from 1 day out), so it changes 1 ms after the time
 * left drops below the next whole unit; under a minute it changes at the
 * deadline itself. Always ≥ 1.
 */
export function nextTickMs(deadline: Date, now: Date): number {
  const diff = deadline.getTime() - now.getTime();
  if (Number.isNaN(diff) || diff <= 0) return MAX_TICK_MS;
  if (diff < MINUTE_MS) return Math.min(diff, MAX_TICK_MS);
  const unit = diff >= DAY_MS ? HOUR_MS : MINUTE_MS;
  return Math.min((diff % unit) + 1, MAX_TICK_MS);
}

/**
 * How long a countdown hook should sleep: `nextTickMs` plus a little slack,
 * kept within [15 s, 60 s]. The 60 s cap also refreshes `describeDeadline`
 * wording ("Tonight" → "Tomorrow") that changes on the clock, not the countdown.
 */
export function countdownTickDelayMs(deadline: Date | null, now: Date): number {
  if (!deadline) return MAX_TICK_MS;
  return Math.min(MAX_TICK_MS, Math.max(MIN_TICK_MS, nextTickMs(deadline, now) + TICK_SLACK_MS));
}

/**
 * The one-line summary used by `DeadlineSummary`: "Ends Sun 11:59 PM · 2d 4h",
 * "Ends tonight 3:00 AM · 4h 12m", or "Ended" once passed.
 */
export function deadlineSummaryText(deadline: Date, now: Date, timeZone: string, locale = "en-US"): string {
  const left = countdown(deadline, now);
  if (left.tier === "passed") return "Ended";
  const when = describeDeadline(deadline, now, timeZone, locale).replace(
    /^(Tonight|Today|Tomorrow)\b/,
    (word) => word.toLowerCase(),
  );
  return `Ends ${when} · ${left.label}`;
}
