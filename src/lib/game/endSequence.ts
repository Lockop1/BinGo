import { jitter } from "@/lib/game/boardText";
import type { EndReason, GameStatus } from "@/lib/game/types";

/**
 * The end-of-game moment, as pure visual state (EndSequence.tsx plays it).
 *
 * When a game goes from live to ended *on this phone* (it was showing the
 * board or the start countdown, on server-confirmed data, and the effective
 * status became `ended`), the recap is mounted underneath and an overlay plays
 * once per phone:
 *
 * - `end_reason = 'blackout'`: the marquee "BLACKOUT" (bulbs chase on, flash,
 *   flicker, die one by one) → dark → the credits card → the recap.
 * - `'host'` / `'deadline'` (or unknown: the clock passed `deadline_at` before
 *   the server row said why): the final buzzer → the credits card → the recap.
 *
 * Reduced motion swaps each part for a plain fade: a static "BLACKOUT" title
 * card, a dark fade instead of the buzzer, a static credits card.
 *
 * Nothing here changes the game: it only decides what to draw and for how long.
 * Opening the app on an already ended game (no live flip), or after this phone
 * has played the sequence (`bingo.endSeen.<gameId>`), shows the recap at once;
 * so does a reload mid-sequence (the reloaded screen never saw the game live).
 */

export type EndVariant = "blackout" | "buzzer";
export type EndPhase = "blackout" | "dark" | "buzzer" | "credits";
export type EndStep = { phase: EndPhase; ms: number };

/** The marquee, from the first bulb to the last one dying (the word goes out with it). */
export const BLACKOUT_MS = 3_500;
/** The dark beat between the dead marquee and the credits. */
export const DARK_MS = 400;
/** The final buzzer: hard cut to dark, the bar snaps on and fades. */
export const BUZZER_MS = 1_000;
/** How long the credits card stays up before the recap (Skip goes at once). */
export const CREDITS_MS = 3_200;
/** Reduced motion: the static "BLACKOUT" title card, and the fade standing in for the buzzer. */
export const REDUCED_BLACKOUT_MS = 1_500;
export const REDUCED_FADE_MS = 400;

export function endVariant(reason: EndReason | null): EndVariant {
  return reason === "blackout" ? "blackout" : "buzzer";
}

/** The phases to play, in order, with their durations. */
export function endSteps(variant: EndVariant, reduced: boolean): EndStep[] {
  if (variant === "blackout") {
    return reduced
      ? [
          { phase: "blackout", ms: REDUCED_BLACKOUT_MS },
          { phase: "credits", ms: CREDITS_MS },
        ]
      : [
          { phase: "blackout", ms: BLACKOUT_MS },
          { phase: "dark", ms: DARK_MS },
          { phase: "credits", ms: CREDITS_MS },
        ];
  }
  return reduced
    ? [
        { phase: "dark", ms: REDUCED_FADE_MS },
        { phase: "credits", ms: CREDITS_MS },
      ]
    : [
        { phase: "buzzer", ms: BUZZER_MS },
        { phase: "credits", ms: CREDITS_MS },
      ];
}

export function totalMs(steps: readonly EndStep[]): number {
  return steps.reduce((sum, step) => sum + step.ms, 0);
}

/** The step showing `elapsedMs` into the sequence, or null once it is over. */
export function stepAt(steps: readonly EndStep[], elapsedMs: number): { index: number; step: EndStep } | null {
  let start = 0;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (elapsedMs < start + step.ms) return { index, step };
    start += step.ms;
  }
  return null;
}

/** What the game screen shows: the effective status, with the start countdown split out of `active`. */
export type ScreenPhase = GameStatus | "countdown";

/** What this mount last rendered, and whether that was server-confirmed data (not just the cached snapshot). */
export type SeenPhase = { phase: ScreenPhase; confirmed: boolean };

/**
 * A live end: the screen was showing the board or the countdown, on data the
 * server had confirmed, and now the game is ended. A cached snapshot that
 * turns out to be ended, or a game opened after its end, is not one.
 */
export function isLiveEndFlip(previous: SeenPhase | null, next: ScreenPhase): boolean {
  if (next !== "ended" || previous === null || !previous.confirmed) return false;
  return previous.phase === "active" || previous.phase === "countdown";
}

/** Play the end sequence: a live end this phone has not played it for yet. */
export function shouldPlayEndSequence({ liveFlip, seen }: { liveFlip: boolean; seen: boolean }): boolean {
  return liveFlip && !seen;
}

export function endSeenKey(gameId: string): `bingo.endSeen.${string}` {
  return `bingo.endSeen.${gameId}`;
}

// ---------------------------------------------------------------------------
// The marquee: when each bulb is lit, as opacity keyframes for its lit layer
// (1 = lit, a solid fill; 0 = only the dim unlit fill shows). Times in ms
// within BLACKOUT_MS. Every phone draws the same marquee (fixed seeds).

export const BULB_COUNT = 22;

