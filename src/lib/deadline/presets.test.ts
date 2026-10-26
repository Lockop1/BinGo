import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEADLINE_MAX_MS,
  DEADLINE_MIN_MS,
  clampDeadline,
  computePreset,
  customInputBounds,
  defaultTimeZone,
  fromIso,
  isValidTimeZone,
  localInputValue,
  matchPreset,
  parseLocalInput,
  resolveTimeZone,
  toIso,
  validateDeadline,
  zonedParts,
  zonedTimeToInstant,
} from "@/lib/deadline/presets";

// Every expectation is an explicit UTC instant, so nothing depends on the
// process time zone. 2026 transitions used below:
//   America/New_York  spring forward Sun Mar 8 02:00 EST → 03:00 EDT; fall back Sun Nov 1 02:00 EDT → 01:00 EST
//   Europe/London     spring forward Sun Mar 29 01:00 GMT → 02:00 BST; fall back Sun Oct 25 02:00 BST → 01:00 GMT
//   Pacific/Auckland  fall back Sun Apr 5 03:00 NZDT → 02:00 NZST; spring forward Sun Sep 27 02:00 NZST → 03:00 NZDT
//   Asia/Kolkata      UTC+05:30 all year
const NY = "America/New_York";
const LDN = "Europe/London";
const AKL = "Pacific/Auckland";
const KOL = "Asia/Kolkata";

const d = (iso: string) => new Date(iso);
const iso = (date: Date) => date.toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("constants", () => {
  it("are 10 minutes and 7 days", () => {
    expect(DEADLINE_MIN_MS).toBe(10 * MIN);
    expect(DEADLINE_MAX_MS).toBe(7 * DAY);
  });
});

describe("zonedTimeToInstant", () => {
  it("converts ordinary wall times", () => {
    expect(iso(zonedTimeToInstant({ year: 2026, month: 10, day: 26, hour: 20, minute: 0 }, NY))).toBe(
      "2026-10-27T00:00:00.000Z",
    );
    expect(iso(zonedTimeToInstant({ year: 2026, month: 10, day: 26, hour: 20, minute: 0 }, KOL))).toBe(
      "2026-10-26T14:30:00.000Z",
    );
    expect(iso(zonedTimeToInstant({ year: 2026, month: 1, day: 15, hour: 9, minute: 30, second: 15 }, AKL))).toBe(
      "2026-01-14T20:30:15.000Z",
    );
    expect(iso(zonedTimeToInstant({ year: 2026, month: 6, day: 1, hour: 0, minute: 0 }, "UTC"))).toBe(
      "2026-06-01T00:00:00.000Z",
    );
  });

  it("pushes a spring-forward gap time forward by the gap", () => {
    // 02:30 does not exist; it becomes 03:30 EDT / 02:30 BST / 03:30 NZDT.
    expect(iso(zonedTimeToInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NY))).toBe(
      "2026-03-08T07:30:00.000Z",
    );
    expect(iso(zonedTimeToInstant({ year: 2026, month: 3, day: 29, hour: 1, minute: 30 }, LDN))).toBe(
      "2026-03-29T01:30:00.000Z",
    );
    expect(iso(zonedTimeToInstant({ year: 2026, month: 9, day: 27, hour: 2, minute: 30 }, AKL))).toBe(
      "2026-09-26T14:30:00.000Z",
    );
  });

  it("resolves a fall-back overlap to the first occurrence", () => {
    expect(iso(zonedTimeToInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, NY))).toBe(
      "2026-11-01T05:30:00.000Z", // 01:30 EDT, not 01:30 EST (06:30Z)
    );
    expect(iso(zonedTimeToInstant({ year: 2026, month: 10, day: 25, hour: 1, minute: 30 }, LDN))).toBe(
      "2026-10-25T00:30:00.000Z", // 01:30 BST
    );
    expect(iso(zonedTimeToInstant({ year: 2026, month: 4, day: 5, hour: 2, minute: 30 }, AKL))).toBe(
      "2026-04-04T13:30:00.000Z", // 02:30 NZDT
    );
  });

  it("round-trips through zonedParts", () => {
    const p = zonedParts(d("2026-11-01T06:30:00Z"), NY); // second 01:30 (EST)
    expect(p).toMatchObject({ year: 2026, month: 11, day: 1, hour: 1, minute: 30, weekday: 0 });
    expect(zonedParts(d("2026-10-26T04:00:00Z"), NY)).toMatchObject({ hour: 0, weekday: 1 }); // midnight is 0, not 24
  });
});

