import { linePositions } from "@/lib/game/bingo";
import { BOARD_SIZE } from "@/lib/game/types";
import { readLocal, writeLocal } from "@/lib/storage/local";

/**
 * Bingo celebrations, per game and per phone.
 *
 * - The tracker remembers which lines (and the blackout) this phone already
 *   celebrated, in localStorage (`bingo.celebrated.<gameId>`), so a reload,
 *   an undo + re-complete or a late Realtime/poll delivery never celebrates
 *   the same line twice. Lines already complete when the board mounts are
 *   counted as celebrated without a party (old news).
 * - The queue plays one celebration at a time through its phases:
 *   `highlight` (the line pulses on the grid) → `overlay` ("BINGO!") → next.
 *   (A blackout no longer asks the host to end the game: the server ends it
 *   by itself when the 25th square is crossed off, `end_reason = 'blackout'`.)
 */

export const BLACKOUT_ID = "blackout";

export function celebratedKey(gameId: string): `bingo.celebrated.${string}` {
  return `bingo.celebrated.${gameId}`;
}

export type CelebratedStore = {
  load(gameId: string): string[];
  save(gameId: string, ids: string[]): void;
};

export const localCelebratedStore: CelebratedStore = {
  load(gameId) {
    const value = readLocal(celebratedKey(gameId));
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  },
  save(gameId, ids) {
    writeLocal(celebratedKey(gameId), ids);
  },
};

/** In-memory store (tests). */
export function memoryCelebratedStore(initial: Record<string, string[]> = {}): CelebratedStore & {
  data: Record<string, string[]>;
} {
  const data: Record<string, string[]> = { ...initial };
  return {
    data,
    load: (gameId) => [...(data[gameId] ?? [])],
    save: (gameId, ids) => {
      data[gameId] = [...ids];
    },
  };
}

export type CelebrationEvent = {
  /** Unique per tracker. */
  id: string;
  /** Lines celebrated for the first time (LINES order). */
  lines: string[];
  /** The board just went 25/25 for the first time. */
  blackout: boolean;
  /** Cells to highlight. */
  positions: number[];
};

export type CelebrationTracker = {
  /** The board mounted: whatever is complete now is old news. */
  seed(lines: readonly string[], blackout: boolean): void;
  /** A newer board: a celebration for lines/blackout complete for the first time, or null. */
  observe(lines: readonly string[], blackout: boolean): CelebrationEvent | null;
  has(id: string): boolean;
};

const ALL_POSITIONS = Array.from({ length: BOARD_SIZE }, (_, i) => i);

export function createCelebrationTracker(
  gameId: string,
  store: CelebratedStore = localCelebratedStore,
): CelebrationTracker {
  const celebrated = new Set(store.load(gameId));
  let count = 0;
  const persist = () => store.save(gameId, [...celebrated]);

  return {
    seed(lines, blackout) {
      let changed = false;
      for (const id of blackout ? [...lines, BLACKOUT_ID] : lines) {
        if (!celebrated.has(id)) {
          celebrated.add(id);
          changed = true;
        }
      }
      if (changed) persist();
    },
    observe(lines, blackout) {
      const fresh = lines.filter((id) => !celebrated.has(id));
      const freshBlackout = blackout && !celebrated.has(BLACKOUT_ID);
      if (fresh.length === 0 && !freshBlackout) return null;
      fresh.forEach((id) => celebrated.add(id));
      if (freshBlackout) celebrated.add(BLACKOUT_ID);
      persist();
      count += 1;
      return {
        id: `${gameId}:${count}`,
        lines: fresh,
        blackout: freshBlackout,
        positions: freshBlackout ? ALL_POSITIONS : linePositions(fresh),
      };
    },
    has: (id) => celebrated.has(id),
  };
}

// ---------------------------------------------------------------------------
// Playback queue

export type CelebrationPhase = "highlight" | "overlay";

export type ActiveCelebration = CelebrationEvent & {
  phase: CelebrationPhase;
  /** Palette index of whoever crossed off the square that finished it (null: unknown / free). */
  color: number | null;
};

export type CelebrationQueueState = {
  current: ActiveCelebration | null;
  /** Celebrations started since this queue was created (exposed for tests and e2e). */
  shown: number;
};

export const CELEBRATION_TIMING = {
  highlightMs: 800,
  bingoMs: 1500,
  blackoutMs: 2500,
};

type Timer = unknown;

export type CelebrationQueueOptions = {
  timing?: Partial<typeof CELEBRATION_TIMING>;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
};

export type CelebrationQueue = {
  push(event: CelebrationEvent, extra?: { color?: number | null }): void;
  /** Skip ahead: highlight → overlay → next. */
  dismiss(): void;
  getState(): CelebrationQueueState;
  subscribe(listener: () => void): () => void;
  dispose(): void;
};

export function createCelebrationQueue(options: CelebrationQueueOptions = {}): CelebrationQueue {
  const timing = { ...CELEBRATION_TIMING, ...options.timing };
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const waiting: Omit<ActiveCelebration, "phase">[] = [];
  const listeners = new Set<() => void>();
  let state: CelebrationQueueState = { current: null, shown: 0 };
  let timer: Timer | null = null;

  const set = (next: CelebrationQueueState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  const stop = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const schedule = (ms: number) => {
    stop();
    timer = setTimer(() => {
      timer = null;
      advance();
    }, ms);
  };

  function startNext() {
    const next = waiting.shift();
    if (!next) {
      if (state.current) set({ ...state, current: null });
      return;
    }
    set({ current: { ...next, phase: "highlight" }, shown: state.shown + 1 });
    schedule(timing.highlightMs);
  }

  function advance() {
    const current = state.current;
    if (!current) return;
    if (current.phase === "highlight") {
      set({ ...state, current: { ...current, phase: "overlay" } });
      schedule(current.blackout ? timing.blackoutMs : timing.bingoMs);
      return;
    }
    startNext();
  }

  return {
    push(event, extra = {}) {
      waiting.push({ ...event, color: extra.color ?? null });
      if (!state.current) startNext();
    },
    dismiss() {
      stop();
      advance();
    },
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      stop();
      waiting.length = 0;
      listeners.clear();
    },
  };
}
