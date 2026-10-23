import { describe, expect, it } from "vitest";
import { deriveBoard, diffBoards, overlaySquare, sameVersion, type DisplaySquare } from "@/lib/game/boardState";
import { createPendingActions, memoryPersistence, squareKey, type PendingAction, type ResultEntry } from "@/lib/game/pendingActions";
import {
  GAME_ID,
  HOST,
  JAKE,
  ME,
  board,
  completedBy,
  deferredRunner,
  result,
  square,
  stamp,
  tick,
} from "@/lib/game/testFixtures";
import type { Square } from "@/lib/game/types";

let ids = 0;
function action(kind: PendingAction["kind"], position: number, extra: Partial<PendingAction> = {}): PendingAction {
  return {
    clientId: `a${++ids}`,
    kind,
    gameId: GAME_ID,
    position,
    playerId: ME,
    createdAt: "2026-10-23T21:30:00.000Z",
    attempts: 0,
    ...extra,
  };
}

function entry(row: Square, applied = true, kind: PendingAction["kind"] = "complete"): ResultEntry {
  return { row, kind, applied, clientId: "r1" };
}

const at = (b: DisplaySquare[], position: number) => b.find((s) => s.position === position)!;

describe("deriveBoard / overlays", () => {
  it("(a) a pending completion shows as completed by me, marked pending", () => {
    const squares = board();
    const view = deriveBoard(squares, GAME_ID, { actions: [action("complete", 3)], results: {} });
    expect(at(view, 3)).toMatchObject({
      completed_by_player_id: ME,
      completed_at: "2026-10-23T21:30:00.000Z",
      pending: true,
      pendingKind: "complete",
      free: false,
    });
    expect(at(view, 3).base).toBe(squares[3]);
    expect(at(view, 4).pending).toBe(false);
    expect(view).toHaveLength(25);
  });

  it("(c) a refetch that still shows the square open does not flip a pending completion back", () => {
    const pending = { actions: [action("complete", 3)], results: {} };
    const refetched = board({ 3: { updated_at: stamp(7) } });
    expect(at(deriveBoard(refetched, GAME_ID, pending), 3)).toMatchObject({ completed_by_player_id: ME, pending: true });
  });

  it("(b) once settled, the result row replaces the overlay and stale server rows cannot revert it", () => {
    const mine = square(3, completedBy(ME, 5));
    const results = { [squareKey(GAME_ID, 3)]: entry(mine) };
    const staleServer = board({ 3: { updated_at: stamp(2) } });
    const view = at(deriveBoard(staleServer, GAME_ID, { actions: [], results }), 3);
    expect(view).toMatchObject({ completed_by_player_id: ME, completed_at: stamp(5), pending: false, ownBase: true });

    // A newer server row (the host undid it) wins over the held result.
    const newer = board({ 3: { updated_at: stamp(9) } });
    const after = at(deriveBoard(newer, GAME_ID, { actions: [], results }), 3);
    expect(after).toMatchObject({ completed_by_player_id: null, completed_at: null, ownBase: false });
  });

  it("(b) the same version from the server keeps ownBase (no toast for my own completion)", () => {
    const mine = square(3, completedBy(ME, 5));
    const results = { [squareKey(GAME_ID, 3)]: entry(mine) };
    const caughtUp = board({ 3: completedBy(ME, 5) });
    expect(at(deriveBoard(caughtUp, GAME_ID, { actions: [], results }), 3).ownBase).toBe(true);
  });

  it("(d) with the square already completed by someone else, the pending completion does not hide them", () => {
    const squares = board({ 3: completedBy(JAKE, 4) });
    const view = at(deriveBoard(squares, GAME_ID, { actions: [action("complete", 3)], results: {} }), 3);
    expect(view).toMatchObject({ completed_by_player_id: JAKE, pending: false, pendingKind: null });
  });

  it("predicts counter increments from the count shown when tapped", () => {
    const base = square(2, { target_count: 15, current_count: 3 });
    const one = overlaySquare(base, [action("increment", 2, { expectedCount: 3 })]);
    expect(one).toMatchObject({ current_count: 4, completed_at: null, pending: true, pendingKind: "increment" });
    const three = overlaySquare(base, [
      action("increment", 2, { expectedCount: 3 }),
      action("increment", 2, { expectedCount: 4 }),
      action("increment", 2, { expectedCount: 5 }),
    ]);
    expect(three.current_count).toBe(6);
    // The server moved on past what I saw: show the server count (my +1 will be rejected).
    const moved = overlaySquare(square(2, { target_count: 15, current_count: 8 }), [
      action("increment", 2, { expectedCount: 3 }),
    ]);
    expect(moved).toMatchObject({ current_count: 8, pending: false });
  });

  it("an increment reaching the target shows a pending completion by me", () => {
    const base = square(2, { target_count: 3, current_count: 2 });
    const view = overlaySquare(base, [action("increment", 2, { expectedCount: 2 })]);
    expect(view).toMatchObject({ current_count: 3, completed_by_player_id: ME, pending: true });
    // Never past the target.
    const over = overlaySquare(base, [action("increment", 2, { expectedCount: 2 }), action("increment", 2, { expectedCount: 3 })]);
    expect(over.current_count).toBe(3);
  });

  it("a pending undo reopens the square (counter back to target - 1)", () => {
    const normal = overlaySquare(square(3, completedBy(JAKE, 4)), [action("undo", 3, { expectedCompleter: JAKE })]);
    expect(normal).toMatchObject({ completed_at: null, completed_by_player_id: null, current_count: 0, pending: true, pendingKind: "undo" });
    const counter = overlaySquare(square(2, completedBy(JAKE, 4, { target_count: 15, current_count: 15 })), [
      action("undo", 2, { expectedCompleter: JAKE }),
    ]);
    expect(counter.current_count).toBe(14);
  });

  it("a pending undo aimed at another completer does not hide a newer completion", () => {
    const view = overlaySquare(square(3, completedBy(HOST, 6)), [action("undo", 3, { expectedCompleter: JAKE })]);
    expect(view).toMatchObject({ completed_by_player_id: HOST, pending: false });
  });

  it("the free center is never reopened by an overlay", () => {
    const free = square(12, completedBy(null, 1));
    expect(overlaySquare(free, []).free).toBe(true);
    expect(overlaySquare(free, [action("undo", 12, { expectedCompleter: null })]).free).toBe(true);
  });

  it("(g) complete then undo in the queue shows the square open", () => {
    const view = overlaySquare(square(3), [action("complete", 3), action("undo", 3, { expectedCompleter: ME })]);
    expect(view).toMatchObject({ completed_at: null, pending: false });
  });

  it("ignores other games' actions and results", () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const view = deriveBoard(board(), GAME_ID, {
      actions: [action("complete", 3, { gameId: other })],
      results: { [squareKey(other, 4)]: entry(square(4, completedBy(ME, 9))) },
    });
    expect(at(view, 3).completed_at).toBeNull();
    expect(at(view, 4).completed_at).toBeNull();
  });

  it("compares versions by microseconds, not string format", () => {
    expect(sameVersion({ updated_at: "2026-10-23T21:00:00.5+00:00" }, { updated_at: "2026-10-23T21:00:00.500000Z" })).toBe(true);
    expect(sameVersion({ updated_at: stamp(1) }, { updated_at: stamp(2) })).toBe(false);
  });
});