describe("computePreset: tonight", () => {
  // Mon Oct 26 2026 is EDT (UTC-4).
  it.each([
    ["00:30 → today 3:00", "2026-10-26T04:30:00Z", "2026-10-26T07:00:00.000Z"],
    ["02:50 (exactly 10 min) → today 3:00", "2026-10-26T06:50:00Z", "2026-10-26T07:00:00.000Z"],
    ["02:55 → tomorrow 3:00", "2026-10-26T06:55:00Z", "2026-10-27T07:00:00.000Z"],
    ["03:00 → tomorrow 3:00", "2026-10-26T07:00:00Z", "2026-10-27T07:00:00.000Z"],
    ["12:00 → tomorrow 3:00", "2026-10-26T16:00:00Z", "2026-10-27T07:00:00.000Z"],
    ["23:00 → next day 3:00", "2026-10-27T03:00:00Z", "2026-10-27T07:00:00.000Z"],
  ])("%s (New York)", (_label, now, expected) => {
    expect(iso(computePreset("tonight", d(now), NY))).toBe(expected);
  });

  it("follows the given zone, not the process zone", () => {
    const now = d("2026-10-26T14:30:00Z"); // 20:00 IST, 10:30 EDT, 03:30 NZDT (Oct 27)
    expect(iso(computePreset("tonight", now, KOL))).toBe("2026-10-26T21:30:00.000Z"); // Oct 27 03:00 IST
    expect(iso(computePreset("tonight", now, NY))).toBe("2026-10-27T07:00:00.000Z");
    expect(iso(computePreset("tonight", now, AKL))).toBe("2026-10-27T14:00:00.000Z"); // Oct 28 03:00 NZDT
    expect(iso(computePreset("tonight", now, "UTC"))).toBe("2026-10-27T03:00:00.000Z");
  });

  it("handles spring-forward nights", () => {
    // Sat Mar 7 23:00 EST → Sun Mar 8 03:00 EDT, only 3 real hours later.
    expect(iso(computePreset("tonight", d("2026-03-08T04:00:00Z"), NY))).toBe("2026-03-08T07:00:00.000Z");
    // 01:55 EST, 5 real minutes before the jump: 03:00 EDT is still 5 minutes away → tomorrow.
    expect(iso(computePreset("tonight", d("2026-03-08T06:55:00Z"), NY))).toBe("2026-03-09T07:00:00.000Z");
    // 01:45 EST: 03:00 EDT is 15 real minutes away → tonight.
    expect(iso(computePreset("tonight", d("2026-03-08T06:45:00Z"), NY))).toBe("2026-03-08T07:00:00.000Z");
    // Sat Mar 28 22:00 GMT → Sun Mar 29 03:00 BST.
    expect(iso(computePreset("tonight", d("2026-03-28T22:00:00Z"), LDN))).toBe("2026-03-29T02:00:00.000Z");
    // Sat Sep 26 22:00 NZST → Sun Sep 27 03:00 NZDT.
    expect(iso(computePreset("tonight", d("2026-09-26T10:00:00Z"), AKL))).toBe("2026-09-26T14:00:00.000Z");
  });

  it("handles fall-back nights", () => {
    // Sat Oct 31 23:00 EDT → Sun Nov 1 03:00 EST, 5 real hours later.
    expect(iso(computePreset("tonight", d("2026-11-01T03:00:00Z"), NY))).toBe("2026-11-01T08:00:00.000Z");
    // Second 01:30 (EST) → 03:00 EST the same morning.
    expect(iso(computePreset("tonight", d("2026-11-01T06:30:00Z"), NY))).toBe("2026-11-01T08:00:00.000Z");
    // Sat Oct 24 22:00 BST → Sun Oct 25 03:00 GMT.
    expect(iso(computePreset("tonight", d("2026-10-24T21:00:00Z"), LDN))).toBe("2026-10-25T03:00:00.000Z");
    // Sat Apr 4 22:00 NZDT → Sun Apr 5 03:00 NZST (the hour the clocks went back at).
    expect(iso(computePreset("tonight", d("2026-04-04T09:00:00Z"), AKL))).toBe("2026-04-04T15:00:00.000Z");
  });
});

