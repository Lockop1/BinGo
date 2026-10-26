import { describe, expect, it } from "vitest";
import {
  DEFAULT_SYNC_POLL_MS,
  applyGameChange,
  applyMediaChange,
  applyPlayerChange,
  applySquareChange,
  compareGameVersions,
  isNewerSquare,
  mergeGame,
  mergeMedia,
  mergeSnapshot,
  syncPollMs,
  timestampMicros,
  toRowChange,
  upsertMedia,
  type GameSnapshot,
} from "@/lib/game/realtime";
import type { Game, Media, Player, Square } from "@/lib/game/types";

const GAME_ID = "11111111-1111-4111-8111-111111111111";

function game(overrides: Partial<Game> = {}): Game {
  return {
    id: GAME_ID,
    join_code: "ABCD2345",
    name: "Test night",
    host_user_id: "host-user",
    status: "lobby",
    free_center: true,
    created_at: "2026-10-23T20:00:00.000000+00:00",
    started_at: null,
    ended_at: null,
    deadline_at: "2026-10-24T20:00:00.000000+00:00",
    expires_at: "2026-11-22T20:00:00.000000+00:00",
    ...overrides,
  };
}

function player(id: string, joinedAt: string, overrides: Partial<Player> = {}): Player {
  return {
    id,
    game_id: GAME_ID,
    user_id: `user-${id}`,
    display_name: `Player ${id}`,
    color: 0,
    is_ready: false,
    joined_at: joinedAt,
    ...overrides,
  };
}

function square(position: number, updatedAt: string, overrides: Partial<Square> = {}): Square {
  return {
    id: `sq-${position}`,
    game_id: GAME_ID,
    position,
    label: "",
    details: "",
    target_count: 1,
    current_count: 0,
    completed_by_player_id: null,
    completed_at: null,
    updated_at: updatedAt,
    ...overrides,
  };
}

function media(id: string, createdAt: string, overrides: Partial<Media> = {}): Media {
  return {
    id,
    game_id: GAME_ID,
    square_id: "sq-0",
    player_id: "a",
    storage_path: `${GAME_ID}/0/${id}.jpg`,
    kind: "photo",
    created_at: createdAt,
    ...overrides,
  };
}

describe("timestampMicros", () => {
  it("keeps sub-millisecond precision", () => {
    const a = timestampMicros("2026-10-23T20:00:00.123456+00:00");
    const b = timestampMicros("2026-10-23T20:00:00.123457+00:00");
    expect(b - a).toBe(1);
  });

  it("handles offsets, missing zones, space separators and short fractions", () => {
    const utc = timestampMicros("2026-10-23T20:00:00.5Z");
    expect(timestampMicros("2026-10-23 22:00:00.500+02:00")).toBe(utc);
    expect(timestampMicros("2026-10-23T20:00:00.5")).toBe(utc);
    expect(timestampMicros("2026-10-23T15:30:00.5-04:30")).toBe(utc);
    expect(utc).toBe(Date.parse("2026-10-23T20:00:00.500Z") * 1000);
  });

  it("is NaN for junk", () => {
    expect(timestampMicros("not a date")).toBeNaN();
    expect(timestampMicros(null)).toBeNaN();
  });
});

