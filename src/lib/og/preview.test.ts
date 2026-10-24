import { describe, expect, it } from "vitest";
import { BOARD_LINES, CROSSED_CELLS, crossOff } from "./boardArt";
import {
  HEADING_MAX_CHARS,
  asInvitePreview,
  clampGameName,
  groupJoinCode,
  headingFontSize,
  isPlausibleJoinCode,
  playersIn,
  previewCopy,
  type InvitePreview,
} from "./preview";

const lobby = (over: Partial<InvitePreview> = {}): InvitePreview => ({
  name: "Jake's Birthday",
  status: "lobby",
  player_count: 4,
  free_center: true,
  ...over,
});

describe("previewCopy", () => {
  it("names the game and the head count", () => {
    expect(previewCopy(lobby())).toEqual({
      title: "Join Jake's Birthday · Bingo Night",
      description: "4 players in. Tap to join the board — no signup.",
      heading: "Jake's Birthday",
      subline: "4 players in · Tap to join",
    });
  });

  it("uses the singular for one player", () => {
    const copy = previewCopy(lobby({ player_count: 1 }));
    expect(copy.description).toBe("1 player in. Tap to join the board — no signup.");
    expect(copy.subline).toBe("1 player in · Tap to join");
  });

  it("invites into a live game the same way (late join)", () => {
    expect(previewCopy(lobby({ status: "active", player_count: 7 })).subline).toBe("7 players in · Tap to join");
  });

  it("does not invite into an ended game", () => {
    expect(previewCopy(lobby({ status: "ended" }))).toEqual({
      title: "Jake's Birthday · Bingo Night",
      description: "This game has ended.",
      heading: "Jake's Birthday",
      subline: "This game has ended",
    });
  });

  it("falls back to generic copy without a preview", () => {
    expect(previewCopy(null)).toEqual({
      title: "Join the game · Bingo Night",
      description: "Tap to join the board — no signup.",
      heading: null,
      subline: "Tap to join · no signup",
    });
  });

  it("keeps the full name in the title but clamps the card heading", () => {
    const name = "The Extremely Long Saturday Night Downtown Bingo Crawl Special";
    const copy = previewCopy(lobby({ name }));
    expect(copy.title).toBe(`Join ${name} · Bingo Night`);
    expect(Array.from(copy.heading!).length).toBeLessThanOrEqual(HEADING_MAX_CHARS);
    expect(copy.heading!.endsWith("…")).toBe(true);
  });
});

describe("clampGameName", () => {
  it("leaves short names alone and collapses whitespace", () => {
    expect(clampGameName("  Night   out  ")).toBe("Night out");
    expect(clampGameName("x".repeat(40))).toBe("x".repeat(40));
  });

  it("cuts at a word edge when one is near the end", () => {
    expect(clampGameName("Downtown crawl with the whole crew and then karaoke")).toBe(
      "Downtown crawl with the whole crew and…",
    );
  });

  it("hard-cuts a long single word", () => {
    const clamped = clampGameName("A".repeat(60));
    expect(clamped).toBe(`${"A".repeat(39)}…`);
  });

  it("counts characters, not UTF-16 units", () => {
    const name = "Ñandú ".repeat(10).trim();
    expect(Array.from(clampGameName(name)).length).toBeLessThanOrEqual(HEADING_MAX_CHARS);
  });
});

describe("join codes", () => {
  it("groups an 8-char code in fours", () => {
    expect(groupJoinCode("ABCDEFGH")).toBe("ABCD EFGH");
    expect(groupJoinCode("ABC")).toBe("ABC");
  });

  it("accepts only the DB alphabet and length", () => {
    expect(isPlausibleJoinCode("ABCD2345")).toBe(true);
    expect(isPlausibleJoinCode("ZZZZZZZ9")).toBe(true);
    expect(isPlausibleJoinCode("ABCD234")).toBe(false);
    expect(isPlausibleJoinCode("ABCD2340")).toBe(false); // 0 is not in the alphabet
    expect(isPlausibleJoinCode("ABCDI345")).toBe(false); // nor is I
    expect(isPlausibleJoinCode("abcd2345")).toBe(false); // normalize first
  });
});

describe("asInvitePreview", () => {
  it("accepts the RPC row (or a one-row array)", () => {
    const row = { name: "Night", status: "lobby", player_count: 3, free_center: false };
    expect(asInvitePreview(row)).toEqual(row);
    expect(asInvitePreview([row])).toEqual(row);
  });

  it("rejects anything else", () => {
    expect(asInvitePreview(null)).toBeNull();
    expect(asInvitePreview(undefined)).toBeNull();
    expect(asInvitePreview("Night")).toBeNull();
    expect(asInvitePreview({ name: "", status: "lobby", player_count: 1 })).toBeNull();
    expect(asInvitePreview({ name: "Night", status: "weird", player_count: 1 })).toBeNull();
  });

  it("sanitizes the count", () => {
    expect(asInvitePreview({ name: "N", status: "active", player_count: "3" })?.player_count).toBe(0);
    expect(asInvitePreview({ name: "N", status: "active", player_count: 2.7 })?.player_count).toBe(2);
  });
});

describe("card layout helpers", () => {
  it("shrinks the heading as names get longer", () => {
    expect(headingFontSize("Night")).toBeGreaterThan(headingFontSize("A longer game name here"));
    expect(headingFontSize("x".repeat(40))).toBeGreaterThanOrEqual(50);
  });

  it("pluralizes", () => {
    expect(playersIn(1)).toBe("1 player in");
    expect(playersIn(10)).toBe("10 players in");
  });

  it("draws a 5x5 board and red cross-offs", () => {
    expect(BOARD_LINES).toHaveLength(12);
    for (const d of BOARD_LINES) expect(d).toMatch(/^M-?\d+ -?\d+ Q[-\d. ]+$/);
    expect(CROSSED_CELLS.length).toBeGreaterThanOrEqual(1);
    expect(crossOff(0, 0)).toHaveLength(3);
  });
});
