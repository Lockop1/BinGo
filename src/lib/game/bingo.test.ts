import { describe, expect, it } from "vitest";
import { LINES, completedLines, isBlackout, lineName, linePositions } from "@/lib/game/bingo";
import { board, completedBy } from "@/lib/game/testFixtures";

const done = (positions: number[]) =>
  board(Object.fromEntries(positions.map((p, i) => [p, completedBy(p === 12 ? null : "p", i + 2)])));

describe("bingo lines", () => {
  it("has 5 rows, 5 columns and 2 diagonals over 25 positions", () => {
    expect(LINES).toHaveLength(12);
    expect(LINES.filter((l) => l.kind === "row")).toHaveLength(5);
    expect(LINES.filter((l) => l.kind === "col")).toHaveLength(5);
    expect(LINES.find((l) => l.id === "r1")?.positions).toEqual([5, 6, 7, 8, 9]);
    expect(LINES.find((l) => l.id === "c2")?.positions).toEqual([2, 7, 12, 17, 22]);
    expect(LINES.find((l) => l.id === "d0")?.positions).toEqual([0, 6, 12, 18, 24]);
    expect(LINES.find((l) => l.id === "d1")?.positions).toEqual([4, 8, 12, 16, 20]);
    for (const line of LINES) expect(line.positions.every((p) => p >= 0 && p < 25)).toBe(true);
  });

  it("finds no lines on an empty board or with four of five", () => {
    expect(completedLines(board())).toEqual([]);
    expect(completedLines(done([0, 1, 2, 3]))).toEqual([]);
  });

  it("detects rows, columns and diagonals (the free center counts)", () => {
    expect(completedLines(done([0, 1, 2, 3, 4]))).toEqual(["r0"]);
    expect(completedLines(done([4, 9, 14, 19, 24]))).toEqual(["c4"]);
    expect(completedLines(done([0, 6, 12, 18, 24]))).toEqual(["d0"]);
    expect(completedLines(done([4, 8, 12, 16, 20]))).toEqual(["d1"]);
    // One square finishing two lines at once.
    expect(completedLines(done([10, 11, 12, 13, 14, 2, 7, 17, 22]))).toEqual(["r2", "c2"]);
  });

  it("detects a blackout only at 25/25", () => {
    const all = Array.from({ length: 25 }, (_, i) => i);
    expect(isBlackout(done(all.slice(0, 24)))).toBe(false);
    expect(isBlackout(done(all))).toBe(true);
    expect(completedLines(done(all))).toHaveLength(12);
  });

  it("names lines and unions their cells", () => {
    expect(lineName("r1")).toBe("Row 2");
    expect(lineName("c0")).toBe("Column 1");
    expect(lineName("d1")).toBe("Diagonal");
    expect(linePositions(["r0", "c0"])).toEqual([0, 1, 2, 3, 4, 5, 10, 15, 20]);
  });
});
