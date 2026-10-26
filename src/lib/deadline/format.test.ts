import { describe, expect, it } from "vitest";
import {
  MAX_TICK_MS,
  MIN_TICK_MS,
  TICK_SLACK_MS,
  countdown,
  countdownTickDelayMs,
  deadlineSummaryText,
  describeDeadline,
  isUnderOneHour,
  nextTickMs,
} from "@/lib/deadline/format";
import { computePreset } from "@/lib/deadline/presets";

// Explicit UTC instants and zones only; Mon Oct 26 2026 is EDT (UTC-4) in New York.
const NY = "America/New_York";
const KOL = "Asia/Kolkata";
const AKL = "Pacific/Auckland";
const LDN = "Europe/London";

const d = (iso: string) => new Date(iso);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("describeDeadline", () => {
  it.each([
    // [what, now, deadline, expected]
    ["evening → 3 AM tomorrow is tonight", "2026-10-27T00:00:00Z", "2026-10-27T07:00:00Z", "Tonight 3:00 AM"],
    ["small hours → 3 AM same day is tonight", "2026-10-26T05:00:00Z", "2026-10-26T07:00:00Z", "Tonight 3:00 AM"],
    ["morning → 3 AM tomorrow is tomorrow", "2026-10-26T14:00:00Z", "2026-10-27T07:00:00Z", "Tomorrow 3:00 AM"],
    ["16:59 is still before evening", "2026-10-26T20:59:00Z", "2026-10-27T07:00:00Z", "Tomorrow 3:00 AM"],
    ["17:00 starts the evening", "2026-10-26T21:00:00Z", "2026-10-27T07:00:00Z", "Tonight 3:00 AM"],
    ["4:59 AM next day is tonight", "2026-10-26T22:00:00Z", "2026-10-27T08:59:00Z", "Tonight 4:59 AM"],
    ["5:00 AM next day is tomorrow", "2026-10-26T22:00:00Z", "2026-10-27T09:00:00Z", "Tomorrow 5:00 AM"],
    ["midnight from the evening is tonight", "2026-10-27T00:00:00Z", "2026-10-27T04:00:00Z", "Tonight 12:00 AM"],
    ["same day evening is tonight", "2026-10-26T14:00:00Z", "2026-10-27T01:00:00Z", "Tonight 9:00 PM"],
    ["same day daytime is today", "2026-10-26T14:00:00Z", "2026-10-26T18:00:00Z", "Today 2:00 PM"],
    ["24 hours from 9 PM", "2026-10-27T01:00:00Z", "2026-10-28T01:00:00Z", "Tomorrow 9:00 PM"],
    ["2 days out shows the weekday", "2026-10-26T14:00:00Z", "2026-10-28T12:00:00Z", "Wed 8:00 AM"],
    ["6 days out shows the weekday (EST by then)", "2026-10-26T14:00:00Z", "2026-11-02T04:59:00Z", "Sun 11:59 PM"],
    ["7 days out shows the date", "2026-10-26T14:00:00Z", "2026-11-02T15:00:00Z", "Mon, Nov 2, 10:00 AM"],
    ["far out shows the date", "2026-10-23T16:00:00Z", "2026-11-01T00:00:00Z", "Sat, Oct 31, 8:00 PM"],
    ["across the fall-back night", "2026-11-01T03:00:00Z", "2026-11-01T08:00:00Z", "Tonight 3:00 AM"],
  ])("%s", (_what, now, deadline, expected) => {
    expect(describeDeadline(d(deadline), d(now), NY)).toBe(expected);
  });

  it("says Passed at or after the deadline", () => {
    const now = d("2026-10-26T14:00:00Z");
    expect(describeDeadline(now, now, NY)).toBe("Passed");
    expect(describeDeadline(d("2026-10-26T13:00:00Z"), now, NY)).toBe("Passed");
    expect(describeDeadline(new Date(Number.NaN), now, NY)).toBe("Passed");
  });

  it("reads the wall clock of the given zone", () => {
    const now = d("2026-10-27T00:00:00Z");
    const deadline = d("2026-10-27T07:00:00Z");
    expect(describeDeadline(deadline, now, NY)).toBe("Tonight 3:00 AM");
    expect(describeDeadline(deadline, now, KOL)).toBe("Today 12:30 PM"); // 05:30 → 12:30 IST
    expect(describeDeadline(deadline, now, AKL)).toBe("Tonight 8:00 PM"); // 13:00 → 20:00 NZDT
    expect(describeDeadline(deadline, now, "UTC")).toBe("Today 7:00 AM");
  });

  it("describes the presets as the picker shows them", () => {
    const now = d("2026-10-27T00:00:00Z"); // Mon 20:00 EDT
    expect(describeDeadline(computePreset("tonight", now, NY), now, NY)).toBe("Tonight 3:00 AM");
    expect(describeDeadline(computePreset("day", now, NY), now, NY)).toBe("Tomorrow 8:00 PM");
    expect(describeDeadline(computePreset("weekend", now, NY), now, NY)).toBe("Sun 11:59 PM");
    // Sunday 23:55: the weekend preset is clamped to 7 days out and shows the real date.
    const late = d("2026-10-26T03:55:00Z");
    expect(describeDeadline(computePreset("weekend", late, NY), late, NY)).toBe("Sun, Nov 1, 10:55 PM");
  });

  it("follows the locale for dates and times", () => {
    const now = d("2026-10-26T20:00:00Z"); // 20:00 GMT
    expect(describeDeadline(d("2026-10-27T03:00:00Z"), now, LDN, "en-GB")).toBe("Tonight 3:00");
    expect(describeDeadline(d("2026-10-26T22:00:00Z"), now, LDN, "en-GB")).toBe("Tonight 22:00");
    expect(describeDeadline(d("2026-10-27T03:00:00Z"), now, LDN)).toBe("Tonight 3:00 AM");
  });

  it("uses plain spaces only", () => {
    const text = describeDeadline(d("2026-11-02T15:00:00Z"), d("2026-10-26T14:00:00Z"), NY);
    expect(text).not.toMatch(/[   ]/);
  });
});

