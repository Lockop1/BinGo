import { afterEach, describe, expect, it } from "vitest";
import {
  SAMPLE_MAX_AGE_MS,
  SKEW_MIN_MS,
  __resetServerClockForTests,
  effectiveOffsetMs,
  measureSample,
  noteServerTime,
  pickSample,
  serverNow,
  serverOffsetMs,
  subscribeServerClock,
} from "@/lib/game/serverClock";

const T = Date.parse("2026-10-27T21:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

afterEach(() => __resetServerClockForTests());

describe("measureSample", () => {
  it("puts the server stamp at the round trip's midpoint", () => {
    expect(measureSample(iso(T + 5_050), T, T + 100)).toEqual({ offsetMs: 5_000, rttMs: 100, at: T + 100 });
    expect(measureSample(iso(T + 50), T, T + 100)).toEqual({ offsetMs: 0, rttMs: 100, at: T + 100 });
  });

  it("ignores unparseable stamps and backwards round trips", () => {
    expect(measureSample("nope", T, T + 100)).toBeNull();
    expect(measureSample(iso(T), T + 100, T)).toBeNull();
  });
});

describe("pickSample / effectiveOffsetMs", () => {
  it("keeps the shortest round trip, unless the held sample is stale", () => {
    const precise = { offsetMs: 2_000, rttMs: 40, at: T };
    const sloppy = { offsetMs: 2_400, rttMs: 600, at: T + 1_000 };
    expect(pickSample(null, sloppy)).toBe(sloppy);
    expect(pickSample(precise, sloppy)).toBe(precise);
    expect(pickSample(sloppy, precise)).toBe(precise);
    const later = { ...sloppy, at: T + SAMPLE_MAX_AGE_MS + 1 };
    expect(pickSample(precise, later)).toBe(later);
  });

  it("corrects only a skew clearly beyond the measurement's own uncertainty", () => {
    expect(effectiveOffsetMs(null)).toBe(0);
    expect(effectiveOffsetMs({ offsetMs: 120, rttMs: 30, at: T })).toBe(0);
    expect(effectiveOffsetMs({ offsetMs: SKEW_MIN_MS + 60, rttMs: 200, at: T })).toBe(0);
    expect(effectiveOffsetMs({ offsetMs: SKEW_MIN_MS + 60, rttMs: 20, at: T })).toBe(SKEW_MIN_MS + 60);
    expect(effectiveOffsetMs({ offsetMs: -3_000, rttMs: 200, at: T })).toBe(-3_000);
  });
});

describe("the phone's estimate", () => {
  it("starts at zero, moves on a clear skew and tells its subscribers", () => {
    expect(serverOffsetMs()).toBe(0);
    let calls = 0;
    const off = subscribeServerClock(() => calls++);
    noteServerTime(iso(T + 30), T, T + 40); // ~10 ms: noise
    expect(serverOffsetMs()).toBe(0);
    expect(calls).toBe(0);
    noteServerTime(iso(T + 2_520), T, T + 40); // the server is 2.5 s ahead
    expect(serverOffsetMs()).toBe(2_500);
    expect(calls).toBe(1);
    expect(Math.abs(serverNow() - (Date.now() + 2_500))).toBeLessThan(50);
    off();
    noteServerTime(null, T, T + 1);
    noteServerTime(undefined, T, T + 1);
    expect(serverOffsetMs()).toBe(2_500);
  });
});
