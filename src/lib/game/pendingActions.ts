import { toGameError, type GameErrorCode } from "@/lib/game/errors";
import { isNewerSquare } from "@/lib/game/realtime";
import type { Square, SquareResult } from "@/lib/game/types";
import { readLocal, removeLocal, writeLocal } from "@/lib/storage/local";

/**
 * Optimistic completions: a small queue of this phone's square actions
 * (complete / +1 / undo), independent of React.
 *
 * - `enqueue` records the intent; the board immediately shows it as an overlay
 *   on top of the server state (see boardState.ts), so a tap crosses the
 *   square off at once, even offline.
 * - `flush` sends actions through the RPCs: one at a time per square (in tap
 *   order), squares in parallel, only while the browser says it is online.
 *   Network / unknown failures (and `countdown_in_progress`, a tap that beat
 *   the server's start countdown) retry with exponential backoff (max ~30 s);
 *   `resume` (on `online` / tab visible) retries right away.
 * - Every action has a client id (a UUID). A counter +1 sends it as
 *   `increment_square`'s `action_id`, so the server counts each tap exactly
 *   once: a retry of a tap that already landed (lost response, reload) is
 *   recognised, while taps from different phones, or offline ones sent
 *   later, all count. Nothing is compared against the count this phone saw.
 * - Settling an action stores the returned `square_result` row as the
 *   authoritative view of that square (so there is no flash between "pending"
 *   and the refetched row) and drops the overlay. `applied = false` is not an
 *   error: the returned row (e.g. someone else got it first; for a +1, this
 *   tap was already counted or the square was already complete) simply wins.
 *   A definitive game error (`game_not_active`, `not_allowed`, …) drops the
 *   action and is reported once.
 * - The game is over (`game_not_active` / `game_not_found`): the server will
 *   refuse every other queued action of that game too, so they are all
 *   dropped at once and listed in `dropped` for one short notice.
 * - At most `maxActions` (~50) items wait; beyond that the oldest unsent one is
 *   dropped (also listed in `dropped`), so the queue never grows unbounded.
 * - Queued items are plain JSON (no functions), saved through a pluggable
 *   `persistence` (memory by default; `localPersistence(gameId)` keeps them in
 *   localStorage under `bingo.pending.<gameId>` so they survive a reload).
 *
 * The server stays the authority: nothing here decides whether a completion
 * is allowed, it only predicts and then adopts what the RPC returns.
 */

export type PendingKind = "complete" | "increment" | "undo";

export type PendingAction = {
  /**
   * Client-generated id of this action (a UUID from `newActionId`). Kept
   * across retries and reloads; a +1 sends it as `action_id`.
   */
  clientId: string;
  kind: PendingKind;
  gameId: string;
  position: number;
  /** The acting player (this phone's player row), shown as the predicted completer. */
  playerId: string;
  /** undo: the completer shown when Undo was tapped (null: unknown). */
  expectedCompleter?: string | null;
  /**
   * undo queued behind another action on the same square that may already
   * have reached the server: it only goes out if, once that action settles,
   * the square is still completed by `expectedCompleter`.
   */
  afterClientId?: string;
  /** ISO time of the tap (the optimistic `completed_at`). */
  createdAt: string;
  /** Sends attempted so far; > 0 means the server may already have applied it. */
  attempts: number;
  /** Epoch ms before which a retry is not attempted (backoff). */
  nextAttemptAt?: number;
};

export type EnqueueInput = {
  kind: PendingKind;
  gameId: string;
  position: number;
  playerId: string;
  expectedCompleter?: string | null;
  clientId?: string;
};

export type EnqueueResult =
  | { status: "queued"; action: PendingAction }
  /** The same intent is already waiting for this square (ignored). */
  | { status: "duplicate"; clientId: string }
  /** The new intent cancelled an unsent opposite one (e.g. undo of an unsent complete). */
  | { status: "cancelled"; clientId: string };

/** `dropped`: removed from the queue unsent because it grew past `maxActions`. */
export type SettleOutcome = "applied" | "not_applied" | "failed" | "skipped" | "cancelled" | "dropped";

export type Settled = {
  action: PendingAction;
  outcome: SettleOutcome;
  /** The authoritative square after the call (`applied` and `not_applied`). */
  row: Square | null;
  /** `failed`: the definitive error. */
  errorCode: GameErrorCode | null;
};

/** The latest RPC result row per square, held until a newer server row replaces it. */
export type ResultEntry = { row: Square; kind: PendingKind; applied: boolean; clientId: string };

/** Why a tap never reached the server: the game was already over, or the queue overflowed. */
export type DropReason = "game_over" | "overflow";

