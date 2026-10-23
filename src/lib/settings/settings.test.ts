import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CELL_RATIO,
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  TEXT_SCALE,
  loadSettings,
  paletteThemeFor,
  parseSettings,
  resolveTheme,
  saveSettings,
  systemTheme,
} from "./settings";
import { subscribeLocal } from "@/lib/storage/local";

/** Minimal in-memory localStorage behind a fake `window` (vitest runs in node). */
function fakeWindow() {
  const data = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
  return { data, window: { localStorage, addEventListener: () => {}, removeEventListener: () => {} } };
}

describe("resolveTheme", () => {
  it("follows the phone when nothing is pinned", () => {
    expect(resolveTheme({ theme: null }, true)).toBe("scoreboard");
    expect(resolveTheme({ theme: null }, false)).toBe("whiteboard");
    expect(systemTheme(true)).toBe("scoreboard");
    expect(systemTheme(false)).toBe("whiteboard");
  });

  it("a pinned theme wins over the phone", () => {
    expect(resolveTheme({ theme: "whiteboard" }, true)).toBe("whiteboard");
    expect(resolveTheme({ theme: "scoreboard" }, false)).toBe("scoreboard");
  });

  it("maps board themes to palette shades", () => {
    expect(paletteThemeFor("scoreboard")).toBe("dark");
    expect(paletteThemeFor("whiteboard")).toBe("light");
  });
});

describe("parseSettings", () => {
  it("defaults when empty or not an object", () => {
    for (const value of [null, undefined, 3, "scoreboard", [], true]) {
      expect(parseSettings(value)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it("keeps valid fields and drops invalid ones independently", () => {
    expect(parseSettings({ theme: "scoreboard", textSize: "huge", squareSize: "tall" })).toEqual({
      theme: "scoreboard",
      textSize: "normal",
      squareSize: "tall",
    });
    expect(parseSettings({ theme: "dark", textSize: "xlarge", squareSize: 2, extra: 1 })).toEqual({
      theme: null,
      textSize: "xlarge",
      squareSize: "normal",
    });
  });

  it("has a scale and ratio for every option", () => {
    expect(TEXT_SCALE).toEqual({ normal: 1, large: 1.2, xlarge: 1.45 });
    expect(CELL_RATIO).toEqual({ normal: 1, tall: 1.35 });
  });
});

describe("persistence", () => {
  let store: ReturnType<typeof fakeWindow>;
  beforeEach(() => {
    store = fakeWindow();
    vi.stubGlobal("window", store.window);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads defaults when nothing is stored", () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("saves under bingo.settings and merges patches", () => {
    saveSettings({ theme: "whiteboard" });
    saveSettings({ textSize: "large" });
    expect(JSON.parse(store.data.get(SETTINGS_KEY)!)).toEqual({ theme: "whiteboard", textSize: "large", squareSize: "normal" });
    expect(loadSettings()).toEqual({ theme: "whiteboard", textSize: "large", squareSize: "normal" });
    saveSettings({ theme: null });
    expect(loadSettings().theme).toBeNull();
  });

  it("ignores invalid stored values", () => {
    store.data.set(SETTINGS_KEY, JSON.stringify({ theme: "neon", textSize: "xlarge", squareSize: "huge" }));
    expect(loadSettings()).toEqual({ theme: null, textSize: "xlarge", squareSize: "normal" });
    store.data.set(SETTINGS_KEY, "{not json");
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    store.data.set(SETTINGS_KEY, JSON.stringify(["scoreboard"]));
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("never writes an invalid patch value", () => {
    saveSettings({ textSize: "giant" as never });
    expect(loadSettings().textSize).toBe("normal");
  });

  it("notifies same-tab subscribers on save", () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeLocal(SETTINGS_KEY, onChange);
    saveSettings({ squareSize: "tall" });
    expect(onChange).toHaveBeenCalledTimes(1);
    unsubscribe();
    saveSettings({ squareSize: "normal" });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("survives storage that throws", () => {
    vi.stubGlobal("window", {
      ...store.window,
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    });
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings({ theme: "scoreboard" })).not.toThrow();
  });
});
