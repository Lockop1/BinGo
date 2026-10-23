import { describe, expect, it } from "vitest";
import { boardLabelSize, initialOf, labelSize } from "@/lib/game/boardText";

describe("boardText", () => {
  it("keeps the lobby steps", () => {
    expect(labelSize("FREE")).toBe("lg");
    expect(labelSize("Sing on stage at karaoke")).toBe("md");
  });

  it("steps live-board labels down with length", () => {
    expect(boardLabelSize("FREE")).toBe("xl");
    expect(boardLabelSize("Win at pool")).toBe("lg");
    expect(boardLabelSize("Sing on stage at karaoke")).toBe("md");
    expect(boardLabelSize("Bartender names a drink after us")).toBe("sm");
    expect(boardLabelSize("x".repeat(40))).toBe("sm");
  });

  it("drops a step for one long word", () => {
    expect(boardLabelSize("Photobombing")).toBe("md");
    expect(boardLabelSize("Karaoke")).toBe("xl");
  });

  it("takes the first letter of a name", () => {
    expect(initialOf("  jake ")).toBe("J");
    expect(initialOf("élodie")).toBe("É");
    expect(initialOf("")).toBe("?");
  });
});
