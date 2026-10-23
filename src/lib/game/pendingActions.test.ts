import { describe, expect, it } from "vitest";
import {
  MAX_BACKOFF_MS,
  backoffMs,
  createPendingActions,
  isDefinitiveError,
  isPendingAction,
  memoryPersistence,
  squareKey,
  type PendingOptions,
  type Settled,
} from "@/lib/game/pendingActions";
import {
  GAME_ID,
  JAKE,
  ME,
  NETWORK,
  PG,
  completedBy,
  deferredRunner,
  manualClock,
  result,
  square,
  stamp,
  tick,
} from "@/lib/game/testFixtures";

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

  it("treats only network/session trouble as retryable", () => {
    expect(isDefinitiveError("unknown")).toBe(false);
    expect(isDefinitiveError("not_authenticated")).toBe(false);
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
    store.enqueue({ kind: "increment", gameId: GAME_ID, position: 2, playerId: ME, expectedCount: 0 });
    store.enqueue({ kind: "increment", gameId: GAME_ID, position: 2, playerId: ME, expectedCount: 1 });
    store.enqueue({ kind: "increment", gameId: GAME_ID, position: 2, playerId: ME, expectedCount: 2 });
    store.enqueue(complete(7));
    expect(runner.calls.map((c) => [c.action.position, c.action.expectedCount])).toEqual([
      [2, 0],
      [7, undefined],
    ]);
    runner.calls[0].resolve(result(square(2, { target_count: 15, current_count: 1, updated_at: stamp(2) }), true));
    await tick();
    expect(runner.calls.map((c) => c.action.expectedCount)).toEqual([0, undefined, 1]);
    runner.calls[2].resolve(result(square(2, { target_count: 15, current_count: 2, updated_at: stamp(3) }), true));
    await tick();
    expect(runner.calls[3].action.expectedCount).toBe(2);
  });

  it("increment applied=false (count moved on) is adopted silently", async () => {
    const { store, runner, settled } = setup();
    store.enqueue({ kind: "increment", gameId: GAME_ID, position: 2, playerId: ME, expectedCount: 0 });
    runner.calls[0].resolve(result(square(2, { target_count: 15, current_count: 3, updated_at: stamp(4) }), false));
    await tick();
    expect(settled[0]).toMatchObject({ outcome: "not_applied", errorCode: null });
    expect(store.getState().results[squareKey(GAME_ID, 2)].row.current_count).toBe(3);
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
    const inc = { kind: "increment" as const, gameId: GAME_ID, position: 2, playerId: ME, expectedCount: 4 };
    expect(store.enqueue(inc).status).toBe("queued");
    expect(store.enqueue(inc).status).toBe("duplicate");
    expect(store.enqueue({ ...inc, expectedCount: 5 }).status).toBe("queued");
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
    store.enqueue({ kind: "increment", gameId: GAME_ID, position: 2, playerId: ME, expectedCount: 0 });
    runner.calls[0].resolve(result(square(2, { target_count: 15, current_count: 1, updated_at: stamp(5) }), true));
    await tick();
    store.enqueue({ kind: "increment", gameId: GAME_ID, position: 2, playerId: ME, expectedCount: 1 });
    // A stale row (older stamp) must not replace the held one.
    runner.calls[1].resolve(result(square(2, { target_count: 15, current_count: 0, updated_at: stamp(3) }), false));
    await tick();
    expect(store.getState().results[squareKey(GAME_ID, 2)].row.current_count).toBe(1);
  });

  it("persists a JSON-safe queue and restores it (attempted items stay in doubt)", async () => {
    const first = setup();
    first.setOnline(false);
    first.store.enqueue(complete(3));
    first.store.enqueue({ kind: "increment", gameId: GAME_ID, position: 2, playerId: ME, expectedCount: 4 });
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
