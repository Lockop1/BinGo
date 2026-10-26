/**
 * Game deadline presets, validation and time-zone math (pure, no React).
 *
 * The deadline is stored as an instant (`deadline_at`, ISO string). Presets are
 * wall-clock rules ("3:00 AM", "Sunday 11:59 PM") evaluated on the phone in its
 * own IANA time zone; the server only ever sees the resulting instant and
 * enforces its own bounds.
 *
 * Time-zone approach (no libraries):
 * - `zonedParts(date, tz)` reads the wall clock of an instant with
 *   `Intl.DateTimeFormat(...).formatToParts` (`hourCycle: "h23"`).
 * - The zone's UTC offset at an instant is `wallClockAsUtc - instant`.
 * - `zonedTimeToInstant(wall, tz)` turns a wall-clock time into an instant:
 *   treat the wall time as UTC (`naive`), subtract the offset found at that
 *   guess, then re-read the offset at the result and repeat until it stops
 *   moving (the iterative offset fix; it converges in one or two rounds). DST
 *   transitions make the answer ambiguous, so the offsets in effect a day
 *   before and a day after are tried as well and every candidate is checked by
 *   formatting it back:
 *     - one or more candidates read back as the wall time → the earliest wins
 *       (fall-back overlap: 01:30 on the night clocks go back means the first
 *       01:30, the one still on summer time);
 *     - none does (spring-forward gap: 02:30 does not exist) → the wall time is
 *       pushed forward by the size of the gap (02:30 → 03:30), using the offset
 *       in effect before the transition.
 *   This is the same "compatible" disambiguation as `Temporal`.
 * - Calendar arithmetic ("tomorrow", "next Sunday") is done on the wall date
 *   with `Date.UTC`, which never sees DST; only the final wall time goes
 *   through the zone. Nothing here reads the process time zone (no local
 *   `Date` getters), so results depend only on the `timeZone` argument.
 */

export const DEADLINE_MIN_MS = 10 * 60_000;
export const DEADLINE_MAX_MS = 7 * 86_400_000;

export type DeadlinePreset = "tonight" | "day" | "weekend" | "custom";
/** The presets that compute their own time (everything but `custom`). */
export type FixedDeadlinePreset = Exclude<DeadlinePreset, "custom">;

export const DEADLINE_PRESETS: readonly DeadlinePreset[] = ["tonight", "day", "weekend", "custom"];
export const FIXED_DEADLINE_PRESETS: readonly FixedDeadlinePreset[] = ["tonight", "day", "weekend"];
export const DEFAULT_DEADLINE_PRESET: FixedDeadlinePreset = "tonight";

/** Wall-clock hour/minute of the `tonight` and `weekend` presets. */
export const TONIGHT_HOUR = 3;
export const WEEKEND_HOUR = 23;
export const WEEKEND_MINUTE = 59;

/** Two values within this distance count as the same preset in `matchPreset`. */
export const PRESET_MATCH_TOLERANCE_MS = 60_000;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** A wall-clock time in some zone; `month` is 1–12. */
export type WallTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
};

/** `WallTime` plus the weekday (0 = Sunday … 6 = Saturday). */
export type ZonedParts = Required<WallTime> & { weekday: number };

// ---------------------------------------------------------------------------
// Time zones

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** True when `Intl` knows this IANA zone name. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The phone's IANA time zone, or `'UTC'` when the runtime cannot tell. */
export function defaultTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone && isValidTimeZone(zone)) return zone;
  } catch {
    // Fall through to UTC.
  }
  return "UTC";
}

/** `timeZone` when it is a usable zone name, else the phone's zone. */
export function resolveTimeZone(timeZone?: string | null): string {
  return timeZone && isValidTimeZone(timeZone) ? timeZone : defaultTimeZone();
}

function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** The wall clock of `date` in `timeZone` (seconds precision). */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const values: Record<string, number> = {};
  for (const part of partsFormatter(timeZone).formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  const { year, month, day, minute, second } = values;
  // Some engines print midnight as 24 even with h23; normalise just in case.
  const hour = values.hour === 24 ? 0 : values.hour;
  return { year, month, day, hour, minute, second, weekday: weekdayOf(year, month, day) };
}

function wallToUtcMs(wall: WallTime): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second ?? 0);
}

/** Zone offset (ms, east of UTC positive) in effect at instant `ms`. */
function offsetAt(ms: number, timeZone: string): number {
  const whole = Math.floor(ms / 1000) * 1000; // Intl drops milliseconds.
  return wallToUtcMs(zonedParts(new Date(whole), timeZone)) - whole;
}

function readsAs(ms: number, wall: WallTime, timeZone: string): boolean {
  const p = zonedParts(new Date(ms), timeZone);
  return (
    p.year === wall.year &&
    p.month === wall.month &&
    p.day === wall.day &&
    p.hour === wall.hour &&
    p.minute === wall.minute &&
    p.second === (wall.second ?? 0)
  );
}

/**
 * The instant at which the wall clock in `timeZone` shows `wall`. Overlaps
 * resolve to the earlier instant, gaps push the time forward by the gap (see
 * the module comment).
 */
export function zonedTimeToInstant(wall: WallTime, timeZone: string): Date {
  const naive = wallToUtcMs(wall);

  // Iterative offset fix: guess, re-read the offset at the result, repeat.
  let guess = naive - offsetAt(naive, timeZone);
  for (let round = 0; round < 3; round += 1) {
    const next = naive - offsetAt(guess, timeZone);
    if (next === guess) break;
    guess = next;
  }

  const offsetBefore = offsetAt(naive - DAY_MS, timeZone);
  const offsetAfter = offsetAt(naive + DAY_MS, timeZone);
  const candidates = [guess, naive - offsetBefore, naive - offsetAfter];
  const exact = candidates.filter((ms) => readsAs(ms, wall, timeZone));
  if (exact.length > 0) return new Date(Math.min(...exact));
  // Gap: keep the pre-transition offset, which lands after the jump.
  return new Date(naive - offsetBefore);
}