export type DroppedAction = { action: PendingAction; reason: DropReason; errorCode: GameErrorCode | null };

export type PendingState = {
  actions: readonly PendingAction[];
  inFlight: readonly string[];
  results: Readonly<Record<string, ResultEntry>>;
  /** The last settled action per square (for the sheet: "Jake got it first", error copy). */
  outcomes: Readonly<Record<string, Settled>>;
  /** Taps that were given up on, until the UI has shown its notice (`acknowledgeDropped`). */
  dropped: readonly DroppedAction[];
};

export type PendingPersistence = {
  load(): readonly unknown[] | null;
  save(actions: readonly PendingAction[]): void;
};

export type PendingRunner = (action: PendingAction) => Promise<SquareResult>;

type Timer = unknown;

export type PendingOptions = {
  run: PendingRunner;
  persistence?: PendingPersistence;
  isOnline?: () => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  random?: () => number;
  createId?: () => string;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Queue cap; beyond it the oldest unsent action is dropped. */
  maxActions?: number;
};

export type PendingStore = {
  getState(): PendingState;
  subscribe(listener: () => void): () => void;
  onSettled(listener: (settled: Settled) => void): () => void;
  enqueue(input: EnqueueInput): EnqueueResult;
  /** Send whatever is due (no-op while offline). */
  flush(): void;
  /** Back online / back in the tab: retry everything now, ignoring backoff. */
  resume(): void;
  clearOutcome(gameId: string, position: number): void;
  /** The notice for these dropped actions was shown (all of them when omitted). */
  acknowledgeDropped(clientIds?: readonly string[]): void;
  /** Forget everything held for one game. */
  clearGame(gameId: string): void;
  dispose(): void;
};

export const BASE_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 30_000;
export const MAX_PENDING_ACTIONS = 50;

export function squareKey(gameId: string, position: number): string {
  return `${gameId}:${position}`;
}

const keyOf = (a: Pick<PendingAction, "gameId" | "position">) => squareKey(a.gameId, a.position);

/**
 * Network trouble, no session yet, or the start countdown still running on the
 * server (a phone whose clock runs a little ahead shows the board early; the
 * countdown clears within seconds): worth retrying. Everything else is the
 * server's final answer.
 */
const TRANSIENT = new Set<GameErrorCode>(["unknown", "not_authenticated", "countdown_in_progress"]);

export function isDefinitiveError(code: GameErrorCode): boolean {
  return !TRANSIENT.has(code);
}

/** The game no longer takes completions (ended, past its deadline, deleted, or not ours): nothing queued for it can land. */
const GAME_OVER = new Set<GameErrorCode>(["game_not_active", "game_not_found"]);

export function isGameOverError(code: GameErrorCode): boolean {
  return GAME_OVER.has(code);
}

/** Exponential backoff for the n-th failed attempt (1-based), ±20% jitter, capped. */
export function backoffMs(
  attempts: number,
  { base = BASE_BACKOFF_MS, max = MAX_BACKOFF_MS, random = Math.random }: { base?: number; max?: number; random?: () => number } = {},
): number {
  const exp = Math.min(max, base * 2 ** Math.max(0, attempts - 1));
  return Math.min(max, Math.round(exp * (0.8 + random() * 0.4)));
}

const KINDS = new Set<PendingKind>(["complete", "increment", "undo"]);

/**
 * Shape check for restored items (persistence may hold anything). Items saved
 * before +1s carried action ids may still have an `expectedCount`: it is
 * ignored (and stripped on restore), the item stays valid.
 */
export function isPendingAction(value: unknown): value is PendingAction {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.clientId === "string" &&
    typeof a.kind === "string" &&
    KINDS.has(a.kind as PendingKind) &&
    typeof a.gameId === "string" &&
    typeof a.position === "number" &&
    Number.isInteger(a.position) &&
    typeof a.playerId === "string" &&
    typeof a.createdAt === "string" &&
    typeof a.attempts === "number" &&
    (a.expectedCompleter === undefined || a.expectedCompleter === null || typeof a.expectedCompleter === "string") &&
    (a.afterClientId === undefined || typeof a.afterClientId === "string")
  );
}

/** Default persistence: keeps the queue in memory only (lost on reload). */
export function memoryPersistence(initial: readonly unknown[] = []): PendingPersistence & {
  saved(): PendingAction[];
} {
  let saved: PendingAction[] = initial.filter(isPendingAction);
  return {
    load: () => saved,
    save: (actions) => {
      saved = actions.map((a) => ({ ...a }));
    },
    saved: () => saved,
  };
}

export function pendingKey(gameId: string): `bingo.pending.${string}` {
  return `bingo.pending.${gameId}`;
}

