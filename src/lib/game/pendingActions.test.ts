import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveBoard } from "@/lib/game/boardState";
import {
  MAX_BACKOFF_MS,
  MAX_PENDING_ACTIONS,
  backoffMs,
  createPendingActions,
  isActionId,
  isDefinitiveError,
  isGameOverError,
  isPendingAction,
  localPersistence,
  memoryPersistence,
  newActionId,
  pendingKey,
  squareKey,
  uuidFromBytes,
  type PendingAction,
  type PendingOptions,
  type Settled,
} from "@/lib/game/pendingActions";
import { incrementSquare } from "@/lib/game/rpc";
import { droppedNotices } from "@/lib/game/toasts";
import type { SquareResult } from "@/lib/game/types";
import { runPendingAction, settledIntoBlackout } from "@/lib/game/useBoardState";
import {
  GAME_ID,
  JAKE,
  ME,
  NETWORK,
  PG,
  board,
  completedBy,
  deferredRunner,
  manualClock,
  result,
  square,
  stamp,
  tick,
} from "@/lib/game/testFixtures";

// The RPC wrappers, so the action-id tests can see exactly what a +1 sends.
vi.mock("@/lib/game/rpc", () => ({
  completeSquare: vi.fn(),
  incrementSquare: vi.fn(),
  undoCompletion: vi.fn(),
}));

function setup(overrides: Partial<PendingOptions> = {}) {
  const runner = deferredRunner();
  const clock = manualClock();
  let online = true;
  const persistence = memoryPersistence();
  let ids = 0;
  const store = createPendingActions({
    run: runner.run,
    persistence,
    isOnline: () => online,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0.5,
    createId: () => `c${++ids}`,
    ...overrides,
  });
  const settled: Settled[] = [];
  store.onSettled((s) => settled.push(s));
  return {
    store,
    runner,
    clock,
    persistence,
    settled,
    setOnline: (value: boolean) => {
      online = value;
    },
  };
}

const complete = (position: number, playerId = ME) => ({ kind: "complete" as const, gameId: GAME_ID, position, playerId });
const inc = (position: number) => ({
  kind: "increment" as const,
  gameId: GAME_ID,
  position,
  playerId: ME,
});

describe("backoff", () => {
  it("doubles from 1 s and caps at ~30 s", () => {
    const fixed = { random: () => 0.5 };
    expect(backoffMs(1, fixed)).toBe(1000);
    expect(backoffMs(2, fixed)).toBe(2000);
    expect(backoffMs(3, fixed)).toBe(4000);
    expect(backoffMs(6, fixed)).toBe(MAX_BACKOFF_MS);
    expect(backoffMs(40, fixed)).toBe(MAX_BACKOFF_MS);
    expect(backoffMs(1, { random: () => 0 })).toBe(800);
    expect(backoffMs(20, { random: () => 0.999 })).toBeLessThanOrEqual(MAX_BACKOFF_MS);
  });

  it("treats only network/session trouble and the start countdown as retryable", () => {
    expect(isDefinitiveError("unknown")).toBe(false);
    expect(isDefinitiveError("not_authenticated")).toBe(false);
    expect(isDefinitiveError("countdown_in_progress")).toBe(false);
    expect(isGameOverError("countdown_in_progress")).toBe(false);
    for (const code of ["game_not_active", "not_allowed", "invalid_position", "game_not_found", "is_counter"] as const) {
      expect(isDefinitiveError(code)).toBe(true);
    }
  });
});