/** Bulbs come on one by one around the ring. */
const CHASE_ON = { start: 150, end: 1_050 };
/** Classic marquee chase: odd and even bulbs alternate, then all on. */
const CHASE_ALTERNATE = [1_050, 1_200, 1_350, 1_500] as const;
const ALL_ON_AT = 1_650;
/** All together: off / on, three times. */
const FLASH_OFFS = [1_750, 2_050, 2_350] as const;
const FLASH_ON_AFTER_MS = 150;
/** Uneven flicker: one or two short dips per bulb. */
const FLICKER = { start: 2_520, end: 2_860 };
/** Then they die one by one, for good. */
const DIE = { start: 2_900, end: 3_330 };
/** A switch takes this long (a filament, not a cut). */
const SNAP_MS = 25;

export type Track = { values: number[]; times: number[] };
type Switch = { at: number; on: boolean };

/** The order bulbs die in: a fixed shuffle of 0..count-1. */
export function dieOrder(count = BULB_COUNT): number[] {
  return Array.from({ length: count }, (_, i) => i).sort((a, b) => jitter(a * 3.17 + 5) - jitter(b * 3.17 + 5));
}

function bulbSwitches(index: number, count: number): Switch[] {
  const out: Switch[] = [];
  const step = (CHASE_ON.end - CHASE_ON.start) / count;
  out.push({ at: CHASE_ON.start + index * step, on: true });
  const odd = index % 2 === 1;
  CHASE_ALTERNATE.forEach((at, k) => {
    // k even: odd bulbs off (evens stay on); k odd: the other way round.
    out.push({ at, on: k % 2 === 0 ? !odd : odd });
  });
  out.push({ at: ALL_ON_AT, on: true });
  for (const off of FLASH_OFFS) {
    out.push({ at: off, on: false });
    out.push({ at: off + FLASH_ON_AFTER_MS, on: true });
  }
  const span = FLICKER.end - FLICKER.start;
  const dips = jitter(index * 1.7 + 2) > -0.2 ? 2 : 1;
  for (let d = 0; d < dips; d++) {
    // Each dip in its own half of the flicker window, so they never overlap.
    const half = span / dips;
    const length = 40 + Math.round((jitter(index * 2.3 + d * 7 + 1) + 1) * 25); // 40–90 ms
    const room = half - length - SNAP_MS * 2;
    const at = FLICKER.start + d * half + Math.round(((jitter(index * 4.1 + d * 11 + 3) + 1) / 2) * room);
    out.push({ at, on: false });
    out.push({ at: at + length, on: true });
  }
  const rank = dieOrder(count).indexOf(index);
  out.push({ at: DIE.start + (rank * (DIE.end - DIE.start)) / Math.max(1, count - 1), on: false });
  return out;
}

/** Keyframes from on/off switches (each one a SNAP_MS ramp), normalised to `totalMs`. */
function trackFrom(switches: readonly Switch[], totalMs: number, low = 0, high = 1): Track {
  const sorted = [...switches].sort((a, b) => a.at - b.at);
  const points: [number, number][] = [[0, low]];
  let on = false;
  for (const s of sorted) {
    if (s.on === on) continue;
    const at = Math.max(s.at, points[points.length - 1][0]);
    points.push([at, on ? high : low]);
    points.push([Math.min(at + SNAP_MS, totalMs), s.on ? high : low]);
    on = s.on;
  }
  points.push([totalMs, on ? high : low]);
  return { values: points.map((p) => p[1]), times: points.map((p) => Number((p[0] / totalMs).toFixed(5))) };
}

/** Lit-layer opacity keyframes for bulb `index` over BLACKOUT_MS. */
export function bulbTrack(index: number, count = BULB_COUNT): Track {
  return trackFrom(bulbSwitches(index, count), BLACKOUT_MS);
}

/** The word: on with the first bulbs, dims with each flash, goes out after the last bulb. */
export function wordTrack(): Track {
  const switches: Switch[] = [{ at: 60, on: true }];
  for (const off of FLASH_OFFS) {
    switches.push({ at: off, on: false });
    switches.push({ at: off + FLASH_ON_AFTER_MS, on: true });
  }
  switches.push({ at: 2_680, on: false }, { at: 2_730, on: true });
  switches.push({ at: DIE.end + 60, on: false });
  return trackFrom(switches, BLACKOUT_MS, 0.22, 1);
}

/**
 * The value a track has at `ms` (linear between keyframes, like Motion plays
 * them). For tests and for checking a frame.
 */
export function trackValueAt(track: Track, ms: number, totalMs = BLACKOUT_MS): number {
  const t = ms / totalMs;
  const { values, times } = track;
  if (t <= times[0]) return values[0];
  for (let i = 1; i < times.length; i++) {
    if (t <= times[i]) {
      const span = times[i] - times[i - 1];
      if (span <= 0) return values[i];
      return values[i - 1] + ((values[i] - values[i - 1]) * (t - times[i - 1])) / span;
    }
  }
  return values[values.length - 1];
}

/** Bulb centres evenly spaced clockwise round a rectangle (from its top-left corner), in its own units. */
export function marqueePoints(
  count: number,
  box: { x: number; y: number; width: number; height: number },
): { x: number; y: number }[] {
  const { x, y, width, height } = box;
  const perimeter = 2 * (width + height);
  return Array.from({ length: count }, (_, i) => {
    let d = (i * perimeter) / count;
    if (d < width) return { x: x + d, y };
    d -= width;
    if (d < height) return { x: x + width, y: y + d };
    d -= height;
    if (d < width) return { x: x + width - d, y: y + height };
    d -= width;
    return { x, y: y + height - d };
  });
}
