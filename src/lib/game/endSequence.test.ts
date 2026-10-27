import { describe, expect, it } from "vitest";
import {
  BLACKOUT_MS,
  BULB_COUNT,
  BUZZER_MS,
  CREDITS_MS,
  DARK_MS,
  REDUCED_BLACKOUT_MS,
  REDUCED_FADE_MS,
  bulbTrack,
  dieOrder,
  endSeenKey,
  endSteps,
  endVariant,
  isLiveEndFlip,
  marqueePoints,
  shouldPlayEndSequence,
  stepAt,
  totalMs,
  trackValueAt,
  wordTrack,
  type Track,
} from "@/lib/game/endSequence";

const bulbs = Array.from({ length: BULB_COUNT }, (_, i) => bulbTrack(i));
const lit = (track: Track, ms: number) => trackValueAt(track, ms) > 0.5;

describe("endVariant / endSteps", () => {
  it("plays the marquee for a blackout and the buzzer for every other end", () => {
    expect(endVariant("blackout")).toBe("blackout");
    expect(endVariant("host")).toBe("buzzer");
    expect(endVariant("deadline")).toBe("buzzer");
    // The clock passed deadline_at before the server row said why.
    expect(endVariant(null)).toBe("buzzer");
  });

  it("blackout: marquee → dark → credits, 3–4 s before the credits", () => {
    const steps = endSteps("blackout", false);
    expect(steps.map((s) => s.phase)).toEqual(["blackout", "dark", "credits"]);
    expect(BLACKOUT_MS + DARK_MS).toBeGreaterThanOrEqual(3_000);
    expect(BLACKOUT_MS + DARK_MS).toBeLessThanOrEqual(4_000);
    expect(totalMs(steps)).toBe(BLACKOUT_MS + DARK_MS + CREDITS_MS);
  });

  it("host / deadline: a ~1 s buzzer, then the credits (the recap within ~5 s)", () => {
    const steps = endSteps("buzzer", false);
    expect(steps.map((s) => s.phase)).toEqual(["buzzer", "credits"]);
    expect(steps[0].ms).toBe(BUZZER_MS);
    expect(totalMs(steps)).toBeLessThanOrEqual(5_000);
  });

  it("reduced motion: a static title card or a plain fade, then the static credits", () => {
    expect(endSteps("blackout", true)).toEqual([
      { phase: "blackout", ms: REDUCED_BLACKOUT_MS },
      { phase: "credits", ms: CREDITS_MS },
    ]);
    expect(endSteps("buzzer", true)).toEqual([
      { phase: "dark", ms: REDUCED_FADE_MS },
      { phase: "credits", ms: CREDITS_MS },
    ]);
  });

  it("stepAt walks the phases and ends with null", () => {
    const steps = endSteps("blackout", false);
    expect(stepAt(steps, 0)?.step.phase).toBe("blackout");
    expect(stepAt(steps, BLACKOUT_MS - 1)?.step.phase).toBe("blackout");
    expect(stepAt(steps, BLACKOUT_MS)?.step.phase).toBe("dark");
    expect(stepAt(steps, BLACKOUT_MS + DARK_MS)?.index).toBe(2);
    expect(stepAt(steps, totalMs(steps))).toBeNull();
  });
});