/**
 * localStorage persistence for one game's queue (`bingo.pending.<gameId>`).
 * Reads never throw: corrupt JSON or a non-array is ignored, items are
 * shape-checked (and must belong to this game) by `createPendingActions`.
 * An empty queue removes the key.
 */
export function localPersistence(gameId: string): PendingPersistence {
  const key = pendingKey(gameId);
  return {
    load() {
      const value = readLocal(key) as unknown;
      if (!Array.isArray(value)) return null;
      return value.filter((item) => isPendingAction(item) && item.gameId === gameId);
    },
    save(actions) {
      const mine = actions.filter((a) => a.gameId === gameId);
      if (mine.length === 0) removeLocal(key);
      else writeLocal(key, mine);
    },
  };
}

function defaultIsOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a UUID, i.e. a client id the server accepts as `action_id`. */
export function isActionId(id: string): boolean {
  return UUID.test(id);
}

/** Formats 16 random bytes as an RFC 4122 version 4 UUID. */
export function uuidFromBytes(bytes: Uint8Array): string {
  const b = Uint8Array.from(bytes.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * A fresh action id: always a v4 UUID (the server's `action_id` is a uuid
 * column; anything else would be rejected on every retry). `randomUUID` is
 * missing in insecure contexts (plain http on a LAN address), where
 * `getRandomValues` still works.
 */
export function newActionId(): string {
  try {
    if (typeof crypto !== "undefined") {
      if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
      if (typeof crypto.getRandomValues === "function") return uuidFromBytes(crypto.getRandomValues(new Uint8Array(16)));
    }
  } catch {
    // Fall through to Math.random.
  }
  return uuidFromBytes(Uint8Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)));
}

/** Strip the `applied` flag: what is left is a plain squares row. */
function toSquare(result: SquareResult): Square {
  const row: Partial<SquareResult> = { ...result };
  delete row.applied;
  return row as Square;
}

function withoutChain(action: PendingAction): PendingAction {
  const copy = { ...action };
  delete copy.afterClientId;
  return copy;
}

/** A chained undo still makes sense: the square is completed by whoever the player meant to undo. */
function chainHolds(undo: PendingAction, row: Square | null): boolean {
  if (!row || row.completed_at === null || row.completed_by_player_id === null) return false;
  return undo.expectedCompleter == null || row.completed_by_player_id === undo.expectedCompleter;
}