describe("store + derivation end to end", () => {
  it("pending → confirmed without ever showing the square open", async () => {
    const runner = deferredRunner();
    const store = createPendingActions({ run: runner.run, persistence: memoryPersistence(), isOnline: () => true });
    let server = board();
    const shown = () => at(deriveBoard(server, GAME_ID, store.getState()), 3);
    store.enqueue({ kind: "complete", gameId: GAME_ID, position: 3, playerId: ME });
    expect(shown()).toMatchObject({ completed_by_player_id: ME, pending: true });

    // A refetch lands mid-flight, still showing it open (c).
    server = board({ 3: { updated_at: stamp(1) } });
    expect(shown()).toMatchObject({ completed_by_player_id: ME, pending: true });

    runner.calls[0].resolve(result(square(3, completedBy(ME, 5)), true));
    await tick();
    // The server snapshot has not caught up yet: the held result keeps it crossed off (b).
    expect(shown()).toMatchObject({ completed_by_player_id: ME, pending: false, ownBase: true });
    server = board({ 3: completedBy(ME, 5) });
    expect(shown()).toMatchObject({ completed_by_player_id: ME, pending: false });
    store.dispose();
  });

  it("an offline completion stays pending through failed refetches and confirms after reconnect", async () => {
    const runner = deferredRunner();
    let online = false;
    const store = createPendingActions({ run: runner.run, persistence: memoryPersistence(), isOnline: () => online });
    const server = board();
    store.enqueue({ kind: "complete", gameId: GAME_ID, position: 5, playerId: ME });
    expect(at(deriveBoard(server, GAME_ID, store.getState()), 5).pending).toBe(true);
    expect(runner.calls).toHaveLength(0);
    online = true;
    store.resume();
    runner.calls[0].resolve(result(square(5, completedBy(ME, 8)), true));
    await tick();
    expect(at(deriveBoard(server, GAME_ID, store.getState()), 5)).toMatchObject({ completed_by_player_id: ME, pending: false });
    store.dispose();
  });
});

