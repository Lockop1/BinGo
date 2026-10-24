"use client";

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { deriveBoard, type DisplaySquare } from "@/lib/game/boardState";
import {
  createPendingActions,
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

function runPendingAction(action: PendingAction): Promise<SquareResult> {
  const args = { game_id: action.gameId, position: action.position };
  switch (action.kind) {
    case "complete":
      return completeSquare(args);
    case "increment":
      return incrementSquare(
        action.expectedCount === undefined ? args : { ...args, expected_count: action.expectedCount },
      );
    case "undo":
      return undoCompletion(args);
  }
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
  /** +1 on a counter square, sending the count currently shown as `expected_count`. */
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
        if (settled.outcome === "failed") void refresh?.();
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
      store.enqueue({ kind: "increment", gameId, position, playerId: meId, expectedCount: square.current_count });
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
