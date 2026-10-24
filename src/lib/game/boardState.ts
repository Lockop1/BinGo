import { squareKey, type PendingAction, type PendingKind, type PendingState } from "@/lib/game/pendingActions";
import { isNewerSquare, timestampMicros } from "@/lib/game/realtime";
import type { Square } from "@/lib/game/types";

/**
 * What the live board shows: `server + pending overlays`.
 *
 * 1. Base: per square, the newer (by `updated_at`) of the server snapshot row
 *    and this phone's last RPC result row. So a settled action's result shows
 *    at once, and anything newer from the server (Realtime event, refetch)
 *    replaces it.
 * 2. Overlays: this phone's unsettled actions for the square, applied in tap
 *    order on top of the base. A refetch that still shows the square open
 *    therefore never flips a pending completion back. A counter shows
 *    `base.current_count + pending +1s` (capped at the target): the server
 *    counts every tap once, so nothing is predicted from the count this phone
 *    saw when tapping.
 *
 * Only predictions: the RPC result always wins once it arrives.
 */

export type DisplaySquare = Square & {
  /** Free center: crossed off by nobody. */
  free: boolean;
  /** One of this phone's actions is still in the air and changes what is shown. */
  pending: boolean;
  /** The last overlay that changed the square (null when nothing is pending). */
  pendingKind: PendingKind | null;
  /** The authoritative row under the overlays. */
  base: Square;
  /** `base` is exactly the row returned by this phone's own applied action. */
  ownBase: boolean;
};

export function isFreeSquare(square: Pick<Square, "completed_at" | "completed_by_player_id">): boolean {
  return square.completed_at !== null && square.completed_by_player_id === null;
}

export function sameVersion(a: Pick<Square, "updated_at">, b: Pick<Square, "updated_at">): boolean {
  const x = timestampMicros(a.updated_at);
  const y = timestampMicros(b.updated_at);
  return Number.isNaN(x) || Number.isNaN(y) ? a.updated_at === b.updated_at : x === y;
}

type Shown = Pick<Square, "completed_by_player_id" | "completed_at" | "current_count">;

/** One overlay step. Returns the same object when the action changes nothing. */
function applyAction(shown: Shown, action: PendingAction, target: number): Shown {
  switch (action.kind) {
    case "complete":
      if (shown.completed_at !== null || target > 1) return shown;
      return { completed_by_player_id: action.playerId, completed_at: action.createdAt, current_count: target };
    case "increment": {
      if (shown.completed_at !== null || target <= 1) return shown;
      const count = Math.min(target, shown.current_count + 1);
      if (count === shown.current_count) return shown;
      return count >= target
        ? { completed_by_player_id: action.playerId, completed_at: action.createdAt, current_count: count }
        : { ...shown, current_count: count };
    }
    case "undo": {
      if (shown.completed_at === null || shown.completed_by_player_id === null) return shown;
      if (action.expectedCompleter != null && action.expectedCompleter !== shown.completed_by_player_id) return shown;
      return { completed_by_player_id: null, completed_at: null, current_count: Math.max(0, target - 1) };
    }
  }
}

/** Overlays `actions` (this square's, in tap order) on `base`. */
export function overlaySquare(base: Square, actions: readonly PendingAction[], ownBase = false): DisplaySquare {
  let shown: Shown = base;
  let pendingKind: PendingKind | null = null;
  for (const action of actions) {
    const next = applyAction(shown, action, base.target_count);
    if (next !== shown) {
      shown = next;
      pendingKind = action.kind;
    }
  }
  const pending =
    shown.completed_at !== base.completed_at ||
    shown.completed_by_player_id !== base.completed_by_player_id ||
    shown.current_count !== base.current_count;
  return {
    ...base,
    completed_by_player_id: shown.completed_by_player_id,
    completed_at: shown.completed_at,
    current_count: shown.current_count,
    free: isFreeSquare(shown),
    pending,
    pendingKind: pending ? pendingKind : null,
    base,
    ownBase,
  };
}

/** The newer of the server row and this phone's last RPC result for each square. */
export function mergeBase(squares: readonly Square[], gameId: string, results: PendingState["results"]): Square[] {
  return squares.map((row) => {
    const held = results[squareKey(gameId, row.position)];
    if (held && held.row.id === row.id && isNewerSquare(held.row, row)) return held.row;
    return row;
  });
}

/** The displayed board for one game, sorted by position. */
export function deriveBoard(
  squares: readonly Square[],
  gameId: string,
  pending: Pick<PendingState, "actions" | "results">,
): DisplaySquare[] {
  const byPosition = new Map<number, PendingAction[]>();
  for (const action of pending.actions) {
    if (action.gameId !== gameId) continue;
    const list = byPosition.get(action.position);
    if (list) list.push(action);
    else byPosition.set(action.position, [action]);
  }
  return mergeBase(squares, gameId, pending.results)
    .map((base) => {
      const held = pending.results[squareKey(gameId, base.position)];
      const ownBase = Boolean(held && held.applied && held.row.id === base.id && sameVersion(held.row, base));
      return overlaySquare(base, byPosition.get(base.position) ?? [], ownBase);
    })
    .sort((a, b) => a.position - b.position);
}

// ---------------------------------------------------------------------------
// What changed between two displayed boards (toasts, haptics)

export type BoardEvent =
  /** Someone else crossed a square off (server data, not this phone's action). */
  | { type: "completed"; position: number; by: string }
  /** Someone else reopened a square that `previousBy` had crossed off. */
  | { type: "undone"; position: number; previousBy: string }
  /** This phone's player now shows as having crossed it off (own tap). */
  | { type: "own_completed"; position: number };

/**
 * Diff of two consecutive displayed boards. Server-side news (`completed`,
 * `undone`) is only reported when the authoritative row moved to a strictly
 * newer version that this phone did not produce itself, so the initial load,
 * re-deliveries of rows already on screen and this phone's own actions never
 * produce a toast.
 */
export function diffBoards(
  prev: readonly DisplaySquare[],
  next: readonly DisplaySquare[],
  meId: string | null,
): BoardEvent[] {
  const before = new Map(prev.map((s) => [s.position, s]));
  const events: BoardEvent[] = [];
  for (const n of next) {
    const p = before.get(n.position);
    if (!p) continue;

    if (
      p.completed_at === null &&
      n.completed_at !== null &&
      meId !== null &&
      n.completed_by_player_id === meId &&
      n.pending
    ) {
      events.push({ type: "own_completed", position: n.position });
    }

    if (!isNewerSquare(n.base, p.base) || n.ownBase) continue;
    const was = p.base;
    const now = n.base;
    if (
      now.completed_at !== null &&
      now.completed_by_player_id !== null &&
      now.completed_by_player_id !== meId &&
      (was.completed_at === null || was.completed_by_player_id !== now.completed_by_player_id)
    ) {
      events.push({ type: "completed", position: n.position, by: now.completed_by_player_id });
    } else if (
      now.completed_at === null &&
      was.completed_at !== null &&
      was.completed_by_player_id !== null &&
      n.pendingKind !== "undo"
    ) {
      events.push({ type: "undone", position: n.position, previousBy: was.completed_by_player_id });
    }
  }
  return events;
}