describe("diffBoards", () => {
  const view = (squares: Square[], actions: PendingAction[] = [], results: Record<string, ResultEntry> = {}) =>
    deriveBoard(squares, GAME_ID, { actions, results });

  it("reports nothing for an identical board or a re-delivered row", () => {
    const a = view(board({ 3: completedBy(JAKE, 4) }));
    const b = view(board({ 3: completedBy(JAKE, 4) }));
    expect(diffBoards(a, a, ME)).toEqual([]);
    expect(diffBoards(a, b, ME)).toEqual([]);
  });

  it("reports someone else's new completion", () => {
    const before = view(board());
    const after = view(board({ 3: completedBy(JAKE, 4) }));
    expect(diffBoards(before, after, ME)).toEqual([{ type: "completed", position: 3, by: JAKE }]);
  });

  it("reports my own tap only as own_completed (haptics), never as news", () => {
    const before = view(board());
    const tapped = view(board(), [action("complete", 3)]);
    expect(diffBoards(before, tapped, ME)).toEqual([{ type: "own_completed", position: 3 }]);
    const results = { [squareKey(GAME_ID, 3)]: entry(square(3, completedBy(ME, 5))) };
    const confirmed = view(board(), [], results);
    expect(diffBoards(tapped, confirmed, ME)).toEqual([]);
    const caughtUp = view(board({ 3: completedBy(ME, 5) }), [], results);
    expect(diffBoards(confirmed, caughtUp, ME)).toEqual([]);
  });

  it("reports the winner when my completion lost the race", () => {
    const tapped = view(board(), [action("complete", 3)]);
    const results = { [squareKey(GAME_ID, 3)]: entry(square(3, completedBy(JAKE, 4)), false) };
    const lost = view(board(), [], results);
    expect(diffBoards(tapped, lost, ME)).toEqual([{ type: "completed", position: 3, by: JAKE }]);
  });

  it("reports someone else's undo, but not mine", () => {
    const before = view(board({ 3: completedBy(JAKE, 4) }));
    const reopened = view(board({ 3: { updated_at: stamp(6) } }));
    expect(diffBoards(before, reopened, ME)).toEqual([{ type: "undone", position: 3, previousBy: JAKE }]);

    // My own (host) undo: the overlay first, then my applied result.
    const undoing = view(board({ 3: completedBy(JAKE, 4) }), [action("undo", 3, { expectedCompleter: JAKE })]);
    expect(diffBoards(before, undoing, ME)).toEqual([]);
    const results = { [squareKey(GAME_ID, 3)]: entry(square(3, { updated_at: stamp(6) }), true, "undo") };
    const undone = view(board({ 3: completedBy(JAKE, 4) }), [], results);
    expect(diffBoards(undoing, undone, ME)).toEqual([]);
  });

  it("does not report the free center or counter progress", () => {
    const before = view(board({ 2: { target_count: 15, current_count: 1 } }));
    const after = view(board({ 2: { target_count: 15, current_count: 2, updated_at: stamp(3) }, 12: completedBy(null, 3) }));
    expect(diffBoards(before, after, ME)).toEqual([]);
  });
});