describe("when the end sequence plays", () => {
  it("only on a live flip from the board or the countdown, seen on confirmed data", () => {
    expect(isLiveEndFlip({ phase: "active", confirmed: true }, "ended")).toBe(true);
    expect(isLiveEndFlip({ phase: "countdown", confirmed: true }, "ended")).toBe(true);
    // The cached snapshot said active, the server says ended: opened after the end.
    expect(isLiveEndFlip({ phase: "active", confirmed: false }, "ended")).toBe(false);
    // The host closed the lobby: no board was ever up.
    expect(isLiveEndFlip({ phase: "lobby", confirmed: true }, "ended")).toBe(false);
    // Opened on an ended game (first render already ended), or not ended at all.
    expect(isLiveEndFlip(null, "ended")).toBe(false);
    expect(isLiveEndFlip({ phase: "ended", confirmed: true }, "ended")).toBe(false);
    expect(isLiveEndFlip({ phase: "countdown", confirmed: true }, "active")).toBe(false);
  });

  it("once per phone", () => {
    expect(shouldPlayEndSequence({ liveFlip: true, seen: false })).toBe(true);
    expect(shouldPlayEndSequence({ liveFlip: true, seen: true })).toBe(false);
    expect(shouldPlayEndSequence({ liveFlip: false, seen: false })).toBe(false);
    expect(endSeenKey("abc")).toBe("bingo.endSeen.abc");
  });
});

describe("the marquee bulbs", () => {
  it("keyframes start and end dark, with times sorted within 0..1", () => {
    for (const track of [...bulbs, wordTrack()]) {
      expect(track.values.length).toBe(track.times.length);
      expect(track.times[0]).toBe(0);
      expect(track.times[track.times.length - 1]).toBe(1);
      for (let i = 1; i < track.times.length; i++) expect(track.times[i]).toBeGreaterThanOrEqual(track.times[i - 1]);
    }
    for (const track of bulbs) {
      expect(track.values[0]).toBe(0);
      expect(track.values[track.values.length - 1]).toBe(0);
      // Solid on or off: opacity only, no in-between levels as resting states.
      expect(track.values.every((v) => v === 0 || v === 1)).toBe(true);
    }
  });

  it("switch on in a chase round the ring", () => {
    expect(bulbs.every((b) => !lit(b, 100))).toBe(true);
    const onAt = bulbs.map((b) => {
      for (let ms = 0; ms < 1_100; ms += 5) if (lit(b, ms)) return ms;
      return Infinity;
    });
    for (let i = 1; i < onAt.length; i++) expect(onAt[i]).toBeGreaterThan(onAt[i - 1]);
    // Then odd and even bulbs alternate.
    expect(lit(bulbs[0], 1_120)).toBe(true);
    expect(lit(bulbs[1], 1_120)).toBe(false);
    expect(lit(bulbs[0], 1_270)).toBe(false);
    expect(lit(bulbs[1], 1_270)).toBe(true);
  });

  it("flash all together three times", () => {
    for (const [on, off] of [
      [1_700, 1_850],
      [2_000, 2_150],
      [2_300, 2_450],
    ]) {
      expect(bulbs.every((b) => lit(b, on))).toBe(true);
      expect(bulbs.every((b) => !lit(b, off))).toBe(true);
    }
  });

  it("flicker unevenly, then die one by one until all are dark", () => {
    // Somewhere in the flicker window not every bulb is lit, but most are.
    let uneven = false;
    for (let ms = 2_520; ms < 2_860; ms += 5) {
      const count = bulbs.filter((b) => lit(b, ms)).length;
      if (count > 0 && count < BULB_COUNT) uneven = true;
    }
    expect(uneven).toBe(true);
    expect(bulbs.every((b) => lit(b, 2_890))).toBe(true);
    const order = dieOrder();
    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: BULB_COUNT }, (_, i) => i));
    expect(order).not.toEqual(Array.from({ length: BULB_COUNT }, (_, i) => i));
    let previous = BULB_COUNT;
    for (let ms = 2_880; ms <= 3_400; ms += 10) {
      const count = bulbs.filter((b) => lit(b, ms)).length;
      expect(count).toBeLessThanOrEqual(previous);
      previous = count;
    }
    expect(bulbs.every((b) => !lit(b, 3_400))).toBe(true);
    expect(trackValueAt(wordTrack(), 3_480)).toBeLessThan(0.5);
  });

  it("sit evenly on the rectangle", () => {
    const points = marqueePoints(4, { x: 0, y: 0, width: 10, height: 10 });
    expect(points).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
  });
});
