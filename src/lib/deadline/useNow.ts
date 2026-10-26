import { useMemo, useSyncExternalStore } from "react";
import { countdown, countdownTickDelayMs, describeDeadline, type Countdown } from "@/lib/deadline/format";
import { fromIso, resolveTimeZone } from "@/lib/deadline/presets";

/**
 * Clock hooks for deadline text.
 *
 * Hydration: these hooks return `null` for the time on the server and during
 * the hydration render (React's `getServerSnapshot`), and a real `Date` from
 * the first client render after that (immediately on a client-side
 * navigation). So time-dependent text renders nothing until mounted, and the
 * server HTML never disagrees with the phone's clock or time zone. Callers
 * render a fixed-size empty slot while the time is `null`.
 *
 * Each hook instance owns a tiny clock store: a cached `Date` that only
 * changes when the store ticks (a stable snapshot for `useSyncExternalStore`),
 * a `setTimeout` chain whose next delay is computed from the current time, and
 * immediate ticks when the tab becomes visible again or the phone comes back
 * online (timers are throttled or frozen in background tabs).
 */

type Clock = {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => Date;
};

function createClock(delayFor: (now: Date) => number): Clock {
  let value: Date | null = null;
  const read = () => {
    if (!value) value = new Date();
    return value;
  };
  return {
    getSnapshot: read,
    subscribe(onChange) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(tick, Math.max(1, delayFor(read())));
      };
      const tick = () => {
        value = new Date();
        onChange();
        schedule();
      };
      const onVisibility = () => {
        if (document.visibilityState === "visible") tick();
      };
      // A store created a while ago (re-subscribe) may hold an old time;
      // React re-reads the snapshot right after subscribing, so refreshing
      // here is enough to re-render with it.
      if (!value || Date.now() - value.getTime() > 1000) value = new Date();
      schedule();
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("online", tick);
      return () => {
        clearTimeout(timer);
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("online", tick);
      };
    },
  };
}

const getServerNow = (): Date | null => null;

/**
 * The current time, refreshed every `intervalMs`, when the tab becomes
 * visible and when the phone comes back online. `null` on the server and in
 * the hydration render (see the module comment).
 */
export function useNow(intervalMs = 60_000): Date | null {
  const clock = useMemo(() => createClock(() => intervalMs), [intervalMs]);
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, getServerNow);
}

const subscribeNothing = () => () => {};

/** `false` on the server and in the hydration render, `true` after that. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
}

export type CountdownState = {
  /** `null` until mounted. */
  now: Date | null;
  /** `null` until mounted or without a (valid) deadline. */
  countdown: Countdown | null;
  /** `describeDeadline` text; `null` like `countdown`. */
  describe: string | null;
};

/**
 * A countdown to `deadlineIso` that re-renders exactly when its label would
 * change (`nextTickMs`), but never more often than every 15 s nor less often
 * than every 60 s (`countdownTickDelayMs`), plus on tab-visible and `online`.
 * `timeZone` defaults to the phone's zone. Hydration-safe like `useNow`.
 */
export function useCountdown(deadlineIso: string | null, timeZone?: string, locale = "en-US"): CountdownState {
  const deadlineMs = fromIso(deadlineIso)?.getTime() ?? null;
  const clock = useMemo(
    () => createClock((now) => countdownTickDelayMs(deadlineMs === null ? null : new Date(deadlineMs), now)),
    [deadlineMs],
  );
  const now = useSyncExternalStore(clock.subscribe, clock.getSnapshot, getServerNow);
  const zone = useMemo(() => resolveTimeZone(timeZone), [timeZone]);
  if (!now || deadlineMs === null) return { now, countdown: null, describe: null };
  const deadline = new Date(deadlineMs);
  return { now, countdown: countdown(deadline, now), describe: describeDeadline(deadline, now, zone, locale) };
}
