import { describe, expect, it } from "vitest";
import type { Media, Player, Square } from "@/lib/game/types";
import { completedLines } from "@/components/recap/lines";
import { buildRecapItems, recapFileNames, slug } from "@/components/recap/recapItems";

const at = "2026-10-01T20:00:00.000Z";
const square = (position: number, done: boolean, by: string | null = null): Square => ({
  id: `s${position}`,
  game_id: "g",
  position,
  label: position === 12 ? "" : `Label ${position}`,
  details: "",
  target_count: 1,
  current_count: done ? 1 : 0,
  completed_by_player_id: by,
  completed_at: done ? at : null,
  updated_at: at,
});
const board = (done: number[]) => Array.from({ length: 25 }, (_, p) => square(p, done.includes(p), "p1"));

describe("completedLines", () => {
  it("finds rows, columns and both diagonals", () => {
    expect(completedLines(board([]))).toEqual([]);
    expect(completedLines(board([0, 1, 2, 3, 4]))).toEqual(["Row 1"]);
    expect(completedLines(board([2, 7, 12, 17, 22]))).toEqual(["Column 3"]);
    expect(completedLines(board([0, 6, 12, 18, 24, 4, 8, 16, 20]))).toEqual(["Diagonal", "Anti-diagonal"]);
    expect(completedLines(board(Array.from({ length: 25 }, (_, i) => i)))).toHaveLength(12);
  });
});

describe("buildRecapItems", () => {
  const players: Player[] = [
    { id: "p1", game_id: "g", user_id: "u1", display_name: "Jake", color: 0, is_ready: true, joined_at: at },
    { id: "p2", game_id: "g", user_id: "u2", display_name: "Ana Lí", color: 3, is_ready: true, joined_at: at },
  ];
  const squares = [square(2, true, "p2"), square(7, true, "p1"), square(18, true, "p1")];
  const media = (id: string, sq: string, player: string, created: string): Media => ({
    id,
    game_id: "g",
    square_id: sq,
    player_id: player,
    storage_path: `g/${sq}/${id}.jpg`,
    kind: "photo",
    created_at: created,
  });

  it("orders by board position, then upload time, skipping unknown squares", () => {
    const items = buildRecapItems(
      [
        media("m1", "s7", "p1", "2026-10-01T21:00:00Z"),
        media("m2", "s18", "p1", "2026-10-01T20:30:00Z"),
        media("m3", "s2", "p2", "2026-10-01T22:00:00Z"),
        media("m4", "s7", "p2", "2026-10-01T20:10:00Z"),
        media("m5", "s99", "p2", "2026-10-01T20:10:00Z"),
      ],
      squares,
      players,
    );
    expect(items.map((i) => i.media.id)).toEqual(["m3", "m4", "m1", "m2"]);
    expect(items.map((i) => i.completer?.display_name)).toEqual(["Ana Lí", "Jake", "Jake", "Jake"]);
    expect(items.map((i) => i.uploader?.display_name)).toEqual(["Ana Lí", "Ana Lí", "Jake", "Jake"]);
    expect(recapFileNames(items)).toEqual([
      "03-label-2-ana-li.jpg",
      "08-label-7-ana-li.jpg",
      "08-label-7-jake-2.jpg",
      "19-label-18-jake.jpg",
    ]);
  });

  it("slugs safely", () => {
    expect(slug("  Skyline Chili!! 3-way ")).toBe("skyline-chili-3-way");
    expect(slug("🎉", "x")).toBe("x");
  });
});