describe("countdown", () => {
  const now = d("2026-10-26T12:00:00Z");
  const left = (ms: number) => countdown(new Date(now.getTime() + ms), now);

  it.each([
    [3 * DAY + 4 * HOUR + 30 * MIN, "3d 4h", "days"],
    [7 * DAY, "7d", "days"],
    [2 * DAY + 59 * MIN, "2d", "days"],
    [DAY, "1d", "days"],
    [DAY - 1, "23h 59m", "hours"],
    [4 * HOUR + 12 * MIN + 30 * SEC, "4h 12m", "hours"],
    [HOUR, "1h", "hours"],
    [HOUR - 1, "59m", "minutes"],
    [52 * MIN, "52m", "minutes"],
    [MIN, "1m", "minutes"],
    [MIN - 1, "<1m", "under-minute"],
    [1, "<1m", "under-minute"],
  ])("%d ms left → %s (%s)", (ms, label, tier) => {
    expect(left(ms)).toEqual({ msLeft: ms, label, tier });
  });

  it("ends at the deadline", () => {
    expect(left(0)).toEqual({ msLeft: 0, label: "Ended", tier: "passed" });
    expect(left(-5 * MIN)).toEqual({ msLeft: 0, label: "Ended", tier: "passed" });
    expect(countdown(new Date(Number.NaN), now).tier).toBe("passed");
  });
});

describe("isUnderOneHour", () => {
  const now = d("2026-10-26T12:00:00Z");
  const at = (ms: number) => isUnderOneHour(new Date(now.getTime() + ms), now);

  it("is true only while 0 < time left < 1 h", () => {
    expect(at(59 * MIN)).toBe(true);
    expect(at(1)).toBe(true);
    expect(at(HOUR - 1)).toBe(true);
    expect(at(HOUR)).toBe(false);
    expect(at(0)).toBe(false);
    expect(at(-MIN)).toBe(false);
  });
});