export function createPendingActions(options: PendingOptions): PendingStore {
  const {
    run,
    persistence = memoryPersistence(),
    isOnline = defaultIsOnline,
    now = Date.now,
    random = Math.random,
    createId = newActionId,
    baseBackoffMs = BASE_BACKOFF_MS,
    maxBackoffMs = MAX_BACKOFF_MS,
    maxActions = MAX_PENDING_ACTIONS,
  } = options;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));

  // Restored items were possibly mid-flight: they count as attempted (in doubt).
  // Unreadable storage counts as empty; the newest `maxActions` are kept.
  let loaded: readonly unknown[] = [];
  try {
    const value = persistence.load();
    if (Array.isArray(value)) loaded = value;
  } catch {
    loaded = [];
  }
  const restored = loaded
    .filter(isPendingAction)
    .map((a) => {
      const copy: PendingAction & { expectedCount?: unknown } = { ...a };
      delete copy.nextAttemptAt;
      delete copy.expectedCount; // saved before +1s carried action ids
      return copy as PendingAction;
    })
    .slice(-Math.max(1, maxActions));

  let state: PendingState = { actions: restored, inFlight: [], results: {}, outcomes: {}, dropped: [] };
  const listeners = new Set<() => void>();
  const settledListeners = new Set<(settled: Settled) => void>();
  const timers = new Set<Timer>();
  let disposed = false;

  function commit(patch: Partial<PendingState>, persist: boolean) {
    state = { ...state, ...patch };
    if (persist) {
      try {
        persistence.save(state.actions);
      } catch {
        // Storage full or unavailable: the queue still lives in memory.
      }
    }
    listeners.forEach((listener) => listener());
  }

  function emit(settled: Settled) {
    settledListeners.forEach((listener) => listener(settled));
  }

  function withoutOutcome(key: string): PendingState["outcomes"] {
    if (!(key in state.outcomes)) return state.outcomes;
    const outcomes = { ...state.outcomes };
    delete outcomes[key];
    return outcomes;
  }

  const isUnsent = (a: PendingAction) => a.attempts === 0 && !state.inFlight.includes(a.clientId);

  function cancel(action: PendingAction, key: string): EnqueueResult {
    commit(
      { actions: state.actions.filter((a) => a.clientId !== action.clientId), outcomes: withoutOutcome(key) },
      true,
    );
    emit({ action, outcome: "cancelled", row: null, errorCode: null });
    return { status: "cancelled", clientId: action.clientId };
  }

  function enqueue(input: EnqueueInput): EnqueueResult {
    const key = squareKey(input.gameId, input.position);
    const forSquare = state.actions.filter((a) => keyOf(a) === key);
    const last = forSquare[forSquare.length - 1];

    // (f) The same intent is already waiting: ignore the repeat tap. (Every +1
    // is its own tap with its own id, so increments are never duplicates.)
    if (input.kind === "complete" && last?.kind === "complete") return { status: "duplicate", clientId: last.clientId };
    if (input.kind === "undo" && last?.kind === "undo") return { status: "duplicate", clientId: last.clientId };

    // (g) Undo of a completion that never left the phone: drop both locally.
    if (input.kind === "undo" && last?.kind === "complete" && isUnsent(last)) return cancel(last, key);
    // …and the mirror: re-completing right after an unsent undo of my own completion.
    if (
      input.kind === "complete" &&
      last?.kind === "undo" &&
      isUnsent(last) &&
      last.expectedCompleter === input.playerId
    ) {
      return cancel(last, key);
    }

    const action: PendingAction = {
      clientId: input.clientId ?? createId(),
      kind: input.kind,
      gameId: input.gameId,
      position: input.position,
      playerId: input.playerId,
      createdAt: new Date(now()).toISOString(),
      attempts: 0,
    };
    if (input.kind === "undo") {
      action.expectedCompleter = input.expectedCompleter ?? null;
      // Something on this square is still in the air: decide once it lands.
      if (last) action.afterClientId = last.clientId;
    }

    commit({ actions: [...state.actions, action], outcomes: withoutOutcome(key) }, true);
    trim();
    flush();
    return { status: "queued", action };
  }

  /** Over the cap: drop the oldest actions that are not on the wire (an in-flight one may still land). */
  function trim() {
    const excess = state.actions.length - Math.max(1, maxActions);
    if (excess <= 0) return;
    const victims = state.actions.filter((a) => !state.inFlight.includes(a.clientId)).slice(0, excess);
    if (victims.length === 0) return;
    const ids = new Set(victims.map((a) => a.clientId));
    commit(
      {
        actions: state.actions.filter((a) => !ids.has(a.clientId)),
        dropped: [...state.dropped, ...victims.map((action) => ({ action, reason: "overflow" as const, errorCode: null }))],
      },
      true,
    );
    victims.forEach((action) => emit({ action, outcome: "dropped", row: null, errorCode: null }));
  }

  /**
   * The server said the game is over: every other unsent action of that game
   * would get the same answer, so they go too (one notice for all of them).
   */
  function dropGame(failed: PendingAction, code: GameErrorCode) {
    const rest = state.actions.filter(
      (a) => a.gameId === failed.gameId && a.clientId !== failed.clientId && !state.inFlight.includes(a.clientId),
    );
    const ids = new Set(rest.map((a) => a.clientId));
    const outcomes = { ...state.outcomes };
    const settledRest: Settled[] = rest.map((action) => ({ action, outcome: "failed", row: null, errorCode: code }));
    for (const settled of settledRest) outcomes[keyOf(settled.action)] = settled;
    commit(
      {
        actions: state.actions.filter((a) => !ids.has(a.clientId)),
        outcomes,
        dropped: [...state.dropped, ...[failed, ...rest].map((action) => ({ action, reason: "game_over" as const, errorCode: code }))],
      },
      true,
    );
    settledRest.forEach(emit);
  }

  function schedule(ms: number) {
    const timer = setTimer(() => {
      timers.delete(timer);
      flush();
    }, ms);
    timers.add(timer);
  }

  function settle(action: PendingAction, outcome: SettleOutcome, row: Square | null, errorCode: GameErrorCode | null) {
    const key = keyOf(action);
    let results = state.results;
    if (row) {
      const held = results[key];
      if (!held || !isNewerSquare(held.row, row)) {
        results = { ...results, [key]: { row, kind: action.kind, applied: outcome === "applied", clientId: action.clientId } };
      }
    }
    const settled: Settled = { action, outcome, row, errorCode };
    const skipped: Settled[] = [];
    const actions = state.actions.flatMap((a) => {
      if (a.clientId === action.clientId) return [];
      if (a.kind !== "undo" || a.afterClientId !== action.clientId) return [a];
      if (chainHolds(a, row)) return [withoutChain(a)];
      skipped.push({ action: a, outcome: "skipped", row, errorCode: null });
      return [];
    });
    commit({ actions, results, outcomes: { ...state.outcomes, [key]: settled } }, true);
    emit(settled);
    skipped.forEach(emit);
  }

  async function send(action: PendingAction) {
    const sending: PendingAction = { ...action, attempts: action.attempts + 1 };
    delete sending.nextAttemptAt;
    commit(
      {
        actions: state.actions.map((a) => (a.clientId === action.clientId ? sending : a)),
        inFlight: [...state.inFlight, action.clientId],
      },
      true,
    );

    let result: SquareResult;
    try {
      result = await run(sending);
    } catch (error) {
      if (disposed) return;
      const inFlight = state.inFlight.filter((id) => id !== action.clientId);
      const current = state.actions.find((a) => a.clientId === action.clientId);
      if (!current) {
        commit({ inFlight }, false);
      } else {
        const code = toGameError(error).code;
        if (isDefinitiveError(code)) {
          state = { ...state, inFlight };
          settle(current, "failed", null, code);
          if (isGameOverError(code)) dropGame(current, code);
        } else {
          const delay = backoffMs(current.attempts, { base: baseBackoffMs, max: maxBackoffMs, random });
          const retrying = { ...current, nextAttemptAt: now() + delay };
          commit({ inFlight, actions: state.actions.map((a) => (a.clientId === action.clientId ? retrying : a)) }, true);
          schedule(delay);
        }
      }
      flush();
      return;
    }

    if (disposed) return;
    const inFlight = state.inFlight.filter((id) => id !== action.clientId);
    const current = state.actions.find((a) => a.clientId === action.clientId) ?? sending;
    state = { ...state, inFlight };
    settle(current, result.applied ? "applied" : "not_applied", toSquare(result), null);
    flush();
  }

  function flush() {
    if (disposed || !isOnline()) return;
    const t = now();
    const heads = new Set<string>();
    for (const action of [...state.actions]) {
      const key = keyOf(action);
      if (heads.has(key)) continue; // one at a time per square, in order
      heads.add(key);
      if (state.inFlight.includes(action.clientId)) continue;
      if (action.nextAttemptAt !== undefined && action.nextAttemptAt > t) continue;
      if (action.afterClientId) {
        // Its predecessor is gone without resolving the chain (e.g. restored
        // from storage): fall back to the last result row we hold.
        if (!chainHolds(action, state.results[key]?.row ?? null)) {
          commit({ actions: state.actions.filter((a) => a.clientId !== action.clientId) }, true);
          emit({ action, outcome: "skipped", row: null, errorCode: null });
          continue;
        }
        const resolved = withoutChain(action);
        commit({ actions: state.actions.map((a) => (a.clientId === action.clientId ? resolved : a)) }, true);
        void send(resolved);
        continue;
      }
      void send(action);
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onSettled(listener) {
      settledListeners.add(listener);
      return () => settledListeners.delete(listener);
    },
    enqueue,
    flush,
    resume() {
      timers.forEach((timer) => clearTimer(timer));
      timers.clear();
      if (state.actions.some((a) => a.nextAttemptAt !== undefined)) {
        commit(
          {
            actions: state.actions.map((a) => {
              if (a.nextAttemptAt === undefined) return a;
              const copy = { ...a };
              delete copy.nextAttemptAt;
              return copy;
            }),
          },
          true,
        );
      }
      flush();
    },
    clearOutcome(gameId, position) {
      const key = squareKey(gameId, position);
      if (key in state.outcomes) commit({ outcomes: withoutOutcome(key) }, false);
    },
    acknowledgeDropped(clientIds) {
      if (state.dropped.length === 0) return;
      if (!clientIds) {
        commit({ dropped: [] }, false);
        return;
      }
      const ids = new Set(clientIds);
      const dropped = state.dropped.filter((d) => !ids.has(d.action.clientId));
      if (dropped.length !== state.dropped.length) commit({ dropped }, false);
    },
    clearGame(gameId) {
      const prefix = `${gameId}:`;
      const keep = <T,>(record: Readonly<Record<string, T>>) =>
        Object.fromEntries(Object.entries(record).filter(([k]) => !k.startsWith(prefix)));
      commit(
        {
          actions: state.actions.filter((a) => a.gameId !== gameId),
          results: keep(state.results),
          outcomes: keep(state.outcomes),
          dropped: state.dropped.filter((d) => d.action.gameId !== gameId),
        },
        true,
      );
    },
    dispose() {
      disposed = true;
      timers.forEach((timer) => clearTimer(timer));
      timers.clear();
      listeners.clear();
      settledListeners.clear();
    },
  };
}