describe("computePreset: day", () => {
  it("is exactly 24 real hours, even across DST", () => {
    const now = d("2026-03-07T17:00:00.123Z");
    expect(computePreset("day", now, NY).getTime() - now.getTime()).toBe(DAY);
    expect(computePreset("day", now, AKL).getTime() - now.getTime()).toBe(DAY);
  });
});

describe("computePreset: weekend", () => {
  // Sun Oct 25 2026 and Sun Nov 1 2026 (US fall-back day).
  it.each([
    ["Sunday 22:00 → today 23:59", "2026-10-26T02:00:00Z", "2026-10-26T03:59:00.000Z"],
    ["Sunday 23:49 (exactly 10 min) → today", "2026-10-26T03:49:00Z", "2026-10-26T03:59:00.000Z"],
    ["Monday 01:00 → Sunday Nov 1 23:59 EST", "2026-10-26T05:00:00Z", "2026-11-02T04:59:00.000Z"],
    ["Saturday 12:00 → tomorrow 23:59 EST", "2026-10-31T16:00:00Z", "2026-11-02T04:59:00.000Z"],
    ["Wednesday noon → Sunday", "2026-10-28T16:00:00Z", "2026-11-02T04:59:00.000Z"],
  ])("%s (New York)", (_label, now, expected) => {
    expect(iso(computePreset("weekend", d(now), NY))).toBe(expected);
  });

  it("clamps Sunday 23:55 → next Sunday to 7 days out", () => {
    const now = d("2026-10-26T03:55:00Z"); // Sun Oct 25 23:55 EDT
    expect(iso(computePreset("weekend", now, NY))).toBe(iso(new Date(now.getTime() + DEADLINE_MAX_MS)));
  });

  it("clamps when a fall-back hour pushes next Sunday past 7 days", () => {
    // Mon Oct 26 00:00 EDT → Sun Nov 1 23:59 EST is 7 d 0 h 59 m away.
    const now = d("2026-10-26T04:00:00Z");
    expect(computePreset("weekend", now, NY).getTime() - now.getTime()).toBe(DEADLINE_MAX_MS);
  });

  it("uses each zone's Sunday", () => {
    const now = d("2026-10-25T20:00:00Z"); // Sun 16:00 EDT, Mon 01:30 IST, Mon 09:00 NZDT, Sun 20:00 GMT
    expect(iso(computePreset("weekend", now, NY))).toBe("2026-10-26T03:59:00.000Z");
    expect(iso(computePreset("weekend", now, LDN))).toBe("2026-10-25T23:59:00.000Z");
    expect(iso(computePreset("weekend", now, KOL))).toBe("2026-11-01T18:29:00.000Z");
    expect(iso(computePreset("weekend", now, AKL))).toBe("2026-11-01T10:59:00.000Z");
  });

  it("lands on 23:59 GMT on London's fall-back Sunday", () => {
    expect(iso(computePreset("weekend", d("2026-10-19T11:00:00Z"), LDN))).toBe("2026-10-25T23:59:00.000Z");
  });

  it("is always valid", () => {
    for (let h = 0; h < 24 * 8; h += 1) {
      const now = new Date(Date.UTC(2026, 9, 24) + h * HOUR + 7 * MIN);
      for (const zone of [NY, LDN, AKL, KOL]) {
        expect(validateDeadline(computePreset("weekend", now, zone), now)).toBe("ok");
        expect(validateDeadline(computePreset("tonight", now, zone), now)).toBe("ok");
        expect(validateDeadline(computePreset("day", now, zone), now)).toBe("ok");
      }
    }
  });
});

