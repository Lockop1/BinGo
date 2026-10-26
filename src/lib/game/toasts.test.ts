import { describe, expect, it } from "vitest";
import {
  DEADLINE_TOAST_TEXT,
  MAX_QUEUED,
  TOAST_MS,
  createToastQueue,
  deadlineToast,
  mediaToasts,
  noteDeadlineToastShown,
  readDeadlineToastShown,
  shouldShowDeadlineToast,
  splitLead,
} from "@/lib/game/toasts";
import { manualClock } from "@/lib/game/testFixtures";

function setup() {
  const clock = manualClock();
  const queue = createToastQueue({ setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  return { clock, queue };
}

describe("toast queue", () => {
  it("shows one toast at a time for ~2.5 s, the rest wait in line", () => {
    const { clock, queue } = setup();
    queue.push({ text: "Jake got Karaoke", color: 2, position: 0 });
    queue.push({ text: "Ana got Pool", color: 4, position: 17 });
    expect(queue.getState().current).toMatchObject({ text: "Jake got Karaoke", tone: "info", color: 2, position: 0 });
    expect(queue.getState().queued.map((t) => t.text)).toEqual(["Ana got Pool"]);
    clock.advance(TOAST_MS - 1);
    expect(queue.getState().current?.text).toBe("Jake got Karaoke");
    clock.advance(1);
    expect(queue.getState().current?.text).toBe("Ana got Pool");
    expect(queue.getState().queued).toEqual([]);
    clock.advance(TOAST_MS);
    expect(queue.getState().current).toBeNull();
    expect(clock.pending()).toBe(0);
  });

  it("dismissing (tap) moves to the next toast and restarts the timer", () => {
    const { clock, queue } = setup();
    const first = queue.push({ text: "one" })!;
    queue.push({ text: "two" });
    clock.advance(2000);
    queue.dismiss(first.id);
    expect(queue.getState().current?.text).toBe("two");
    clock.advance(TOAST_MS - 1);
    expect(queue.getState().current?.text).toBe("two");
  });

  it("dismissing a waiting toast by id drops just that one", () => {
    const { queue } = setup();
    queue.push({ text: "one" });
    const second = queue.push({ text: "two" })!;
    queue.push({ text: "three" });
    queue.dismiss(second.id);
    expect(queue.getState().current?.text).toBe("one");
    expect(queue.getState().queued.map((t) => t.text)).toEqual(["three"]);
  });

  it("caps the waiting line, dropping the oldest", () => {
    const { queue } = setup();
    queue.push({ text: "now" });
    for (let i = 0; i < MAX_QUEUED + 3; i++) queue.push({ text: `t${i}` });
    expect(queue.getState().current?.text).toBe("now");
    expect(queue.getState().queued).toHaveLength(MAX_QUEUED);
    expect(queue.getState().queued[MAX_QUEUED - 1].text).toBe(`t${MAX_QUEUED + 2}`);
  });

  it("drops an identical toast right behind the same one", () => {
    const { queue } = setup();
    expect(queue.push({ text: "Jake got Karaoke" })).not.toBeNull();
    expect(queue.push({ text: "Jake got Karaoke" })).toBeNull();
    expect(queue.getState().queued).toEqual([]);
  });

  it("clear empties everything; listeners hear every change", () => {
    const { queue } = setup();
    let calls = 0;
    const off = queue.subscribe(() => calls++);
    queue.push({ text: "a", tone: "error" });
    queue.push({ text: "b" });
    queue.clear();
    expect(queue.getState()).toEqual({ current: null, queued: [] });
    expect(calls).toBe(3);
    off();
  });
});

describe("mediaToasts", () => {
  const ctx = {
    players: [
      { id: "me", display_name: "Me", color: 0 },
      { id: "jake", display_name: "Jake", color: 3 },
    ],
    squares: [
      { id: "sq-0", position: 0, label: "Skyline Chili" },
      { id: "sq-7", position: 7, label: "  " },
    ],
    meId: "me",
  };
  const row = (id: string, player_id: string, square_id: string, kind: "photo" | "video" = "photo") => ({
    id,
    player_id,
    square_id,
    kind,
  });

  it("announces new media from other players with their color and the square to open", () => {
    const media = [row("m1", "jake", "sq-0"), row("m2", "jake", "sq-7", "video"), row("m3", "me", "sq-0")];
    expect(mediaToasts(new Set(), media, ctx)).toEqual([
      { text: "Jake added a photo to Skyline Chili", color: 3, position: 0 },
      { text: "Jake added a video to square 8", color: 3, position: 7 },
    ]);
  });

  it("skips rows already seen and never announces the viewer's own uploads", () => {
    const media = [row("m1", "jake", "sq-0"), row("m3", "me", "sq-0")];
    expect(mediaToasts(new Set(["m1"]), media, ctx)).toEqual([]);
  });

  it("falls back when the player or square is not loaded yet", () => {
    expect(mediaToasts(new Set(), [row("m9", "ghost", "sq-x")], ctx)).toEqual([
      { text: "Someone added a photo", color: null, position: null },
    ]);
  });
});

describe("splitLead", () => {
  it("splits off the player name the toast starts with (longest match wins)", () => {
    expect(splitLead("Jake got Skyline Chili", ["Ana", "Jake"])).toEqual({ lead: "Jake", rest: " got Skyline Chili" });
    expect(splitLead("Jake B undid Pool", ["Jake", "Jake B"])).toEqual({ lead: "Jake B", rest: " undid Pool" });
  });

  it("needs a whole name followed by a space", () => {
    expect(splitLead("Jakeline got Pool", ["Jake"])).toBeNull();
    expect(splitLead("Jake", ["Jake"])).toBeNull();
    expect(splitLead("Someone added a photo", ["Jake", ""])).toBeNull();
    expect(splitLead("Couldn't save Pool", [])).toBeNull();
  });
});

describe("deadline toast", () => {
  const now = new Date("2026-10-26T01:00:00.000Z");
  const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();

  it("is the single tappable '1 hour left.' line that opens the Players sheet", () => {
    const { queue } = setup();
    const toast = queue.push(deadlineToast())!;
    expect(toast).toMatchObject({ text: DEADLINE_TOAST_TEXT, tone: "info", color: null, position: null, target: "players" });
    expect(DEADLINE_TOAST_TEXT).toBe("1 hour left.");
    // Other toasts carry no target.
    expect(queue.push({ text: "Jake got Pool", position: 3 })).not.toHaveProperty("target");
  });

  it("shows only while under one hour and not passed", () => {
    expect(shouldShowDeadlineToast(null, at(61), now)).toBe(false);
    expect(shouldShowDeadlineToast(null, at(60), now)).toBe(false);
    expect(shouldShowDeadlineToast(null, at(59), now)).toBe(true);
    expect(shouldShowDeadlineToast(null, at(0.1), now)).toBe(true);
    expect(shouldShowDeadlineToast(null, at(0), now)).toBe(false);
    expect(shouldShowDeadlineToast(null, at(-5), now)).toBe(false);
    expect(shouldShowDeadlineToast(null, null, now)).toBe(false);
    expect(shouldShowDeadlineToast(null, "nonsense", now)).toBe(false);
  });

  it("shows once per deadline value, comparing instants not strings", () => {
    const deadline = "2026-10-26T01:30:00+00:00";
    expect(shouldShowDeadlineToast(deadline, deadline, now)).toBe(false);
    expect(shouldShowDeadlineToast("2026-10-26T01:30:00.000Z", deadline, now)).toBe(false);
    // An extension moved the deadline: one new warning once it is within the hour again.
    const extended = "2026-10-26T02:30:00+00:00";
    expect(shouldShowDeadlineToast(deadline, extended, now)).toBe(false);
    expect(shouldShowDeadlineToast(deadline, extended, new Date("2026-10-26T01:31:00.000Z"))).toBe(true);
  });

  it("reading and noting the shown deadline never throws without storage", () => {
    expect(readDeadlineToastShown("g1")).toBeNull();
    expect(() => noteDeadlineToastShown("g1", at(30))).not.toThrow();
  });
});