describe("pendingActions", () => {
  it("(a) queues a completion and sends it right away while online", () => {
    const { store, runner } = setup();
    const res = store.enqueue(complete(3));
    expect(res.status).toBe("queued");
    expect(store.getState().actions).toHaveLength(1);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].action).toMatchObject({ kind: "complete", position: 3, playerId: ME, attempts: 1 });
    expect(store.getState().inFlight).toEqual(["c1"]);
  });

  it("(b) a settled action stores the returned row and drops the action", async () => {
    const { store, runner, settled } = setup();
    store.enqueue(complete(3));
    const row = square(3, completedBy(ME, 5));
    runner.calls[0].resolve(result(row, true));
    await tick();
    const state = store.getState();
    expect(state.actions).toHaveLength(0);
    expect(state.inFlight).toHaveLength(0);
    expect(state.results[squareKey(GAME_ID, 3)]).toMatchObject({ row, kind: "complete", applied: true });
    expect(state.outcomes[squareKey(GAME_ID, 3)].outcome).toBe("applied");
    expect(settled).toHaveLength(1);
    expect(settled[0].row).toEqual(row);
    expect(settled[0].row).not.toHaveProperty("applied");
  });

  it("(d) applied=false adopts the real completer without an error", async () => {
    const { store, runner, settled } = setup();
    store.enqueue(complete(3));
    runner.calls[0].resolve(result(square(3, completedBy(JAKE, 4)), false));
    await tick();
    expect(store.getState().actions).toHaveLength(0);
    expect(settled[0]).toMatchObject({ outcome: "not_applied", errorCode: null });
    expect(settled[0].row?.completed_by_player_id).toBe(JAKE);
    expect(store.getState().results[squareKey(GAME_ID, 3)].applied).toBe(false);
  });

  it("(e) a definitive game error drops the action and reports the code once", async () => {
    const { store, runner, settled, clock } = setup();
    store.enqueue(complete(3));
    runner.calls[0].reject(PG("game_not_active"));
    await tick();
    expect(store.getState().actions).toHaveLength(0);
    expect(settled).toEqual([expect.objectContaining({ outcome: "failed", errorCode: "game_not_active", row: null })]);
    expect(store.getState().outcomes[squareKey(GAME_ID, 3)].errorCode).toBe("game_not_active");
    clock.advance(60_000);
    await tick();
    expect(runner.calls).toHaveLength(1);
  });

  it("(e) network errors keep the action and retry with growing backoff", async () => {
    const { store, runner, clock, settled } = setup();
    store.enqueue(complete(3));
    runner.calls[0].reject(NETWORK());
    await tick();
    const [waiting] = store.getState().actions;
    expect(waiting.attempts).toBe(1);
    expect(waiting.nextAttemptAt).toBe(clock.now() + 1000);
    expect(settled).toHaveLength(0);

    clock.advance(999);
    expect(runner.calls).toHaveLength(1);
    clock.advance(1);
    expect(runner.calls).toHaveLength(2);
    runner.calls[1].reject(NETWORK());
    await tick();
    expect(store.getState().actions[0].nextAttemptAt).toBe(clock.now() + 2000);

    clock.advance(2000);
    expect(runner.calls).toHaveLength(3);
    expect(runner.calls[2].action.attempts).toBe(3);
    runner.calls[2].resolve(result(square(3, completedBy(ME, 9)), true));
    await tick();
    expect(store.getState().actions).toHaveLength(0);
    expect(settled[0].outcome).toBe("applied");
  });

  it("a tap that beat the server's start countdown (countdown_in_progress) is kept and retried, not dropped", async () => {
    const { store, runner, clock, settled } = setup();
    store.enqueue(complete(3));
    store.enqueue(inc(4));
    runner.calls[0].reject(PG("countdown_in_progress"));
    runner.calls[1].reject(PG("countdown_in_progress"));
    await tick();
    expect(store.getState().actions).toHaveLength(2);
    expect(store.getState().dropped).toHaveLength(0);
    expect(settled).toHaveLength(0);
    // Still shown as crossed off meanwhile.
    expect(deriveBoard(board(), GAME_ID, store.getState())[3].completed_at).not.toBeNull();

    clock.advance(1000);
    expect(runner.calls).toHaveLength(4);
    // The retried +1 keeps its action id, so it can never count twice.
    expect(runner.calls[3].action.clientId).toBe(runner.calls[1].action.clientId);
    runner.calls[2].resolve(result(square(3, completedBy(ME, 9)), true));
    runner.calls[3].resolve(result(square(4, { target_count: 3, current_count: 1, updated_at: stamp(9) }), true));
    await tick();
    expect(store.getState().actions).toHaveLength(0);
    expect(settled.map((s) => s.outcome)).toEqual(["applied", "applied"]);
  });

  it("waits while offline and sends on resume once back online", async () => {
    const { store, runner, setOnline, clock } = setup();
    setOnline(false);
    store.enqueue(complete(5));
    store.flush();
    clock.advance(60_000);
    expect(runner.calls).toHaveLength(0);
    expect(store.getState().actions).toHaveLength(1);

    setOnline(true);
    store.resume();
    expect(runner.calls).toHaveLength(1);
    runner.calls[0].resolve(result(square(5, completedBy(ME, 3)), true));
    await tick();
    expect(store.getState().actions).toHaveLength(0);
  });

  it("resume retries right away, ignoring the backoff", async () => {
    const { store, runner } = setup();
    store.enqueue(complete(3));
    runner.calls[0].reject(NETWORK());
    await tick();
    expect(store.getState().actions[0].nextAttemptAt).toBeDefined();
    store.resume();
    expect(runner.calls).toHaveLength(2);
  });

  it("runs one action at a time per square, squares in parallel", async () => {
    const { store, runner } = setup();
    store.enqueue({ kind: "increment", gameId: GAME_ID, position: 2, playerId: ME });
    store.enqueue({ kind: "increment", gameId: GAME_ID, position: 2, playerId: ME });
    store.enqueue({ kind: "increment", gameId: GAME_ID, position: 2, playerId: ME });
    store.enqueue(complete(7));
    expect(runner.calls.map((c) => [c.action.position, c.action.clientId])).toEqual([
      [2, "c1"],
      [7, "c4"],
    ]);
    runner.calls[0].resolve(result(square(2, { target_count: 15, current_count: 1, updated_at: stamp(2) }), true));
    await tick();
    expect(runner.calls.map((c) => c.action.clientId)).toEqual(["c1", "c4", "c2"]);
    runner.calls[2].resolve(result(square(2, { target_count: 15, current_count: 2, updated_at: stamp(3) }), true));
    await tick();
    expect(runner.calls[3].action.clientId).toBe("c3");
  });

  it("(f) ignores a repeated complete or undo for the same square while pending", () => {
    const { store, runner, setOnline } = setup();
    setOnline(false);
    expect(store.enqueue(complete(3)).status).toBe("queued");
    expect(store.enqueue(complete(3))).toEqual({ status: "duplicate", clientId: "c1" });
    expect(store.enqueue(complete(4)).status).toBe("queued");
    const undo = { kind: "undo" as const, gameId: GAME_ID, position: 9, playerId: ME, expectedCompleter: JAKE };
    expect(store.enqueue(undo).status).toBe("queued");
    expect(store.enqueue(undo).status).toBe("duplicate");
    // Every +1 is its own tap: never a duplicate, each with its own id.
    const inc = { kind: "increment" as const, gameId: GAME_ID, position: 2, playerId: ME };
    expect(store.enqueue(inc).status).toBe("queued");
    expect(store.enqueue(inc).status).toBe("queued");
    expect(new Set(store.getState().actions.map((a) => a.clientId)).size).toBe(5);
    expect(store.getState().actions).toHaveLength(5);
    expect(runner.calls).toHaveLength(0);
  });

  it("(g) undo of a completion that was never sent cancels it locally", () => {
    const { store, runner, setOnline } = setup();
    setOnline(false);
    store.enqueue(complete(3));
    const res = store.enqueue({ kind: "undo", gameId: GAME_ID, position: 3, playerId: ME, expectedCompleter: ME });
    expect(res).toEqual({ status: "cancelled", clientId: "c1" });
    expect(store.getState().actions).toHaveLength(0);
    setOnline(true);
    store.resume();
    expect(runner.calls).toHaveLength(0);
  });

  it("(g) undo after an in-flight completion waits for it, then undoes only my own completion", async () => {
    const { store, runner } = setup();
    store.enqueue(complete(3));
    const res = store.enqueue({ kind: "undo", gameId: GAME_ID, position: 3, playerId: ME, expectedCompleter: ME });
    expect(res.status).toBe("queued");
    expect(store.getState().actions[1]).toMatchObject({ kind: "undo", afterClientId: "c1" });
    expect(runner.calls).toHaveLength(1);

    runner.calls[0].resolve(result(square(3, completedBy(ME, 5)), true));
    await tick();
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1].action).toMatchObject({ kind: "undo", position: 3 });
    expect(runner.calls[1].action.afterClientId).toBeUndefined();
  });

  it("(g) a chained undo is dropped when someone else got the square first", async () => {
    const { store, runner, settled } = setup();
    store.enqueue(complete(3));
    store.enqueue({ kind: "undo", gameId: GAME_ID, position: 3, playerId: ME, expectedCompleter: ME });
    runner.calls[0].resolve(result(square(3, completedBy(JAKE, 4)), false));
    await tick();
    expect(runner.calls).toHaveLength(1);
    expect(store.getState().actions).toHaveLength(0);
    expect(settled.map((s) => s.outcome)).toEqual(["not_applied", "skipped"]);
    // The sheet still explains the completion, not the skipped undo.
    expect(store.getState().outcomes[squareKey(GAME_ID, 3)].outcome).toBe("not_applied");
  });

  it("(g) an undo behind a retrying (in-doubt) completion also waits", async () => {
    const { store, runner, clock } = setup();
    store.enqueue(complete(3));
    runner.calls[0].reject(NETWORK());
    await tick();
    store.enqueue({ kind: "undo", gameId: GAME_ID, position: 3, playerId: ME, expectedCompleter: ME });
    expect(store.getState().actions.map((a) => a.kind)).toEqual(["complete", "undo"]);
    clock.advance(1000);
    expect(runner.calls).toHaveLength(2);
    // The first attempt had landed after all: the retry reports applied=false, completed by me.
    runner.calls[1].resolve(result(square(3, completedBy(ME, 5)), false));
    await tick();
    expect(runner.calls[2].action.kind).toBe("undo");
  });

  it("re-completing right after an unsent undo of my own completion cancels the undo", () => {
    const { store, runner, setOnline } = setup();
    setOnline(false);
    store.enqueue({ kind: "undo", gameId: GAME_ID, position: 3, playerId: ME, expectedCompleter: ME });
    expect(store.enqueue(complete(3)).status).toBe("cancelled");
    expect(store.getState().actions).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
  });

  it("a new tap clears the previous outcome message for that square", async () => {
    const { store, runner } = setup();
    store.enqueue(complete(3));
    runner.calls[0].reject(PG("game_not_active"));
    await tick();
    expect(store.getState().outcomes[squareKey(GAME_ID, 3)]).toBeDefined();
    store.enqueue(complete(3));
    expect(store.getState().outcomes[squareKey(GAME_ID, 3)]).toBeUndefined();
    store.clearOutcome(GAME_ID, 3);
  });

  it("keeps the newer result row when results arrive out of order", async () => {
    const { store, runner } = setup();
    store.enqueue({ kind: "increment", gameId: GAME_ID, position: 2, playerId: ME });
    runner.calls[0].resolve(result(square(2, { target_count: 15, current_count: 1, updated_at: stamp(5) }), true));
    await tick();
    store.enqueue({ kind: "increment", gameId: GAME_ID, position: 2, playerId: ME });
    // A stale row (older stamp) must not replace the held one.
    runner.calls[1].resolve(result(square(2, { target_count: 15, current_count: 0, updated_at: stamp(3) }), false));
    await tick();
    expect(store.getState().results[squareKey(GAME_ID, 2)].row.current_count).toBe(1);
  });

  it("persists a JSON-safe queue and restores it (attempted items stay in doubt)", async () => {
    const first = setup();
    first.setOnline(false);
    first.store.enqueue(complete(3));
    first.store.enqueue({ kind: "increment", gameId: GAME_ID, position: 2, playerId: ME });
    const saved = first.persistence.saved();
    expect(JSON.parse(JSON.stringify(saved))).toEqual(saved);
    expect(saved.every(isPendingAction)).toBe(true);

    const runner = deferredRunner();
    const restored = createPendingActions({
      run: runner.run,
      persistence: memoryPersistence([...JSON.parse(JSON.stringify(saved)), { junk: true }, null]),
      isOnline: () => true,
    });
    expect(restored.getState().actions).toHaveLength(2);
    restored.flush();
    expect(runner.calls.map((c) => c.action.kind).sort()).toEqual(["complete", "increment"]);
    restored.dispose();
  });

  it("clearGame forgets one game's queue, results and outcomes", async () => {
    const { store, runner, setOnline } = setup();
    store.enqueue(complete(3));
    runner.calls[0].resolve(result(square(3, completedBy(ME, 5)), true));
    await tick();
    setOnline(false);
    store.enqueue(complete(4));
    store.enqueue({ ...complete(4), gameId: "other-game" });
    store.clearGame(GAME_ID);
    const state = store.getState();
    expect(state.actions.map((a) => a.gameId)).toEqual(["other-game"]);
    expect(state.results).toEqual({});
    expect(state.outcomes).toEqual({});
  });

  it("notifies subscribers with a new snapshot object on every change", () => {
    const { store, setOnline } = setup();
    setOnline(false);
    const seen: unknown[] = [];
    const off = store.subscribe(() => seen.push(store.getState()));
    const before = store.getState();
    store.enqueue(complete(3));
    expect(seen).toHaveLength(1);
    expect(store.getState()).not.toBe(before);
    expect(store.getState()).toBe(store.getState());
    off();
    store.enqueue(complete(4));
    expect(seen).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Counter +1s: every tap carries its own action id (no compare-and-set)

describe("counter +1 action ids", () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const rpc = vi.mocked(incrementSquare);

  /** The real runner (useBoardState) over the mocked RPC, with real UUID action ids. */
  function wired() {
    const calls: { args: [string, number, string | null]; resolve: (r: SquareResult) => void; reject: (e: unknown) => void }[] = [];
    rpc.mockReset();
    rpc.mockImplementation(
      (gameId, position, actionId) =>
        new Promise<SquareResult>((resolve, reject) => {
          calls.push({ args: [gameId, position, actionId], resolve, reject });
        }),
    );
    const ctx = setup({ run: runPendingAction, createId: newActionId });
    return { ...ctx, calls };
  }

  const counter = (count: number, n: number, extra = {}) =>
    square(2, { target_count: 15, current_count: count, updated_at: stamp(n), ...extra });

  it("a retried increment is sent with the same action id; applied=false (already counted) is adopted silently", async () => {
    const { store, calls, clock, settled } = wired();
    store.enqueue(inc(2));
    expect(calls).toHaveLength(1);
    const [gameId, position, actionId] = calls[0].args;
    expect([gameId, position]).toEqual([GAME_ID, 2]);
    expect(actionId).toMatch(UUID_V4);
    expect(actionId).toBe(store.getState().actions[0].clientId);

    // The response is lost (the server may or may not have counted it): retry.
    calls[0].reject(NETWORK());
    await tick();
    clock.advance(1000);
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toEqual([GAME_ID, 2, actionId]);

    // It had landed: the server recognises the id and counts nothing.
    calls[1].resolve(result(counter(1, 4), false));
    await tick();
    expect(settled).toEqual([expect.objectContaining({ outcome: "not_applied", errorCode: null })]);
    expect(store.getState().actions).toEqual([]);
    expect(store.getState().results[squareKey(GAME_ID, 2)].row.current_count).toBe(1);
    expect(deriveBoard(board({ 2: { target_count: 15 } }), GAME_ID, store.getState())[2]).toMatchObject({
      current_count: 1,
      pending: false,
    });
  });

  it("two queued increments on one square are sent with distinct ids, in tap order", async () => {
    const { store, calls } = wired();
    store.enqueue(inc(2));
    store.enqueue(inc(2));
    const [first, second] = store.getState().actions.map((a) => a.clientId);
    expect(first).not.toBe(second);
    expect([first, second].every(isActionId)).toBe(true);
    expect(calls.map((c) => c.args[2])).toEqual([first]); // one at a time per square

    calls[0].resolve(result(counter(1, 2), true));
    await tick();
    expect(calls.map((c) => c.args[2])).toEqual([first, second]);
    // Another phone's tap landed in between: this +1 still counts (no compare-and-set).
    calls[1].resolve(result(counter(3, 5), true));
    await tick();
    expect(store.getState().actions).toEqual([]);
    expect(store.getState().results[squareKey(GAME_ID, 2)].row.current_count).toBe(3);
  });

  it("the overlay shows current_count + pending increments while they are pending", async () => {
    const { store, calls, setOnline } = wired();
    setOnline(false);
    store.enqueue(inc(2));
    store.enqueue(inc(2));
    store.enqueue(inc(2));
    const at2 = (rows = board({ 2: { target_count: 15, current_count: 3 } })) => deriveBoard(rows, GAME_ID, store.getState())[2];
    expect(at2()).toMatchObject({ current_count: 6, pending: true, pendingKind: "increment", completed_at: null });
    // Others tapped meanwhile (a refetch shows 5): my three still add on top.
    expect(at2(board({ 2: { target_count: 15, current_count: 5, updated_at: stamp(3) } }))).toMatchObject({
      current_count: 8,
      pending: true,
    });

    setOnline(true);
    store.resume();
    calls[0].resolve(result(counter(6, 4), true));
    await tick();
    // One settled (its row is the base now), two still pending on top of it.
    expect(at2(board({ 2: { target_count: 15, current_count: 5, updated_at: stamp(3) } }))).toMatchObject({
      current_count: 8,
      pending: true,
    });

    // Close to the target the overlay stops at it and shows my completion.
    const near = deriveBoard(board({ 2: { target_count: 15, current_count: 14, updated_at: stamp(9) } }), GAME_ID, store.getState())[2];
    expect(near).toMatchObject({ current_count: 15, completed_by_player_id: ME, pending: true });
  });

  it("action ids are always UUIDs, even without crypto.randomUUID", () => {
    expect(newActionId()).toMatch(UUID_V4);
    expect(uuidFromBytes(new Uint8Array(16))).toBe("00000000-0000-4000-8000-000000000000");
    expect(uuidFromBytes(new Uint8Array(16).fill(255))).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    vi.stubGlobal("crypto", { getRandomValues: (b: Uint8Array) => b.fill(7) });
    try {
      expect(newActionId()).toBe("07070707-0707-4707-8707-070707070707");
      vi.stubGlobal("crypto", undefined);
      expect(newActionId()).toMatch(UUID_V4);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(isActionId("a-legacy-1")).toBe(false);
  });

  it("a non-UUID id (queue saved by an older build) is sent without an action id instead of failing forever", async () => {
    const { calls } = wired();
    void runPendingAction({ ...inc(2), clientId: "a-lx3k-abcd", createdAt: "t", attempts: 1 });
    expect(calls.map((c) => c.args)).toEqual([[GAME_ID, 2, null]]);
  });
});

// ---------------------------------------------------------------------------
// Phase 7: localStorage persistence, game-over drops, the cap

class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value));
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