describe("applySquareChange", () => {
  const held = [square(0, "2026-10-23T20:00:01.000002+00:00", { label: "Mine" }), square(1, "2026-10-23T20:00:00+00:00")];

  it("drops a square event that is older than the row held", () => {
    const stale = square(0, "2026-10-23T20:00:01.000001+00:00", { label: "Old" });
    expect(applySquareChange(held, { type: "UPDATE", row: stale })).toBe(held);
  });

  it("drops a duplicate delivery with the same updated_at", () => {
    const same = square(0, "2026-10-23T20:00:01.000002+00:00", { label: "Dup" });
    expect(applySquareChange(held, { type: "UPDATE", row: same })).toBe(held);
  });

  it("applies a newer square event", () => {
    const newer = square(0, "2026-10-23T20:00:01.000003+00:00", { label: "Skyline Chili", details: "3-way" });
    const next = applySquareChange(held, { type: "UPDATE", row: newer });
    expect(next).not.toBe(held);
    expect(next[0]).toEqual(newer);
    expect(next[1]).toBe(held[1]);
  });

  it("inserts unknown squares in position order and removes deleted ones", () => {
    const inserted = applySquareChange(held, { type: "INSERT", row: square(2, "2026-10-23T20:00:00+00:00") });
    expect(inserted.map((s) => s.position)).toEqual([0, 1, 2]);
    const deleted = applySquareChange(inserted, { type: "DELETE", old: { id: "sq-1" } });
    expect(deleted.map((s) => s.position)).toEqual([0, 2]);
    expect(applySquareChange(held, { type: "DELETE", old: { id: "missing" } })).toBe(held);
  });

  it("isNewerSquare treats a held row without a stamp as older", () => {
    expect(isNewerSquare({ updated_at: "2026-10-23T20:00:00Z" }, { updated_at: "" })).toBe(true);
    expect(isNewerSquare({ updated_at: "" }, { updated_at: "2026-10-23T20:00:00Z" })).toBe(false);
  });
});

