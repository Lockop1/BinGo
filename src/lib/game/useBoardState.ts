"use client";

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { track } from "@/lib/analytics";
import { isBlackout } from "@/lib/game/bingo";
import { deriveBoard, type DisplaySquare } from "@/lib/game/boardState";
import {
  createPendingActions,
  isActionId,
  localPersistence,
  squareKey,
  type DroppedAction,
  type PendingAction,
  type PendingState,
  type PendingStore,
  type Settled,
} from "@/lib/game/pendingActions";
import { completeSquare, incrementSquare, undoCompletion } from "@/lib/game/rpc";
import type { Player, Square, SquareResult } from "@/lib/game/types";

/** Sends one queued action through its RPC (exported for the queue's unit tests). */
export function runPendingAction(action: PendingAction): Promise<SquareResult> {
  const args = { game_id: action.gameId, position: action.position };
  switch (action.kind) {
    case "complete":
      return completeSquare(args);
    case "increment":
      // The tap's client id makes the +1 idempotent (retries never double count). An id
      // that is not a UUID could only come from a queue saved by an older build; the server
      // would reject it on every retry, so that one +1 goes without the protection.
      return incrementSquare(action.gameId, action.position, isActionId(action.clientId) ? action.clientId : null);
    case "undo":
      return undoCompletion(args);
  }
}

/** `square_completed` analytics when this phone's complete / +1 crossed the square off (counts only). */
function trackCompletion(settled: Settled, squares: readonly Square[]) {
  const { action, outcome, row } = settled;
  if (outcome !== "applied" || action.kind === "undo" || !row || row.completed_at === null) return;
  const done = squares.filter((s) => (s.position === row.position ? row : s).completed_at !== null).length;
  track("square_completed", { counter: row.target_count > 1, total_completed: done });
}

/**
 * The settled row leaves no square open: the server has just ended the game
 * (`end_reason = 'blackout'`, in the same transaction as the 25th completion,
 * whoever made it), so the ended games row is fetched at once instead of
 * waiting for the next poll or Realtime event.
 */
export function settledIntoBlackout(squares: readonly Square[], row: Square | null): boolean {
  if (!row || row.completed_at === null) return false;
  const merged = squares.some((s) => s.position === row.position)
    ? squares.map((s) => (s.position === row.position ? row : s))
    : [...squares, row];
  return isBlackout(merged);
}

/** One queue per game (per tab), so nothing held for one game can leak into another. */
const stores = new Map<string, PendingStore>();
let listening = false;

function resumeAll() {
  stores.forEach((store) => store.resume());
}

/**
 * The queue for one game, created on first use and hydrated from
 * localStorage (`bingo.pending.<gameId>`), so taps made offline survive a
 * reload and still show as overlays. Every queue retries right away on
 * `online` and when the tab becomes visible; the screens also flush on mount.
 */
export function getPendingStore(gameId: string): PendingStore {
  const existing = stores.get(gameId);
  if (existing) return existing;
  const store = createPendingActions({ run: runPendingAction, persistence: localPersistence(gameId) });
  stores.set(gameId, store);
  if (typeof window !== "undefined" && !listening) {
    listening = true;
    window.addEventListener("online", resumeAll);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") resumeAll();
    });
  }
  return store;
}

const EMPTY: PendingState = { actions: [], inFlight: [], results: {}, outcomes: {}, dropped: [] };
const serverSnapshot = () => EMPTY;

export type PendingQueue = {
  /** Taps given up on (game already over, or queue overflow) whose notice has not been shown yet. */
  dropped: readonly DroppedAction[];
  acknowledge: (clientIds?: readonly string[]) => void;
};

/**
 * The game screen's handle on this game's queue, whatever it shows (board,
 * recap, not found): sends anything restored from storage on mount, and
 * exposes what was dropped so one notice can explain it even after the board
 * has gone (e.g. the game ended while the taps waited offline).
 */
export function usePendingQueue(gameId: string): PendingQueue {
  const store = getPendingStore(gameId);
  const state = useSyncExternalStore(store.subscribe, store.getState, serverSnapshot);
  useEffect(() => {
    store.flush();
  }, [store]);
  const acknowledge = useCallback((clientIds?: readonly string[]) => store.acknowledgeDropped(clientIds), [store]);
  return { dropped: state.dropped, acknowledge };
}