/** The wall date `days` after the given one (pure calendar arithmetic). */
function addCalendarDays(wall: { year: number; month: number; day: number }, days: number) {
  const d = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// ---------------------------------------------------------------------------
// Presets

/**
 * The deadline a preset gives at `now` in `timeZone`:
 * - `tonight`: the next 3:00 AM at least 10 minutes after `now` (00:30 → today
 *   3:00, 02:55 or 23:00 → the next day's 3:00);
 * - `day`: exactly `now + 24 h`;
 * - `weekend`: the next Sunday 23:59 at least 10 minutes after `now` (Sunday
 *   22:00 → today; Sunday 23:55 → next Sunday, which is more than 7 days out,
 *   so it is clamped to `now + 7 days`).
 * `custom` has no rule of its own, so it is not accepted here.
 */
export function computePreset(kind: FixedDeadlinePreset, now: Date, timeZone: string): Date {
  const nowMs = now.getTime();
  if (kind === "day") return new Date(nowMs + DAY_MS);

  const today = zonedParts(now, timeZone);
  if (kind === "tonight") {
    for (let add = 0; ; add += 1) {
      const date = addCalendarDays(today, add);
      const at = zonedTimeToInstant({ ...date, hour: TONIGHT_HOUR, minute: 0 }, timeZone);
      if (at.getTime() - nowMs >= DEADLINE_MIN_MS) return at;
    }
  }

  // weekend
  for (let add = (7 - today.weekday) % 7; ; add += 7) {
    const date = addCalendarDays(today, add);
    const at = zonedTimeToInstant({ ...date, hour: WEEKEND_HOUR, minute: WEEKEND_MINUTE }, timeZone);
    if (at.getTime() - nowMs >= DEADLINE_MIN_MS) return clampDeadline(at, now);
  }
}

/**
 * Which preset gives `value` at `now` (within a minute), else `'custom'`.
 * Checked in picker order, so a value that two presets share (only possible at
 * exactly 3:00 AM) reads as `tonight`.
 */
export function matchPreset(value: Date, now: Date, timeZone: string): DeadlinePreset {
  const ms = value.getTime();
  if (Number.isNaN(ms)) return "custom";
  for (const kind of FIXED_DEADLINE_PRESETS) {
    if (Math.abs(computePreset(kind, now, timeZone).getTime() - ms) < PRESET_MATCH_TOLERANCE_MS) return kind;
  }
  return "custom";
}

// ---------------------------------------------------------------------------
// Validation

export type DeadlineValidity = "ok" | "too_soon" | "too_far";

/**
 * `ok` when `candidate` is 10 minutes to 7 days (both inclusive) after `now`.
 * An invalid date counts as `too_soon`.
 */
export function validateDeadline(candidate: Date, now: Date): DeadlineValidity {
  const diff = candidate.getTime() - now.getTime();
  if (Number.isNaN(diff) || diff < DEADLINE_MIN_MS) return "too_soon";
  if (diff > DEADLINE_MAX_MS) return "too_far";
  return "ok";
}

/** `candidate` moved into [now + 10 min, now + 7 days]; an invalid date becomes the minimum. */
export function clampDeadline(candidate: Date, now: Date): Date {
  const nowMs = now.getTime();
  const ms = candidate.getTime();
  const min = nowMs + DEADLINE_MIN_MS;
  const max = nowMs + DEADLINE_MAX_MS;
  if (Number.isNaN(ms) || ms < min) return new Date(min);
  if (ms > max) return new Date(max);
  return new Date(ms);
}

// ---------------------------------------------------------------------------
// Serialisation

/** ISO 8601 UTC string (`toISOString`); throws on an invalid date. */
export function toIso(date: Date): string {
  return date.toISOString();
}

/** Parses an ISO timestamp; `null` for null, empty or unparseable input. */
export function fromIso(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/**
 * `YYYY-MM-DDTHH:mm` for `<input type="datetime-local">`, showing `date` on the
 * wall clock of `timeZone` (seconds are dropped, not rounded).
 */
export function localInputValue(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/;

/**
 * The instant a `datetime-local` value means on the wall clock of `timeZone`,
 * or `null` when it is empty or malformed (including impossible dates such as
 * Feb 30). Accepts optional seconds (inputs with a `step`). A time inside a
 * spring-forward gap moves forward by the gap; one inside a fall-back overlap
 * means its first occurrence.
 */
export function parseLocalInput(value: string, timeZone: string): Date | null {
  const match = LOCAL_INPUT.exec(value.trim());
  if (!match) return null;
  const [year, month, day, hour, minute, second = 0] = match.slice(1).map((s) => (s === undefined ? 0 : Number(s)));
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return null;
  return zonedTimeToInstant({ year, month, day, hour, minute, second }, timeZone);
}

/**
 * `min` / `max` attributes for the custom `datetime-local` input: the first
 * whole minute at least 10 minutes out and the last whole minute at most 7 days
 * out, on the wall clock of `timeZone`.
 */
export function customInputBounds(now: Date, timeZone: string): { min: string; max: string } {
  const nowMs = now.getTime();
  const min = Math.ceil((nowMs + DEADLINE_MIN_MS) / MINUTE_MS) * MINUTE_MS;
  const max = Math.floor((nowMs + DEADLINE_MAX_MS) / MINUTE_MS) * MINUTE_MS;
  return { min: localInputValue(new Date(min), timeZone), max: localInputValue(new Date(max), timeZone) };
}
