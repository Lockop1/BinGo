import { describe, expect, it } from "vitest";
import { codeFromInput, homeJoinOutcome } from "@/components/home/homeJoin";
import type { GamePreview } from "@/lib/game/types";

const preview = (over: Partial<GamePreview> = {}): GamePreview => ({
  name: "Friday",
  status: "lobby",
  player_count: 3,
  free_center: true,
  ...over,
});

describe("codeFromInput", () => {
  it("upper-cases and drops spaces and dashes", () => {
    expect(codeFromInput("abcd-efgh")).toBe("ABCDEFGH");
    expect(codeFromInput("  abcd efgh ")).toBe("ABCDEFGH");
    expect(codeFromInput("AbCd - 2345")).toBe("ABCD2345");
  });

  it("takes the code out of a pasted invite link", () => {
    expect(codeFromInput("https://bingo.example/g/ABCD-2345")).toBe("ABCD2345");
    expect(codeFromInput("Join us: https://bingo.example/g/abcd2345?x=1")).toBe("ABCD2345");
  });
});

describe("homeJoinOutcome", () => {
  it("is not found for codes that are not 8 characters", () => {
    expect(homeJoinOutcome("ABC", preview(), false)).toBe("game_not_found");
    expect(homeJoinOutcome("ABCD23456", preview(), false)).toBe("game_not_found");
    expect(homeJoinOutcome("ABCD2345", null, false)).toBe("game_not_found");
  });

  it("goes on for an open lobby or live game", () => {
    expect(homeJoinOutcome("ABCD2345", preview(), false)).toBe("go");
    expect(homeJoinOutcome("ABCD2345", preview({ status: "active", player_count: 9 }), false)).toBe("go");
  });

  it("stops at an ended game, then a full one", () => {
    expect(homeJoinOutcome("ABCD2345", preview({ status: "ended" }), false)).toBe("game_ended");
    expect(homeJoinOutcome("ABCD2345", preview({ status: "ended", player_count: 10 }), false)).toBe("game_ended");
    expect(homeJoinOutcome("ABCD2345", preview({ player_count: 10 }), false)).toBe("game_full");
  });

  it("always lets a member through (the join screen takes them in)", () => {
    expect(homeJoinOutcome("ABCD2345", preview({ player_count: 10 }), true)).toBe("go");
    expect(homeJoinOutcome("ABCD2345", preview({ status: "ended" }), true)).toBe("go");
  });
});