describe("nextTickMs", () => {
  const now = d("2026-10-26T12:00:00Z");
  const tick = (ms: number) => nextTickMs(new Date(now.getTime() + ms), now);

  it("waits for the next minute boundary", () => {
    expect(tick(52 * MIN + 30 * SEC)).toBe(30 * SEC + 1);
    expect(tick(52 * MIN)).toBe(1);
    expect(tick(4 * HOUR + 12 * MIN + 59 * SEC)).toBe(59 * SEC + 1);
  });

  it("waits for the deadline under a minute", () => {
    expect(tick(59 * SEC)).toBe(59 * SEC);
    expect(tick(1)).toBe(1);
  });

  it("is capped at 60 s", () => {
    expect(tick(DAY + 2 * HOUR + 30 * MIN)).toBe(MAX_TICK_MS);
    expect(tick(0)).toBe(MAX_TICK_MS);
    expect(tick(-HOUR)).toBe(MAX_TICK_MS);
    expect(nextTickMs(new Date(Number.NaN), now)).toBe(MAX_TICK_MS);
  });

  it("is exactly when the label changes", () => {
    const deadline = new Date(now.getTime() + 2 * DAY + 37 * SEC + 123);
    let t = now.getTime();
    // Walk the countdown down to the end, one predicted tick at a time.
    for (let steps = 0; t < deadline.getTime() && steps < 10_000; steps += 1) {
      const at = new Date(t);
      const wait = nextTickMs(deadline, at);
      expect(wait).toBeGreaterThanOrEqual(1);
      expect(wait).toBeLessThanOrEqual(MAX_TICK_MS);
      const label = countdown(deadline, at).label;
      if (wait > 1) expect(countdown(deadline, new Date(t + wait - 1)).label).toBe(label);
      if (wait < MAX_TICK_MS) expect(countdown(deadline, new Date(t + wait)).label).not.toBe(label);
      t += wait;
    }
    expect(countdown(deadline, new Date(t)).label).toBe("Ended");
  });
});

describe("countdownTickDelayMs", () => {
  const now = d("2026-10-26T12:00:00Z");
  const delay = (ms: number) => countdownTickDelayMs(new Date(now.getTime() + ms), now);

  it("stays within 15–60 s", () => {
    expect(countdownTickDelayMs(null, now)).toBe(MAX_TICK_MS);
    expect(delay(52 * MIN + 30 * SEC)).toBe(30 * SEC + 1 + TICK_SLACK_MS);
    expect(delay(52 * MIN + 500)).toBe(MIN_TICK_MS);
    expect(delay(10 * SEC)).toBe(MIN_TICK_MS);
    expect(delay(3 * DAY + 30 * MIN)).toBe(MAX_TICK_MS);
    expect(delay(3 * DAY)).toBe(MIN_TICK_MS); // 1 ms before "3d" turns into "2d 23h"
    expect(delay(52 * MIN + 59 * SEC + 900)).toBe(MAX_TICK_MS);
    expect(delay(-MIN)).toBe(MAX_TICK_MS);
  });
});

describe("deadlineSummaryText", () => {
  it("joins when and how long", () => {
    expect(deadlineSummaryText(d("2026-11-02T04:59:00Z"), d("2026-10-26T14:00:00Z"), NY)).toBe(
      "Ends Sun 11:59 PM · 6d 14h",
    );
    expect(deadlineSummaryText(d("2026-10-27T07:00:00Z"), d("2026-10-26T22:00:00Z"), NY)).toBe(
      "Ends tonight 3:00 AM · 9h",
    );
    expect(deadlineSummaryText(d("2026-10-27T07:00:00Z"), d("2026-10-26T14:00:00Z"), NY)).toBe(
      "Ends tomorrow 3:00 AM · 17h",
    );
    expect(deadlineSummaryText(d("2026-10-26T18:00:00Z"), d("2026-10-26T17:07:30Z"), NY)).toBe(
      "Ends today 2:00 PM · 52m",
    );
  });

  it("says Ended once passed", () => {
    const now = d("2026-10-26T14:00:00Z");
    expect(deadlineSummaryText(now, now, NY)).toBe("Ended");
  });
});
