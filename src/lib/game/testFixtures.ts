import type { PendingAction } from "@/lib/game/pendingActions";
import type { Square, SquareResult } from "@/lib/game/types";

/** Shared fixtures for the board unit tests (not imported by app code). */

export const GAME_ID = "11111111-1111-4111-8111-111111111111";
export const ME = "player-me";
export const JAKE = "player-jake";
export const HOST = "player-host";

export function stamp(n: number): string {
  // Microsecond-precision Postgres-style timestamps, strictly increasing with n.
  return `2026-10-23T21:00:00.${String(n).padStart(6, "0")}+00:00`;
}

export function square(position: number, overrides: Partial<Square> = {}): Square {
  return {
    id: `sq-${position}`,
    game_id: GAME_ID,
    position,
    label: `Square ${position}`,
    details: "",
    target_count: 1,
    current_count: 0,
    completed_by_player_id: null,
    completed_at: null,
    updated_at: stamp(1),
    ...overrides,
  };
}

export function board(overrides: Record<number, Partial<Square>> = {}): Square[] {
  return Array.from({ length: 25 }, (_, p) => square(p, overrides[p]));
}

export function completedBy(player: string | null, n: number, extra: Partial<Square> = {}): Partial<Square> {
  return { completed_by_player_id: player, completed_at: stamp(n), current_count: 1, updated_at: stamp(n), ...extra };
}

export function result(row: Square, applied: boolean): SquareResult {
  return { ...row, applied };
}

/** A runner whose calls the test settles by hand, in any order. */
export function deferredRunner() {
  type Call = {
    action: PendingAction;
    resolve: (value: SquareResult) => void;
    reject: (error: unknown) => void;
  };
  const calls: Call[] = [];
  const run = (action: Call["action"]) =>
    new Promise<SquareResult>((resolve, reject) => {
      calls.push({ action: { ...action }, resolve, reject });
    });
  return { run, calls };
}

/** Manual clock + timers (no global fake timers needed). */
export function manualClock(start = 1_000_000) {
  let t = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (id: unknown) => {
      timers.delete(id as number);
    },
    pending: () => timers.size,
    /** Moves time forward, firing due timers in order (including ones they schedule). */
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | null = null;
        for (const entry of timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
        if (!next) break;
        timers.delete(next[0]);
        t = Math.max(t, next[1].at);
        next[1].fn();
      }
      t = end;
    },
  };
}

/** Lets pending promise callbacks run. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export const PG = (message: string) => ({ code: "P0001", message, details: null, hint: null });
export const NETWORK = () => new TypeError("Failed to fetch");
