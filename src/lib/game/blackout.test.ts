import { describe, expect, it } from "vitest";
import { blackoutFinisher } from "@/lib/game/blackout";
import { JAKE, ME, board, completedBy, stamp } from "@/lib/game/testFixtures";

const full = () => {
  const squares = board(Object.fromEntries(Array.from({ length: 25 }, (_, p) => [p, completedBy(p === 12 ? null : JAKE, p + 1)])));
  squares[24] = { ...squares[24], ...completedBy(ME, 40) };
  return squares;
};

describe("blackoutFinisher", () => {
  it("names whoever crossed off the square that ended the game (completed_at = ended_at)", () => {
    expect(blackoutFinisher({ end_reason: "blackout", ended_at: stamp(40) }, full())).toBe(ME);
    // The same instant written with an offset still matches (µs precision).
    expect(blackoutFinisher({ end_reason: "blackout", ended_at: "2026-10-23T23:00:00.000040+02:00" }, full())).toBe(ME);
  });

  it("is null for other ends, a missing end time, or rows that do not line up yet", () => {
    expect(blackoutFinisher({ end_reason: "host", ended_at: stamp(40) }, full())).toBeNull();
    expect(blackoutFinisher({ end_reason: "blackout", ended_at: null }, full())).toBeNull();
    expect(blackoutFinisher({ end_reason: "blackout", ended_at: stamp(41) }, full())).toBeNull();
    expect(blackoutFinisher({ ended_at: stamp(40) }, full())).toBeNull();
  });
});