describe("applyPlayerChange", () => {
  const host = player("a", "2026-10-23T20:00:00+00:00", { is_ready: true });
  const late = player("c", "2026-10-23T20:05:00+00:00");
  const held = [host, late];

  it("inserts a new player in join order", () => {
    const mid = player("b", "2026-10-23T20:01:00+00:00", { color: 1 });
    const next = applyPlayerChange(held, { type: "INSERT", row: mid });
    expect(next.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("updates in place and deletes by id", () => {
    const ready = { ...late, is_ready: true };
    const updated = applyPlayerChange(held, { type: "UPDATE", row: ready });
    expect(updated[1].is_ready).toBe(true);
    expect(updated[0]).toBe(host);
    const deleted = applyPlayerChange(updated, { type: "DELETE", old: { id: "a" } });
    expect(deleted.map((p) => p.id)).toEqual(["c"]);
  });

  it("an INSERT for a player already held acts as an update", () => {
    const renamed = { ...host, display_name: "Hosty" };
    const next = applyPlayerChange(held, { type: "INSERT", row: renamed });
    expect(next).toHaveLength(2);
    expect(next[0].display_name).toBe("Hosty");
  });
});

describe("applyGameChange", () => {
  it("applies updates in place", () => {
    const next = applyGameChange(game(), { type: "UPDATE", row: game({ free_center: false }) });
    expect(next?.free_center).toBe(false);
  });

  it("never moves status backwards", () => {
    const active = game({ status: "active", started_at: "2026-10-23T21:00:00Z" });
    expect(applyGameChange(active, { type: "UPDATE", row: game() })).toBe(active);
    expect(applyGameChange(game(), { type: "UPDATE", row: active })).toBe(active);
  });

  it("returns null when the game is deleted", () => {
    expect(applyGameChange(game(), { type: "DELETE", old: { id: GAME_ID } })).toBeNull();
  });

  it("drops an UPDATE older than the held row by updated_at", () => {
    const held = game({ free_center: false, updated_at: "2026-10-23T20:05:00.000002+00:00" });
    const older = game({ free_center: true, updated_at: "2026-10-23T20:05:00.000001+00:00" });
    expect(applyGameChange(held, { type: "UPDATE", row: older })).toBe(held);
    const newer = game({ free_center: true, updated_at: "2026-10-23T20:05:00.000003+00:00" });
    expect(applyGameChange(held, { type: "UPDATE", row: newer })).toBe(newer);
  });
});

describe("compareGameVersions", () => {
  it("orders by updated_at with microsecond precision, in any offset format", () => {
    const a = { updated_at: "2026-10-26T01:00:00.123455+00:00" };
    const b = { updated_at: "2026-10-26 01:00:00.123456+00" };
    expect(compareGameVersions(b, a)).toBe(1);
    expect(compareGameVersions(a, b)).toBe(-1);
    expect(compareGameVersions(a, { updated_at: "2026-10-25T21:00:00.123455-04:00" })).toBe(0);
  });

  it("is null when either side has no usable stamp", () => {
    const stamped = { updated_at: "2026-10-26T01:00:00Z" };
    expect(compareGameVersions(stamped, {})).toBeNull();
    expect(compareGameVersions({}, stamped)).toBeNull();
    expect(compareGameVersions(stamped, { updated_at: "junk" })).toBeNull();
    // A hand-edited cache can hold anything.
    expect(compareGameVersions(stamped, { updated_at: 7 as unknown as string })).toBeNull();
  });
});

describe("mergeGame", () => {
  const T1 = "2026-10-23T21:00:00.000001+00:00";
  const T2 = "2026-10-23T21:00:00.000002+00:00";
  const active = (overrides: Partial<Game> = {}) =>
    game({ status: "active", started_at: "2026-10-23T21:00:00Z", ...overrides });

  it("takes a newer row and keeps the held object for the same version or an older one", () => {
    const held = active({ updated_at: T1 });
    const same = active({ updated_at: T1 });
    expect(mergeGame(held, same)).toBe(held);
    const newer = active({ updated_at: T2, deadline_at: "2026-10-24T23:00:00Z" });
    expect(mergeGame(held, newer)).toBe(newer);
    expect(mergeGame(newer, held)).toBe(newer);
  });

  it("never moves status backwards, even with a newer stamp; a status move forward always wins", () => {
    const held = active({ updated_at: T2 });
    expect(mergeGame(held, game({ updated_at: "2026-10-23T22:00:00Z" }))).toBe(held);
    const ended = active({ status: "ended", ended_at: "2026-10-23T22:00:00Z", updated_at: T1 });
    expect(mergeGame(held, ended)).toBe(ended);
  });

  it("falls back to the status rule when either row has no updated_at", () => {
    const cached = active(); // saved by a build from before games.updated_at
    const fetched = active({ deadline_at: "2026-10-24T21:00:00Z", updated_at: T1 });
    expect(mergeGame(cached, fetched)).toBe(fetched);
    const unstamped = active({ deadline_at: "2026-10-24T20:00:00Z" });
    expect(mergeGame(fetched, unstamped)).toBe(unstamped);
    expect(mergeGame(fetched, game())).toBe(fetched);
  });

  it("ignores another game's row", () => {
    const held = active({ updated_at: T1 });
    expect(mergeGame(held, active({ id: "22222222-2222-4222-8222-222222222222", updated_at: T2 }))).toBe(held);
  });
});

describe("applyMediaChange", () => {
  const first = media("m1", "2026-10-23T21:00:00.000001+00:00");
  const second = media("m2", "2026-10-23T21:00:00.000002+00:00", { kind: "video", storage_path: `${GAME_ID}/0/m2.mp4` });
  const held = [first, second];

  it("inserts in upload order", () => {
    const early = media("m0", "2026-10-23T20:59:59+00:00");
    expect(applyMediaChange(held, { type: "INSERT", row: early }).map((m) => m.id)).toEqual(["m0", "m1", "m2"]);
    const tie = media("m15", "2026-10-23T21:00:00.000001+00:00");
    expect(applyMediaChange(held, { type: "INSERT", row: tie }).map((m) => m.id)).toEqual(["m1", "m15", "m2"]);
  });

  it("dedupes by id (a duplicate event, or the upload result and its event)", () => {
    expect(applyMediaChange(held, { type: "INSERT", row: { ...first } })).toBe(held);
    expect(applyMediaChange(held, { type: "UPDATE", row: { ...second } })).toBe(held);
    expect(upsertMedia(held, { ...first })).toBe(held);
  });

  it("removes deleted rows by id", () => {
    expect(applyMediaChange(held, { type: "DELETE", old: { id: "m1" } }).map((m) => m.id)).toEqual(["m2"]);
    expect(applyMediaChange(held, { type: "DELETE", old: { id: "missing" } })).toBe(held);
    expect(applyMediaChange(held, { type: "DELETE", old: {} })).toBe(held);
  });

  it("mergeMedia keeps held rows a fetch has not seen yet and the held array when nothing changed", () => {
    const fromUpload = media("m3", "2026-10-23T21:00:05+00:00");
    const merged = mergeMedia([...held, fromUpload], [first, second]);
    expect(merged.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(mergeMedia(held, [{ ...first }, { ...second }])).toBe(held);
    const fetchedNew = media("m4", "2026-10-23T21:00:06+00:00");
    expect(mergeMedia(held, [first, second, fetchedNew]).map((m) => m.id)).toEqual(["m1", "m2", "m4"]);
    expect(mergeMedia([], [])).toEqual([]);
  });
});

describe("mergeSnapshot", () => {
  const base: GameSnapshot = {
    game: game(),
    players: [player("a", "2026-10-23T20:00:00Z")],
    squares: [square(0, "2026-10-23T20:00:05Z", { label: "From event" }), square(1, "2026-10-23T20:00:00Z")],
    media: [media("m1", "2026-10-23T21:00:00Z")],
  };

  it("keeps a held square that is newer than the fetched one, takes newer fetched rows", () => {
    const fetched: GameSnapshot = {
      game: game({ free_center: false }),
      players: [player("a", "2026-10-23T20:00:00Z"), player("b", "2026-10-23T20:01:00Z")],
      squares: [square(0, "2026-10-23T20:00:04Z", { label: "Older" }), square(1, "2026-10-23T20:00:06Z", { label: "New" })],
      media: [media("m2", "2026-10-23T21:00:01Z")],
    };
    const merged = mergeSnapshot(base, fetched);
    expect(merged.media.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(merged.squares[0].label).toBe("From event");
    expect(merged.squares[1].label).toBe("New");
    expect(merged.players).toHaveLength(2);
    expect(merged.game.free_center).toBe(false);
  });

  it("takes the fetched snapshot when nothing is held", () => {
    expect(mergeSnapshot(null, base)).toBe(base);
  });

  // The verifier's repro (VERIFICATION.md P23): the host's resync read the game
  // before their extension committed, retried past its race budget while
  // squares kept changing, and then merged anyway.
  it("an extension applied from the RPC result survives a stale resync that read the game before it", () => {
    const live = {
      ...game(),
      status: "active" as const,
      started_at: "2026-10-26T01:00:00.000000+00:00",
      deadline_at: "2026-10-26T04:00:00.000000+00:00",
      updated_at: "2026-10-26T01:00:00.000000+00:00",
    };
    const extended = {
      ...live,
      deadline_at: "2026-10-26T07:00:00.000000+00:00",
      deadline_extended_at: "2026-10-26T01:04:00.512345+00:00",
      updated_at: "2026-10-26T01:04:00.512345+00:00",
    };
    const heldSquares = [square(0, "2026-10-26T01:03:59.000000+00:00"), square(1, "2026-10-26T01:00:00.000000+00:00")];
    const held: GameSnapshot = { ...base, game: live, squares: heldSquares };

    // applyGame(await extendDeadline(...)) folds the RPC row in first.
    const afterRpc = { ...held, game: mergeGame(held.game, extended) };
    expect(afterRpc.game).toBe(extended);

    // The stale fetch lands afterwards: old games row (from before the
    // extension), plus a friend's completion that happened meanwhile.
    const friendDone = square(1, "2026-10-26T01:04:00.900000+00:00", {
      completed_at: "2026-10-26T01:04:00.900000+00:00",
      completed_by_player_id: "b",
      current_count: 1,
    });
    const stale: GameSnapshot = { ...base, game: { ...live }, squares: [heldSquares[0], friendDone] };
    const merged = mergeSnapshot(afterRpc, stale);
    expect(merged.game).toBe(extended);
    expect(merged.game.deadline_at).toBe("2026-10-26T07:00:00.000000+00:00");
    expect(merged.game.deadline_extended_at ?? null).not.toBeNull(); // "Extend deadline" stays hidden
    expect(merged.squares[1]).toBe(friendDone); // the rest of the fetch still applies

    // A later fetch of the same version keeps the held object.
    expect(mergeSnapshot(merged, { ...stale, game: { ...extended } }).game).toBe(extended);
    // A genuinely newer row of the same status still wins (here the rematch
    // pointer an old member sees; any later write stamps a later updated_at).
    const newer = {
      ...extended,
      next_game_id: "33333333-3333-4333-8333-333333333333",
      next_join_code: "WXYZ6789",
      updated_at: "2026-10-26T01:04:00.512346+00:00",
    };
    expect(mergeSnapshot(merged, { ...stale, game: newer }).game).toBe(newer);
    // ...and so does the end (status moves forward).
    const ended = { ...extended, status: "ended" as const, ended_at: "2026-10-26T02:00:00Z", updated_at: "2026-10-26T02:00:00.000001+00:00" };
    expect(mergeSnapshot(merged, { ...stale, game: ended }).game).toBe(ended);
  });

  it("a lobby set_deadline from the RPC result survives a stale resync, and a newer change still lands", () => {
    const lobby = { ...game(), updated_at: "2026-10-23T20:00:00.000000+00:00" };
    const changed = { ...lobby, deadline_at: "2026-10-25T03:00:00.000000+00:00", updated_at: "2026-10-23T20:10:00.000001+00:00" };
    const held: GameSnapshot = { ...base, game: mergeGame(lobby, changed) };
    expect(mergeSnapshot(held, { ...base, game: lobby }).game).toBe(changed);
    // The host changes it again from another tab: the fetch carries a later stamp.
    const again = { ...changed, deadline_at: "2026-10-24T05:00:00.000000+00:00", updated_at: "2026-10-23T20:12:30.000000+00:00" };
    expect(mergeSnapshot(held, { ...base, game: again }).game).toBe(again);
  });

  it("the extension also survives a stale Realtime event and a stale RPC result arriving late", () => {
    const live = game({ status: "active", started_at: "2026-10-26T01:00:00Z", updated_at: "2026-10-26T01:00:00.000000+00:00" });
    const extended = { ...live, deadline_at: "2026-10-26T07:00:00Z", deadline_extended_at: "2026-10-26T01:04:00Z", updated_at: "2026-10-26T01:04:00.000001+00:00" };
    expect(applyGameChange(extended, { type: "UPDATE", row: { ...live } })).toBe(extended);
    expect(mergeGame(extended, { ...live })).toBe(extended);
  });
});

describe("toRowChange", () => {
  it("maps supabase-js payloads", () => {
    const meta = { schema: "public", table: "squares", commit_timestamp: "", errors: [] as string[] };
    const row = square(3, "2026-10-23T20:00:00Z");
    expect(toRowChange<Square>({ ...meta, eventType: "UPDATE", new: row, old: {} })).toEqual({ type: "UPDATE", row });
    expect(toRowChange<Square>({ ...meta, eventType: "DELETE", new: {}, old: { id: "sq-3" } })).toEqual({
      type: "DELETE",
      old: { id: "sq-3" },
    });
  });
});

describe("syncPollMs", () => {
  it("defaults to 15s and accepts sane overrides", () => {
    expect(syncPollMs(undefined)).toBe(DEFAULT_SYNC_POLL_MS);
    expect(syncPollMs("1500")).toBe(1500);
    expect(syncPollMs("abc")).toBe(DEFAULT_SYNC_POLL_MS);
    expect(syncPollMs("10")).toBe(DEFAULT_SYNC_POLL_MS);
  });
});