describe("validateDeadline / clampDeadline", () => {
  const now = d("2026-10-26T12:00:00Z");
  const plus = (ms: number) => new Date(now.getTime() + ms);

  it("accepts 10 minutes to 7 days inclusive", () => {
    expect(validateDeadline(plus(DEADLINE_MIN_MS), now)).toBe("ok");
    expect(validateDeadline(plus(DEADLINE_MAX_MS), now)).toBe("ok");
    expect(validateDeadline(plus(DAY), now)).toBe("ok");
  });

  it("rejects too soon, passed and invalid", () => {
    expect(validateDeadline(plus(DEADLINE_MIN_MS - 1), now)).toBe("too_soon");
    expect(validateDeadline(plus(-HOUR), now)).toBe("too_soon");
    expect(validateDeadline(new Date(Number.NaN), now)).toBe("too_soon");
  });

  it("rejects too far", () => {
    expect(validateDeadline(plus(DEADLINE_MAX_MS + 1), now)).toBe("too_far");
  });

  it("clamps into range", () => {
    expect(clampDeadline(plus(MIN), now).getTime()).toBe(now.getTime() + DEADLINE_MIN_MS);
    expect(clampDeadline(plus(30 * DAY), now).getTime()).toBe(now.getTime() + DEADLINE_MAX_MS);
    expect(clampDeadline(plus(HOUR), now).getTime()).toBe(now.getTime() + HOUR);
    expect(clampDeadline(new Date(Number.NaN), now).getTime()).toBe(now.getTime() + DEADLINE_MIN_MS);
  });
});

describe("toIso / fromIso", () => {
  it("round-trips", () => {
    const date = d("2026-10-26T12:34:56.789Z");
    expect(toIso(date)).toBe("2026-10-26T12:34:56.789Z");
    expect(fromIso(toIso(date))?.getTime()).toBe(date.getTime());
    expect(fromIso("2026-10-26T08:00:00-04:00")?.toISOString()).toBe("2026-10-26T12:00:00.000Z");
    expect(fromIso("2026-10-26T12:00:00.123456+00:00")?.toISOString()).toBe("2026-10-26T12:00:00.123Z"); // Postgres µs
  });

  it("returns null for missing or bad input", () => {
    expect(fromIso(null)).toBeNull();
    expect(fromIso(undefined)).toBeNull();
    expect(fromIso("")).toBeNull();
    expect(fromIso("not a date")).toBeNull();
  });
});

describe("matchPreset", () => {
  const now = d("2026-10-26T16:00:00Z"); // Mon 12:00 EDT

  it("finds the preset that produced a value", () => {
    for (const kind of ["tonight", "day", "weekend"] as const) {
      expect(matchPreset(computePreset(kind, now, NY), now, NY)).toBe(kind);
    }
  });

  it("still matches a little later, within a minute", () => {
    const day = computePreset("day", now, NY);
    expect(matchPreset(day, new Date(now.getTime() + 59_000), NY)).toBe("day");
    expect(matchPreset(day, new Date(now.getTime() + 5 * MIN), NY)).toBe("custom");
    // Tonight / weekend do not depend on the exact minute.
    expect(matchPreset(computePreset("tonight", now, NY), new Date(now.getTime() + 3 * HOUR), NY)).toBe("tonight");
  });

  it("falls back to custom", () => {
    expect(matchPreset(d("2026-10-28T00:00:00Z"), now, NY)).toBe("custom");
    expect(matchPreset(new Date(Number.NaN), now, NY)).toBe("custom");
  });

  it("depends on the zone", () => {
    const tonightNy = computePreset("tonight", now, NY);
    expect(matchPreset(tonightNy, now, KOL)).toBe("custom");
  });

  it("prefers tonight when tonight and 24 hours coincide", () => {
    const at3 = d("2026-10-26T07:00:00Z"); // 03:00 EDT: tonight = tomorrow 3:00 = now + 24 h
    expect(matchPreset(computePreset("day", at3, NY), at3, NY)).toBe("tonight");
  });
});

