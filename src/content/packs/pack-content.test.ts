import { describe, expect, it } from "vitest";
import { PACKS, PACK_POSITIONS, getPack, packToSquares } from "./index";

const BANNED = ["shot", "shots", "chug", "drunk", "wasted", "strip", "naked", "trespass", "steal", "break in"];

function containsBanned(text: string): string | null {
  const lower = text.toLowerCase();
  for (const word of BANNED) {
    const pattern = new RegExp(`\\b${word.replace(/\s+/g, "\\s+")}\\b`, "i");
    if (pattern.test(lower)) return word;
  }
  return null;
}

describe("starter packs", () => {
  it("has the three packs", () => {
    expect(PACKS.map((p) => p.id)).toEqual(["night-out", "day-adventure", "blank"]);
    expect(getPack("blank").squares).toHaveLength(0);
  });

  for (const pack of PACKS.filter((p) => p.id !== "blank")) {
    describe(pack.name, () => {
      it("has exactly 24 squares", () => {
        expect(pack.squares).toHaveLength(24);
      });

      it("keeps labels ≤40 and details ≤200 characters", () => {
        for (const square of pack.squares) {
          expect(square.label.trim().length, square.label).toBeGreaterThan(0);
          expect(square.label.length, square.label).toBeLessThanOrEqual(40);
          expect((square.details ?? "").length, square.label).toBeLessThanOrEqual(200);
        }
      });

      it("has no duplicate labels", () => {
        const labels = pack.squares.map((s) => s.label.toLowerCase());
        expect(new Set(labels).size).toBe(labels.length);
      });

      it("has valid counter targets", () => {
        for (const square of pack.squares) {
          if (square.target_count !== undefined) {
            expect(Number.isInteger(square.target_count)).toBe(true);
            expect(square.target_count).toBeGreaterThanOrEqual(2);
            expect(square.target_count).toBeLessThanOrEqual(99);
          }
        }
      });

      it("contains no banned words", () => {
        for (const square of pack.squares) {
          for (const text of [square.label, square.details ?? ""]) {
            expect(containsBanned(text), text).toBeNull();
          }
        }
        expect(containsBanned(pack.name + " " + pack.tagline)).toBeNull();
      });

      it("maps around the free center", () => {
        const squares = packToSquares(pack);
        expect(squares.map((s) => s.position)).toEqual([...PACK_POSITIONS]);
        expect(squares.some((s) => s.position === 12)).toBe(false);
      });
    });
  }

  it("the banned-word matcher catches phrases and whole words only", () => {
    expect(containsBanned("Take two shots")).toBe("shots");
    expect(containsBanned("Get DRUNK")).toBe("drunk");
    expect(containsBanned("Do not break  in")).toBe("break in");
    expect(containsBanned("A striped shirt")).toBeNull();
  });
});
