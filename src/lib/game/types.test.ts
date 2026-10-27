import { describe, expect, it } from "vitest";
import { countdownEndsAt, countdownSecondsLeft, endReason, isInCountdown } from "@/lib/game/types";

const NOW = Date.parse("2026-10-27T21:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function live(countdown: number | null, deadline = NOW + 3_600_000) {
  return {
    status: "active" as const,
    deadline_at: iso(deadline),
    countdown_ends_at: countdown === null ? null : iso(countdown),
  };
}

describe("start countdown", () => {
  it("is on while the server's countdown_ends_at is ahead, off from that instant", () => {
    expect(isInCountdown(live(NOW + 4_200), new Date(NOW))).toBe(true);
    expect(isInCountdown(live(NOW + 1), new Date(NOW))).toBe(true);
    expect(isInCountdown(live(NOW), new Date(NOW))).toBe(false);
    expect(isInCountdown(live(NOW - 1), new Date(NOW))).toBe(false);
  });

  it("never applies to a lobby, an ended game, a game past its deadline, or one without the column", () => {
    expect(isInCountdown({ ...live(NOW + 4_000), status: "lobby" }, new Date(NOW))).toBe(false);
    expect(isInCountdown({ ...live(NOW + 4_000), status: "ended" }, new Date(NOW))).toBe(false);
    expect(isInCountdown(live(NOW + 4_000, NOW - 1), new Date(NOW))).toBe(false);
    expect(isInCountdown(live(null), new Date(NOW))).toBe(false);
    expect(isInCountdown({ status: "active", deadline_at: iso(NOW + 60_000) }, new Date(NOW))).toBe(false);
    expect(isInCountdown({ ...live(null), countdown_ends_at: "not a time" }, new Date(NOW))).toBe(false);
  });

  it("counts whole seconds down to the stamp: 5, 4, 3, 2, 1, then 0", () => {
    const game = live(NOW + 5_000);
    expect(countdownSecondsLeft(game, NOW)).toBe(5);
    expect(countdownSecondsLeft(game, NOW + 1)).toBe(5);
    expect(countdownSecondsLeft(game, NOW + 1_000)).toBe(4);
    expect(countdownSecondsLeft(game, NOW + 4_001)).toBe(1);
    expect(countdownSecondsLeft(game, NOW + 5_000)).toBe(0);
    expect(countdownSecondsLeft(game, NOW + 60_000)).toBe(0);
    expect(countdownSecondsLeft(live(null), NOW)).toBe(0);
  });

  it("reads the column defensively", () => {
    expect(countdownEndsAt({})).toBeNull();
    expect(countdownEndsAt({ countdown_ends_at: null })).toBeNull();
    expect(countdownEndsAt({ countdown_ends_at: "2026-10-27T21:00:05.123456+00:00" })).toBe("2026-10-27T21:00:05.123456+00:00");
  });
});

describe("endReason", () => {
  it("knows host, deadline and blackout; anything else (or nothing) is null", () => {
    expect(endReason({ end_reason: "host" })).toBe("host");
    expect(endReason({ end_reason: "deadline" })).toBe("deadline");
    expect(endReason({ end_reason: "blackout" })).toBe("blackout");
    expect(endReason({ end_reason: "bored" })).toBeNull();
    expect(endReason({ end_reason: null })).toBeNull();
    expect(endReason({})).toBeNull();
  });
});