const OTHER_GAME = "22222222-2222-4222-8222-222222222222";
describe("localStorage persistence", () => {
  let local: MemoryStorage;
  beforeEach(() => {
    local = new MemoryStorage();
    vi.stubGlobal("window", { localStorage: local, addEventListener: () => {}, removeEventListener: () => {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  /** A queue for GAME_ID backed by the stubbed localStorage, like the app's (offline unless told). */
  function phone(online = false, runner = deferredRunner()) {
    let ids = 0;
    const store = createPendingActions({
      run: runner.run,
      persistence: localPersistence(GAME_ID),
      isOnline: () => online,
      createId: () => `p${++ids}-${Math.random().toString(36).slice(2, 6)}`,
    });
    return { store, runner };
  }

  it("keeps plain JSON under bingo.pending.<gameId> and removes the key once the queue is empty", async () => {
    const { store } = phone();
    store.enqueue(complete(5));
    const raw = local.getItem(pendingKey(GAME_ID));
    expect(raw).not.toBeNull();
    const saved = JSON.parse(raw!) as PendingAction[];
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ kind: "complete", gameId: GAME_ID, position: 5, playerId: ME, attempts: 0 });
    expect(saved.every(isPendingAction)).toBe(true);
    store.dispose();

    const online = phone(true);
    expect(online.runner.calls).toHaveLength(0); // nothing goes out before a flush
    online.store.flush();
    online.runner.calls[0].resolve(result(square(5, completedBy(ME, 4)), true));
    await tick();
    expect(local.getItem(pendingKey(GAME_ID))).toBeNull();
  });

  it("pending items survive a reload and still show as overlays on the snapshot board", () => {
    const before = phone();
    before.store.enqueue(complete(5));
    before.store.enqueue(inc(2));
    before.store.dispose();

    // Reload: a new queue for the same game, hydrated from storage, over the cached snapshot rows.
    const after = phone();
    expect(after.store.getState().actions.map((a) => [a.kind, a.position])).toEqual([
      ["complete", 5],
      ["increment", 2],
    ]);
    const snapshotRows = board({ 2: { target_count: 15 } });
    const shown = deriveBoard(snapshotRows, GAME_ID, after.store.getState());
    expect(shown[5]).toMatchObject({ completed_by_player_id: ME, pending: true, pendingKind: "complete" });
    expect(shown[2]).toMatchObject({ current_count: 1, pending: true, pendingKind: "increment" });
  });

  it("ignores corrupt JSON, non-arrays, junk items and another game's items", () => {
    local.setItem(pendingKey(GAME_ID), "{oops");
    expect(phone().store.getState().actions).toEqual([]);
    local.setItem(pendingKey(GAME_ID), JSON.stringify({ kind: "complete" }));
    expect(phone().store.getState().actions).toEqual([]);

    const good: PendingAction = {
      clientId: "a1",
      kind: "complete",
      gameId: GAME_ID,
      position: 5,
      playerId: ME,
      createdAt: "2026-10-23T21:30:00.000Z",
      attempts: 1,
      nextAttemptAt: 123,
    };
    local.setItem(
      pendingKey(GAME_ID),
      JSON.stringify([null, 7, { ...good, kind: "explode" }, { ...good, clientId: "a2", gameId: OTHER_GAME }, good]),
    );
    const restored = phone().store.getState().actions;
    expect(restored).toHaveLength(1);
    expect(restored[0].clientId).toBe("a1");
    // Restored items were possibly in flight: still in doubt (attempts kept), backoff forgotten.
    expect(restored[0].attempts).toBe(1);
    expect(restored[0].nextAttemptAt).toBeUndefined();
  });

  it("restored items are sent in tap order per square, keeping their ids", async () => {
    const before = phone();
    const ids = [before.store.enqueue(inc(2)), before.store.enqueue(inc(2)), before.store.enqueue(complete(7))].map((r) =>
      r.status === "queued" ? r.action.clientId : "",
    );
    before.store.dispose();

    const { store, runner } = phone(true);
    store.flush();
    expect(runner.calls.map((c) => [c.action.position, c.action.clientId])).toEqual([
      [2, ids[0]],
      [7, ids[2]],
    ]);
    runner.calls[0].resolve(result(square(2, { target_count: 15, current_count: 1, updated_at: stamp(2) }), true));
    await tick();
    expect(runner.calls[2].action).toMatchObject({ position: 2, clientId: ids[1] });
  });

  it("items saved before +1s carried action ids (with expectedCount) still restore; the field is ignored", async () => {
    const legacy = {
      clientId: "6f1c2a7e-8a43-4c1b-9f2e-1d2c3b4a5f60",
      kind: "increment",
      gameId: GAME_ID,
      position: 2,
      playerId: ME,
      expectedCount: 4,
      createdAt: "2026-10-23T21:30:00.000Z",
      attempts: 0,
    };
    local.setItem(pendingKey(GAME_ID), JSON.stringify([legacy, { ...legacy, clientId: "a-legacy-1", expectedCount: "junk" }]));
    const { store, runner } = phone(true);
    const restored = store.getState().actions;
    expect(restored.map((a) => a.clientId)).toEqual([legacy.clientId, "a-legacy-1"]);
    expect(restored.every((a) => !("expectedCount" in a))).toBe(true);
    // Shown as two pending +1s on top of the count, whatever count they were tapped on.
    const shown = deriveBoard(board({ 2: { target_count: 15, current_count: 7 } }), GAME_ID, store.getState());
    expect(shown[2]).toMatchObject({ current_count: 9, pending: true });
    store.flush();
    expect(runner.calls[0].action).toMatchObject({ kind: "increment", clientId: legacy.clientId });
    expect(runner.calls[0].action).not.toHaveProperty("expectedCount");
  });

  it("a restored completion the server already has (applied=false) just adopts the row", async () => {
    const before = phone(true);
    before.store.enqueue(complete(5)); // sent, then the page reloaded before the answer
    before.store.dispose();

    const { store, runner } = phone(true);
    const settled: Settled[] = [];
    store.onSettled((s) => settled.push(s));
    store.flush();
    expect(runner.calls[0].action.attempts).toBe(2);
    runner.calls[0].resolve(result(square(5, completedBy(ME, 6)), false));
    await tick();
    expect(settled).toEqual([expect.objectContaining({ outcome: "not_applied", errorCode: null })]);
    expect(store.getState().results[squareKey(GAME_ID, 5)].row.completed_by_player_id).toBe(ME);
    expect(store.getState().actions).toEqual([]);
    expect(store.getState().dropped).toEqual([]);
    expect(local.getItem(pendingKey(GAME_ID))).toBeNull();
  });

  it("only writes its own game's items", () => {
    const persistence = localPersistence(GAME_ID);
    persistence.save([
      { clientId: "x", kind: "complete", gameId: OTHER_GAME, position: 1, playerId: ME, createdAt: "t", attempts: 0 },
    ]);
    expect(local.getItem(pendingKey(GAME_ID))).toBeNull();
  });
});

describe("game over and the queue cap", () => {
  it("game_not_active drops every queued action of that game, each reported once", async () => {
    const { store, runner, setOnline, settled } = setup();
    setOnline(false);
    store.enqueue(inc(2));
    store.enqueue(inc(2));
    store.enqueue(complete(3));
    setOnline(true);
    store.resume();
    expect(runner.calls.map((c) => c.action.position)).toEqual([2, 3]);

    runner.calls[1].reject(PG("game_not_active"));
    await tick();
    // The unsent +1 behind the in-flight one is dropped too; the in-flight one is left to land.
    expect(store.getState().actions.map((a) => a.clientId)).toEqual(["c1"]);
    expect(store.getState().dropped.map((d) => [d.action.position, d.reason, d.errorCode])).toEqual([
      [3, "game_over", "game_not_active"],
      [2, "game_over", "game_not_active"],
    ]);

    runner.calls[0].reject(PG("game_not_active"));
    await tick();
    expect(store.getState().actions).toEqual([]);
    expect(store.getState().dropped).toHaveLength(3);
    expect(runner.calls).toHaveLength(2); // nothing else was sent
    expect(settled.filter((s) => s.outcome === "failed")).toHaveLength(3);
    expect(new Set(settled.map((s) => s.action.clientId)).size).toBe(3);
  });

  it("game_not_found (game deleted, or not ours) drops the same way", async () => {
    const { store, runner } = setup();
    store.enqueue(complete(3));
    runner.calls[0].reject(PG("game_not_found"));
    await tick();
    expect(store.getState().dropped).toEqual([
      expect.objectContaining({ reason: "game_over", errorCode: "game_not_found" }),
    ]);
    expect(isGameOverError("game_not_found")).toBe(true);
    expect(isGameOverError("not_allowed")).toBe(false);
  });

  it("other definitive errors drop only their own action, without a notice", async () => {
    const { store, runner, setOnline } = setup();
    setOnline(false);
    store.enqueue({ kind: "undo", gameId: GAME_ID, position: 6, playerId: ME, expectedCompleter: JAKE });
    store.enqueue(complete(3));
    setOnline(true);
    store.resume();
    runner.calls[0].reject(PG("not_allowed"));
    await tick();
    expect(store.getState().actions.map((a) => a.position)).toEqual([3]);
    expect(store.getState().dropped).toEqual([]);
  });

  it("never holds more than maxActions: the oldest unsent tap is dropped, with a notice", () => {
    const { store, setOnline, settled } = setup({ maxActions: 3 });
    setOnline(false);
    for (let n = 0; n < 5; n++) store.enqueue(inc(2));
    const state = store.getState();
    expect(state.actions.map((a) => a.clientId)).toEqual(["c3", "c4", "c5"]);
    expect(state.dropped.map((d) => [d.action.clientId, d.reason])).toEqual([
      ["c1", "overflow"],
      ["c2", "overflow"],
    ]);
    expect(settled.map((s) => s.outcome)).toEqual(["dropped", "dropped"]);
    expect(MAX_PENDING_ACTIONS).toBe(50);
  });

  it("an action already on the wire is never the one dropped", () => {
    const { store, runner } = setup({ maxActions: 2 });
    store.enqueue(inc(2)); // in flight
    store.enqueue(inc(2));
    store.enqueue(inc(2));
    expect(runner.calls).toHaveLength(1);
    expect(store.getState().actions.map((a) => a.clientId)).toEqual(["c1", "c3"]);
    expect(store.getState().dropped.map((d) => d.action.clientId)).toEqual(["c2"]);
  });

  it("a restored queue keeps only the newest maxActions", () => {
    const items = Array.from({ length: 5 }, (_, n) => ({
      clientId: `r${n}`,
      kind: "increment",
      gameId: GAME_ID,
      position: 2,
      playerId: ME,
      expectedCount: n,
      createdAt: "t",
      attempts: 0,
    }));
    const store = createPendingActions({
      run: deferredRunner().run,
      persistence: memoryPersistence(items),
      isOnline: () => false,
      maxActions: 3,
    });
    expect(store.getState().actions.map((a) => a.clientId)).toEqual(["r2", "r3", "r4"]);
  });

  it("acknowledgeDropped clears the notice list, by id or all at once", () => {
    const { store, setOnline } = setup({ maxActions: 1 });
    setOnline(false);
    store.enqueue(inc(2));
    store.enqueue(inc(2));
    store.enqueue(inc(2));
    const [first, second] = store.getState().dropped.map((d) => d.action.clientId);
    store.acknowledgeDropped([first]);
    expect(store.getState().dropped.map((d) => d.action.clientId)).toEqual([second]);
    store.acknowledgeDropped();
    expect(store.getState().dropped).toEqual([]);
  });

  it("a persistence that throws never breaks the queue", () => {
    const store = createPendingActions({
      run: deferredRunner().run,
      persistence: {
        load: () => {
          throw new Error("SecurityError");
        },
        save: () => {
          throw new Error("QuotaExceededError");
        },
      },
      isOnline: () => false,
    });
    expect(store.getState().actions).toEqual([]);
    expect(store.enqueue(complete(3)).status).toBe("queued");
    expect(store.getState().actions).toHaveLength(1);
  });

  it("the notice is one short line per reason", () => {
    const label = (position: number) => (position === 3 ? "Sing on stage" : `square ${position + 1}`);
    const d = (position: number, reason: "game_over" | "overflow") => ({ action: { position }, reason });
    expect(droppedNotices([], label)).toEqual([]);
    expect(droppedNotices([d(3, "game_over")], label)).toEqual(["Couldn't save Sing on stage — the game had already ended"]);
    // Several taps on one counter square still name the square.
    expect(droppedNotices([d(3, "game_over"), d(3, "game_over")], label)).toEqual([
      "Couldn't save Sing on stage — the game had already ended",
    ]);
    expect(droppedNotices([d(3, "game_over"), d(7, "game_over"), d(2, "overflow")], label)).toEqual([
      "Couldn't save 2 squares — the game had already ended",
      "Couldn't save square 3 — too many taps were waiting offline",
    ]);
  });
});

describe("settledIntoBlackout", () => {
  it("is true only when the settled row crosses off the last open square", () => {
    const full: Record<number, ReturnType<typeof completedBy>> = {};
    for (let p = 0; p < 25; p++) if (p !== 24) full[p] = completedBy(p % 2 ? JAKE : ME, p + 1);
    const squares = board(full);
    expect(settledIntoBlackout(squares, square(24, completedBy(ME, 30)))).toBe(true);
    // Someone else got it first (applied = false): the board is still full, the game is still over.
    expect(settledIntoBlackout(squares, square(24, completedBy(JAKE, 31)))).toBe(true);
    expect(settledIntoBlackout(squares, square(24))).toBe(false);
    expect(settledIntoBlackout(squares, null)).toBe(false);
    const twoOpen = board({ ...full, 23: {} });
    expect(settledIntoBlackout(twoOpen, square(24, completedBy(ME, 30)))).toBe(false);
  });
});