describe("datetime-local round trip", () => {
  it("formats in the zone", () => {
    const date = d("2026-10-26T14:30:45Z");
    expect(localInputValue(date, NY)).toBe("2026-10-26T10:30");
    expect(localInputValue(date, KOL)).toBe("2026-10-26T20:00");
    expect(localInputValue(date, AKL)).toBe("2026-10-27T03:30");
    expect(localInputValue(date, LDN)).toBe("2026-10-26T14:30");
  });

  it("parses in the zone", () => {
    expect(parseLocalInput("2026-10-26T10:30", NY)?.toISOString()).toBe("2026-10-26T14:30:00.000Z");
    expect(parseLocalInput("2026-10-26T20:00", KOL)?.toISOString()).toBe("2026-10-26T14:30:00.000Z");
    expect(parseLocalInput("2026-10-26T10:30:15", NY)?.toISOString()).toBe("2026-10-26T14:30:15.000Z");
    expect(parseLocalInput(" 2026-10-26T10:30:15.250 ", NY)?.toISOString()).toBe("2026-10-26T14:30:15.000Z");
  });

  it("round-trips every half hour across DST days in each zone", () => {
    const cases: [string, number, number, number][] = [
      [NY, 2026, 3, 8],
      [NY, 2026, 11, 1],
      [LDN, 2026, 3, 29],
      [LDN, 2026, 10, 25],
      [AKL, 2026, 4, 5],
      [AKL, 2026, 9, 27],
      [KOL, 2026, 10, 26],
    ];
    for (const [zone, y, m, day] of cases) {
      const start = Date.UTC(y, m - 1, day) - DAY;
      for (let t = start; t < start + 2 * DAY; t += 30 * MIN) {
        const text = localInputValue(new Date(t), zone);
        const back = parseLocalInput(text, zone);
        expect(back).not.toBeNull();
        // Same wall text again; and the same instant except for the repeated
        // fall-back hour, whose second occurrence parses as the first.
        expect(localInputValue(back as Date, zone)).toBe(text);
        expect([0, HOUR]).toContain(t - (back as Date).getTime());
      }
    }
  });

  it("moves gap times forward and picks the first of repeated times", () => {
    expect(parseLocalInput("2026-03-08T02:30", NY)?.toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(localInputValue(parseLocalInput("2026-03-08T02:30", NY) as Date, NY)).toBe("2026-03-08T03:30");
    expect(parseLocalInput("2026-11-01T01:30", NY)?.toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("rejects malformed or impossible values", () => {
    for (const bad of [
      "",
      "abc",
      "2026-10-26",
      "2026-10-26 10:30",
      "2026-13-01T10:00",
      "2026-00-10T10:00",
      "2026-02-29T10:00", // not a leap year
      "2026-04-31T10:00",
      "2026-10-26T24:00",
      "2026-10-26T10:60",
      "2026-10-26T10:30:61",
    ]) {
      expect(parseLocalInput(bad, NY)).toBeNull();
    }
    expect(parseLocalInput("2028-02-29T10:00", NY)).not.toBeNull();
  });

  it("gives min / max bounds on whole minutes inside the range", () => {
    const now = d("2026-10-26T14:30:30Z"); // 10:30:30 EDT
    expect(customInputBounds(now, NY)).toEqual({ min: "2026-10-26T10:41", max: "2026-11-02T09:30" }); // EST by then
    const bounds = customInputBounds(now, NY);
    expect(validateDeadline(parseLocalInput(bounds.min, NY) as Date, now)).toBe("ok");
    expect(validateDeadline(parseLocalInput(bounds.max, NY) as Date, now)).toBe("ok");
    expect(customInputBounds(d("2026-10-26T14:30:00Z"), KOL)).toEqual({ min: "2026-10-26T20:10", max: "2026-11-02T20:00" });
  });
});

describe("time zone helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("validates zone names", () => {
    expect(isValidTimeZone(NY)).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });

  it("defaultTimeZone returns a usable zone", () => {
    expect(isValidTimeZone(defaultTimeZone())).toBe(true);
  });

  it("defaultTimeZone falls back to UTC when Intl cannot tell", () => {
    const Real = Intl.DateTimeFormat;
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (this: unknown, ...args: unknown[]) {
      if (args.length === 0) {
        return { resolvedOptions: () => ({ timeZone: undefined }) } as unknown as Intl.DateTimeFormat;
      }
      return new Real(...(args as ConstructorParameters<typeof Intl.DateTimeFormat>));
    } as unknown as typeof Intl.DateTimeFormat);
    expect(defaultTimeZone()).toBe("UTC");
  });

  it("defaultTimeZone falls back to UTC when Intl throws", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation((() => {
      throw new Error("no Intl");
    }) as unknown as typeof Intl.DateTimeFormat);
    expect(defaultTimeZone()).toBe("UTC");
  });

  it("resolveTimeZone keeps valid zones and replaces bad ones", () => {
    expect(resolveTimeZone(AKL)).toBe(AKL);
    expect(resolveTimeZone("Nope/Nope")).toBe(defaultTimeZone());
    expect(resolveTimeZone(undefined)).toBe(defaultTimeZone());
  });
});
