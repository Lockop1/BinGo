import { describe, expect, it } from "vitest";
import {
  BLACKOUT_ID,
  CELEBRATION_TIMING,
  celebratedKey,
  createCelebrationQueue,
  createCelebrationTracker,
  memoryCelebratedStore,
} from "@/lib/game/celebrations";
import { GAME_ID, manualClock } from "@/lib/game/testFixtures";

describe("celebration tracker", () => {
  it("celebrates each new line once and persists it", () => {
    const store = memoryCelebratedStore();
    const tracker = createCelebrationTracker(GAME_ID, store);
    tracker.seed([], false);
    expect(tracker.observe([], false)).toBeNull();
    const first = tracker.observe(["r0"], false);
    expect(first).toMatchObject({ lines: ["r0"], blackout: false, positions: [0, 1, 2, 3, 4] });
    expect(store.data[GAME_ID]).toEqual(["r0"]);
    expect(tracker.observe(["r0"], false)).toBeNull();
  });

  it("does not celebrate again after the line is undone and re-completed", () => {
    const tracker = createCelebrationTracker(GAME_ID, memoryCelebratedStore());
    tracker.seed([], false);
    expect(tracker.observe(["d0"], false)).not.toBeNull();
    expect(tracker.observe([], false)).toBeNull();
    expect(tracker.observe(["d0"], false)).toBeNull();
  });

  it("survives a reload through the store", () => {
    const store = memoryCelebratedStore();
    createCelebrationTracker(GAME_ID, store).observe(["c1"], false);
    const reloaded = createCelebrationTracker(GAME_ID, store);
    reloaded.seed(["c1"], false);
    expect(reloaded.observe(["c1"], false)).toBeNull();
    expect(reloaded.observe(["c1", "r3"], false)?.lines).toEqual(["r3"]);
  });

  it("counts lines already complete at mount as celebrated (no party for old news)", () => {
    const store = memoryCelebratedStore();
    const tracker = createCelebrationTracker(GAME_ID, store);
    tracker.seed(["r0", "c0"], false);
    expect(store.data[GAME_ID]).toEqual(["r0", "c0"]);
    expect(tracker.observe(["r0", "c0"], false)).toBeNull();
    // A line completed after mount still celebrates.
    expect(tracker.observe(["r0", "c0", "d0"], false)?.lines).toEqual(["d0"]);
  });

  it("rolls several lines completed at once into one celebration", () => {
    const tracker = createCelebrationTracker(GAME_ID, memoryCelebratedStore());
    tracker.seed([], false);
    const both = tracker.observe(["r2", "c2"], false);
    expect(both?.lines).toEqual(["r2", "c2"]);
    expect(both?.positions).toEqual([2, 7, 10, 11, 12, 13, 14, 17, 22]);
  });

  it("celebrates the blackout once, with every cell", () => {
    const tracker = createCelebrationTracker(GAME_ID, memoryCelebratedStore());
    tracker.seed(["r0"], false);
    const big = tracker.observe(["r0", "r1"], true);
    expect(big).toMatchObject({ lines: ["r1"], blackout: true });
    expect(big?.positions).toHaveLength(25);
    expect(tracker.has(BLACKOUT_ID)).toBe(true);
    expect(tracker.observe(["r0", "r1"], true)).toBeNull();
  });

  it("keeps games apart and uses the documented storage key", () => {
    const store = memoryCelebratedStore({ other: ["r0"] });
    const tracker = createCelebrationTracker(GAME_ID, store);
    expect(tracker.has("r0")).toBe(false);
    expect(celebratedKey(GAME_ID)).toBe(`bingo.celebrated.${GAME_ID}`);
  });
});

describe("celebration queue", () => {
  const event = (id: string, blackout = false) => ({ id, lines: ["r0"], blackout, positions: [0, 1, 2, 3, 4] });

  function setup() {
    const clock = manualClock();
    const queue = createCelebrationQueue({ setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    return { clock, queue };
  }

  it("plays highlight, then overlay, then clears", () => {
    const { clock, queue } = setup();
    queue.push(event("a"), { color: 3 });
    expect(queue.getState()).toMatchObject({ shown: 1, current: { id: "a", phase: "highlight", color: 3 } });
    clock.advance(CELEBRATION_TIMING.highlightMs);
    expect(queue.getState().current?.phase).toBe("overlay");
    clock.advance(CELEBRATION_TIMING.bingoMs);
    expect(queue.getState().current).toBeNull();
    expect(queue.getState().shown).toBe(1);
  });

  it("plays queued celebrations one after another", () => {
    const { clock, queue } = setup();
    queue.push(event("a"));
    queue.push(event("b"));
    expect(queue.getState().current?.id).toBe("a");
    clock.advance(CELEBRATION_TIMING.highlightMs + CELEBRATION_TIMING.bingoMs);
    expect(queue.getState()).toMatchObject({ shown: 2, current: { id: "b", phase: "highlight" } });
  });

  it("holds a blackout longer and waits for the host's answer", () => {
    const { clock, queue } = setup();
    queue.push(event("x", true), { prompt: true });
    clock.advance(CELEBRATION_TIMING.highlightMs);
    clock.advance(CELEBRATION_TIMING.bingoMs);
    expect(queue.getState().current?.phase).toBe("overlay");
    clock.advance(CELEBRATION_TIMING.blackoutMs - CELEBRATION_TIMING.bingoMs);
    expect(queue.getState().current?.phase).toBe("prompt");
    clock.advance(60_000);
    expect(queue.getState().current?.phase).toBe("prompt");
    queue.dismiss();
    expect(queue.getState().current).toBeNull();
  });

  it("only prompts for a blackout, and dismiss skips ahead", () => {
    const { queue } = setup();
    queue.push(event("a"), { prompt: true });
    expect(queue.getState().current?.prompt).toBe(false);
    queue.dismiss();
    expect(queue.getState().current?.phase).toBe("overlay");
    queue.dismiss();
    expect(queue.getState().current).toBeNull();
  });
});