export type BoardStateOptions = {
  /** Fold a settled action's row into the game state (useGame's applySquare). */
  applySquare?: (row: Square) => void;
  /** Resync after a definitive failure (our view may be stale, e.g. the game ended). */
  refresh?: () => Promise<void> | void;
  /** Every settled action of this game (after applySquare). */
  onSettled?: (settled: Settled) => void;
};

export type BoardState = {
  /** The 25 displayed squares (server + this phone's pending overlays), by position. */
  board: DisplaySquare[];
  complete: (position: number) => void;
  /** +1 on a counter square: one queued action (its client id is the RPC's `action_id`). */
  increment: (position: number) => void;
  undo: (position: number) => void;
  /** The last settled action for a square (sheet copy: "Jake got it first", errors). */
  outcomeFor: (position: number) => Settled | undefined;
  clearOutcome: (position: number) => void;
  /** Actions of this game not yet confirmed by the server. */
  pendingCount: number;
  /** Retry now (e.g. tapping the sync indicator). */
  retry: () => void;
};

/**
 * The live board's view model: `useGame` squares + this phone's optimistic
 * actions (pendingActions.ts), derived by boardState.ts. Taps go into the
 * queue (RPCs only; nothing is written directly), and settled rows are folded
 * back into the game state through `applySquare`.
 */
export function useBoardState(
  gameId: string,
  squares: Square[],
  me: Player | null,
  options: BoardStateOptions = {},
): BoardState {
  const store = getPendingStore(gameId);
  const state = useSyncExternalStore(store.subscribe, store.getState, serverSnapshot);
  const board = useMemo(() => deriveBoard(squares, gameId, state), [squares, gameId, state]);

  const optionsRef = useRef(options);
  const squaresRef = useRef(squares);
  useEffect(() => {
    optionsRef.current = options;
    squaresRef.current = squares;
  });

  useEffect(
    () =>
      store.onSettled((settled) => {
        if (settled.action.gameId !== gameId) return;
        const { applySquare, refresh, onSettled } = optionsRef.current;
        if (settled.row) applySquare?.(settled.row);
        trackCompletion(settled, squaresRef.current);
        if (settled.outcome === "failed" || settledIntoBlackout(squaresRef.current, settled.row)) void refresh?.();
        onSettled?.(settled);
      }),
    [store, gameId],
  );

  // Anything already queued for this game (e.g. restored after a reload) goes out now.
  useEffect(() => {
    store.flush();
  }, [store, gameId]);

  /** The square as shown right now (handlers read the store directly, so quick taps see each other). */
  const shown = useCallback(
    (position: number) => deriveBoard(squaresRef.current, gameId, store.getState()).find((s) => s.position === position),
    [store, gameId],
  );

  const meId = me?.id ?? null;

  const complete = useCallback(
    (position: number) => {
      const square = shown(position);
      if (!meId || !square || square.completed_at !== null || square.target_count > 1) return;
      store.enqueue({ kind: "complete", gameId, position, playerId: meId });
    },
    [store, gameId, meId, shown],
  );

  const increment = useCallback(
    (position: number) => {
      const square = shown(position);
      if (!meId || !square || square.completed_at !== null || square.target_count <= 1) return;
      store.enqueue({ kind: "increment", gameId, position, playerId: meId });
    },
    [store, gameId, meId, shown],
  );

  const undo = useCallback(
    (position: number) => {
      const square = shown(position);
      if (!meId || !square || square.completed_at === null || square.completed_by_player_id === null) return;
      store.enqueue({
        kind: "undo",
        gameId,
        position,
        playerId: meId,
        expectedCompleter: square.completed_by_player_id,
      });
    },
    [store, gameId, meId, shown],
  );

  const outcomeFor = useCallback(
    (position: number) => state.outcomes[squareKey(gameId, position)],
    [state, gameId],
  );
  const clearOutcome = useCallback((position: number) => store.clearOutcome(gameId, position), [store, gameId]);
  const pendingCount = useMemo(() => state.actions.filter((a) => a.gameId === gameId).length, [state, gameId]);

  return { board, complete, increment, undo, outcomeFor, clearOutcome, pendingCount, retry: store.resume };
}
