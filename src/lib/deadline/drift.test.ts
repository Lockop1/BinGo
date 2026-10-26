import { describe, expect, it } from "vitest";
import {
  deadlineBlockMessage,
  presetRefreshNotice,
  refreshDriftedPreset,
  tooSoonFromMs,
  wakeDelayMs,
} from "@/lib/deadline/drift";
import { DEADLINE_MAX_MS, computePreset, validateDeadline } from "@/lib/deadline/presets";

// Explicit UTC instants; New York is UTC−4 (EDT) on these October dates.
const NY = "America/New_York";
const d = (iso: string) => new Date(iso);

describe("tooSoonFromMs", () => {
  it("is the first millisecond at which the value is under 10 minutes away", () => {
    const value = d("2026-10-26T07:00:00.000Z"); // 3:00 AM in New York
    const from = tooSoonFromMs(value);
    expect(new Date(from).toISOString()).toBe("2026-10-26T06:50:00.001Z");
    expect(validateDeadline(value, new Date(from))).toBe("too_soon");
    expect(validateDeadline(value, new Date(from - 1))).toBe("ok");
  });
});

describe("wakeDelayMs", () => {
  it("wakes at the due moment when it comes before the next tick, else on the interval", () => {
    const now = Date.parse("2026-10-26T06:49:40Z");
    const due = tooSoonFromMs(d("2026-10-26T07:00:00Z")); // 06:50:00.001
    expect(wakeDelayMs(60_000, due, now)).toBe(20_001);
    expect(wakeDelayMs(15_000, due, now)).toBe(15_000);
    expect(wakeDelayMs(15_000, due, now + 15_000)).toBe(5_001);
  });

  it("ticks on the interval with no due moment or once it has passed", () => {
    expect(wakeDelayMs(60_000, null, 0)).toBe(60_000);
    expect(wakeDelayMs(60_000, 1_000, 1_000)).toBe(60_000);
    expect(wakeDelayMs(60_000, 1_000, 5_000)).toBe(60_000);
  });
});

describe("refreshDriftedPreset", () => {
  // The verifier's run (VERIFICATION.md P25): Tonight picked at 02:49:40.
  const tonight = computePreset("tonight", d("2026-10-26T06:49:40Z"), NY);

  it("leaves a preset alone while it is still 10 minutes or more away", () => {
    expect(tonight.toISOString()).toBe("2026-10-26T07:00:00.000Z");
    expect(refreshDriftedPreset("tonight", tonight, d("2026-10-26T06:49:41Z"), NY)).toBeNull();
    expect(refreshDriftedPreset("tonight", tonight, d("2026-10-26T06:50:00Z"), NY)).toBeNull(); // exactly 10 min
  });

  it("re-resolves a drifted Tonight to the next 3 AM", () => {
    const fresh = refreshDriftedPreset("tonight", tonight, d("2026-10-26T06:50:00.001Z"), NY);
    expect(fresh?.toISOString()).toBe("2026-10-27T07:00:00.000Z");
    expect(validateDeadline(fresh!, d("2026-10-26T06:50:00.001Z"))).toBe("ok");
  });

  it("re-resolves a drifted weekend (Sunday 23:59) to next weekend, clamped to 7 days", () => {
    const sunday = d("2026-10-26T03:40:00Z"); // Sun Oct 25, 11:40 PM
    const weekend = computePreset("weekend", sunday, NY);
    expect(weekend.toISOString()).toBe("2026-10-26T03:59:00.000Z");
    const later = d("2026-10-26T03:49:30Z"); // 9.5 minutes before 11:59 PM
    const fresh = refreshDriftedPreset("weekend", weekend, later, NY);
    expect(fresh?.getTime()).toBe(later.getTime() + DEADLINE_MAX_MS);
  });

  it("re-resolves a drifted 24 hours to 24 hours from now", () => {
    const picked = d("2026-10-25T06:00:00Z");
    const day = computePreset("day", picked, NY);
    const now = d("2026-10-26T05:55:00Z");
    expect(refreshDriftedPreset("day", day, now, NY)?.toISOString()).toBe("2026-10-27T05:55:00.000Z");
  });

  it("never touches Custom, a missing value or a missing preset", () => {
    const now = d("2026-10-26T06:55:00Z");
    expect(refreshDriftedPreset("custom", tonight, now, NY)).toBeNull();
    expect(refreshDriftedPreset("tonight", null, now, NY)).toBeNull();
    expect(refreshDriftedPreset(null, tonight, now, NY)).toBeNull();
  });

  it("re-resolves a value that has already passed (the phone slept through it)", () => {
    const fresh = refreshDriftedPreset("tonight", tonight, d("2026-10-26T08:00:00Z"), NY);
    expect(fresh?.toISOString()).toBe("2026-10-27T07:00:00.000Z");
  });
});

describe("copy", () => {
  it("names the preset it moved to and why, on one line", () => {
    expect(presetRefreshNotice("tonight")).toBe(
      "Updated to the next 3 AM — the earlier time is less than 10 minutes away",
    );
    expect(presetRefreshNotice("day")).toBe("Updated to 24 hours from now — the earlier time is less than 10 minutes away");
    expect(presetRefreshNotice("weekend")).toBe("Updated to the next weekend — the earlier time is less than 10 minutes away");
    for (const preset of ["tonight", "day", "weekend"] as const) expect(presetRefreshNotice(preset)).not.toContain("\n");
  });

  it("explains a deadline that blocks Create, and nothing otherwise", () => {
    expect(deadlineBlockMessage("too_soon")).toMatch(/less than 10 minutes away/);
    expect(deadlineBlockMessage("too_far")).toMatch(/more than 7 days away/);
    expect(deadlineBlockMessage("ok")).toBeNull();
    expect(deadlineBlockMessage(null)).toBeNull();
  });
});
