import { describe, expect, it } from "vitest";
import { EXTEND_MAX_MS, EXTEND_QUICK, extendBy, extendInputBounds, validateExtension } from "@/lib/deadline/extend";

const current = new Date("2026-10-26T03:00:30.500Z");
const plus = (ms: number) => new Date(current.getTime() + ms);

describe("extend helpers", () => {
  it("offers +1 hour, +3 hours and +24 hours, never past the one-day cap", () => {
    expect(EXTEND_QUICK.map((q) => q.label)).toEqual(["+1 hour", "+3 hours", "+24 hours"]);
    for (const q of EXTEND_QUICK) expect(validateExtension(current, extendBy(current, q.ms))).toBe("ok");
    expect(extendBy(current, 3_600_000).toISOString()).toBe("2026-10-26T04:00:30.500Z");
    expect(extendBy(current, 2 * EXTEND_MAX_MS).getTime()).toBe(current.getTime() + EXTEND_MAX_MS);
  });

  it("accepts 1 minute to 24 hours later", () => {
    expect(validateExtension(current, plus(59_999))).toBe("too_soon");
    expect(validateExtension(current, plus(60_000))).toBe("ok");
    expect(validateExtension(current, plus(EXTEND_MAX_MS))).toBe("ok");
    expect(validateExtension(current, plus(EXTEND_MAX_MS + 1))).toBe("too_far");
    expect(validateExtension(current, plus(-60_000))).toBe("too_soon");
    expect(validateExtension(current, new Date(Number.NaN))).toBe("too_soon");
  });

  it("bounds the custom input to whole minutes inside the window", () => {
    expect(extendInputBounds(current, "UTC")).toEqual({ min: "2026-10-26T03:02", max: "2026-10-27T03:00" });
    expect(extendInputBounds(current, "America/New_York")).toEqual({ min: "2026-10-25T23:02", max: "2026-10-26T23:00" });
  });
});
