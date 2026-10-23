import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { Database } from "@/types/database";
import { MEDIA_BUCKET, runCleanup } from "./runCleanup";

/**
 * Hand-rolled fake of the slice of supabase-js that runCleanup uses:
 * rpc(), from("games").select().lt().order().limit(), from("games").delete().eq(),
 * and storage.from(bucket).list()/remove(). No network.
 *
 * Storage is modelled as a flat set of object paths; list(prefix) derives the
 * immediate files (id set) and sub-folders (id null) like Supabase Storage does,
 * sorted by name and paginated by limit/offset.
 */

const NOW = new Date("2026-10-23T09:17:00.000Z");
const PAST = "2026-09-01T00:00:00.000Z";
const FUTURE = "2026-11-20T00:00:00.000Z";

const GAME_A = "aaaaaaaa-0000-4000-8000-000000000001";
const GAME_B = "bbbbbbbb-0000-4000-8000-000000000002";
const GAME_C = "cccccccc-0000-4000-8000-000000000003";

type Call = { op: string; args: unknown[] };
type Game = { id: string; expires_at: string };

type FakeOptions = {
  games: Game[];
  objects?: string[];
  endedCount?: number;
  /** Return an error from remove() when any path in the batch starts with this prefix. */
  failRemoveFor?: string;
  /** Return an error from every list() call (e.g. the local backend's Storage 501 stub). */
  failList?: boolean;
};

function makeFake(opts: FakeOptions) {
  const calls: Call[] = [];
  const games = [...opts.games];
  const objects = new Set(opts.objects ?? []);
  const removeBatches: string[][] = [];
  const listCalls: { prefix: string; limit: number; offset: number }[] = [];

  const list = async (prefix: string, o: { limit: number; offset: number }) => {
    listCalls.push({ prefix, limit: o.limit, offset: o.offset });
    calls.push({ op: "storage.list", args: [prefix, o] });
    if (opts.failList) return { data: null, error: { message: "storage not available" } };
    const base = `${prefix}/`;
    const entries = new Map<string, { name: string; id: string | null }>();
    for (const path of objects) {
      if (!path.startsWith(base)) continue;
      const rest = path.slice(base.length);
      const slash = rest.indexOf("/");
      if (slash === -1) entries.set(rest, { name: rest, id: `id-${path}` });
      else entries.set(rest.slice(0, slash), { name: rest.slice(0, slash), id: null });
    }
    const sorted = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
    return { data: sorted.slice(o.offset, o.offset + o.limit), error: null };
  };

  const remove = async (paths: string[]) => {
    calls.push({ op: "storage.remove", args: [paths] });
    if (opts.failRemoveFor && paths.some((p) => p.startsWith(opts.failRemoveFor!))) {
      return { data: null, error: { message: "remove failed (simulated)" } };
    }
    removeBatches.push(paths);
    for (const p of paths) objects.delete(p);
    return { data: paths.map((name) => ({ name })), error: null };
  };

  const client = {
    rpc: async (fn: string) => {
      calls.push({ op: "rpc", args: [fn] });
      return { data: opts.endedCount ?? 0, error: null };
    },
    from: (table: string) => {
      if (table !== "games") throw new Error(`unexpected table ${table}`);
      return {
        select: (cols: string) => {
          let cutoff = "";
          const q = {
            lt: (col: string, value: string) => {
              if (col !== "expires_at") throw new Error(`unexpected filter ${col}`);
              cutoff = value;
              return q;
            },
            order: () => q,
            limit: async (n: number) => {
              calls.push({ op: "games.select", args: [cols, cutoff, n] });
              const rows = games.filter((g) => g.expires_at < cutoff).map((g) => ({ id: g.id }));
              return { data: rows.slice(0, n), error: null };
            },
          };
          return q;
        },
        delete: () => ({
          eq: async (col: string, id: string) => {
            calls.push({ op: "games.delete", args: [col, id] });
            const i = games.findIndex((g) => g.id === id);
            if (i >= 0) games.splice(i, 1);
            return { data: null, error: null };
          },
        }),
      };
    },
    storage: {
      from: (bucket: string) => {
        if (bucket !== MEDIA_BUCKET) throw new Error(`unexpected bucket ${bucket}`);
        return { list, remove };
      },
    },
  };

  return {
    client: client as unknown as SupabaseClient<Database>,
    calls,
    games,
    objects,
    removeBatches,
    listCalls,
  };
}

/** `<game>/<position>/<n>.jpg` for each position, `perFolder` files each. */
function mediaFor(gameId: string, positions: number[], perFolder: number): string[] {
  return positions.flatMap((pos) =>
    Array.from({ length: perFolder }, (_, n) => `${gameId}/${pos}/${String(n).padStart(3, "0")}.jpg`),
  );
}

describe("runCleanup", () => {
  it("calls auto_end_due_games first and reports its count", async () => {
    const fake = makeFake({ games: [{ id: GAME_A, expires_at: PAST }], endedCount: 3 });
    const report = await runCleanup(fake.client, { now: NOW });

    expect(fake.calls[0]).toEqual({ op: "rpc", args: ["auto_end_due_games"] });
    expect(fake.calls.filter((c) => c.op === "rpc")).toHaveLength(1);
    expect(fake.calls[1].op).toBe("games.select");
    expect(fake.calls[1].args[1]).toBe(NOW.toISOString());
    expect(report.endedGames).toBe(3);
  });

  it("removes every object under nested folders in batches of at most 100, then deletes the row", async () => {
    // 3 position folders x 90 files = 270 objects, plus a stray file at the game root
    // and a deeper nested folder, to prove the walk is recursive.
    const objects = [
      ...mediaFor(GAME_A, [0, 7, 24], 90),
      `${GAME_A}/root.jpg`,
      `${GAME_A}/7/thumbs/small.jpg`,
    ];
    const other = mediaFor(GAME_B, [1], 2); // not expired: must be untouched
    const fake = makeFake({
      games: [
        { id: GAME_A, expires_at: PAST },
        { id: GAME_B, expires_at: FUTURE },
      ],
      objects: [...objects, ...other],
    });

    const report = await runCleanup(fake.client, { now: NOW });

    expect(report.errors).toEqual([]);
    expect(report.expiredGames).toBe(1);
    expect(report.deletedObjects).toBe(objects.length);
    expect(report.deletedGames).toBe(1);
    expect(fake.removeBatches.length).toBe(Math.ceil(objects.length / 100));
    for (const batch of fake.removeBatches) expect(batch.length).toBeLessThanOrEqual(100);
    expect(new Set(fake.removeBatches.flat())).toEqual(new Set(objects));
    expect([...fake.objects].sort()).toEqual([...other].sort());
    expect(fake.games.map((g) => g.id)).toEqual([GAME_B]);

    // The row is deleted only after all storage removals.
    const lastRemove = fake.calls.map((c) => c.op).lastIndexOf("storage.remove");
    const del = fake.calls.findIndex((c) => c.op === "games.delete");
    expect(del).toBeGreaterThan(lastRemove);
    expect(fake.calls[del].args).toEqual(["id", GAME_A]);
  });

  it("keeps the row and records the error when remove() fails, and still cleans other games", async () => {
    const fake = makeFake({
      games: [
        { id: GAME_A, expires_at: PAST },
        { id: GAME_B, expires_at: PAST },
        { id: GAME_C, expires_at: PAST },
      ],
      objects: [...mediaFor(GAME_A, [0], 3), ...mediaFor(GAME_B, [5], 4), ...mediaFor(GAME_C, [2], 1)],
      failRemoveFor: `${GAME_B}/`,
    });

    const report = await runCleanup(fake.client, { now: NOW });

    expect(report.expiredGames).toBe(3);
    expect(report.deletedGames).toBe(2);
    expect(report.deletedObjects).toBe(4);
    expect(report.errors).toEqual([
      { gameId: GAME_B, step: "remove_storage", message: "remove failed (simulated)" },
    ]);
    expect(fake.games.map((g) => g.id)).toEqual([GAME_B]);
    expect(fake.calls.some((c) => c.op === "games.delete" && c.args[1] === GAME_B)).toBe(false);
    expect([...fake.objects].every((p) => p.startsWith(`${GAME_B}/`))).toBe(true);
  });

  it("keeps every row when list() fails and reports one list_storage error per game", async () => {
    const fake = makeFake({
      games: [
        { id: GAME_A, expires_at: PAST },
        { id: GAME_B, expires_at: PAST },
      ],
      failList: true,
    });

    const report = await runCleanup(fake.client, { now: NOW });

    expect(report.deletedGames).toBe(0);
    expect(report.errors.map((e) => [e.gameId, e.step])).toEqual([
      [GAME_A, "list_storage"],
      [GAME_B, "list_storage"],
    ]);
    expect(fake.calls.some((c) => c.op === "games.delete")).toBe(false);
    expect(fake.games).toHaveLength(2);
  });

  it("deletes nothing when no game is expired", async () => {
    const fake = makeFake({
      games: [
        { id: GAME_A, expires_at: FUTURE },
        { id: GAME_B, expires_at: FUTURE },
      ],
      objects: mediaFor(GAME_A, [0], 2),
      endedCount: 1,
    });

    const report = await runCleanup(fake.client, { now: NOW });

    expect(report).toMatchObject({
      endedGames: 1,
      expiredGames: 0,
      deletedGames: 0,
      deletedObjects: 0,
      errors: [],
    });
    expect(fake.calls.some((c) => c.op.startsWith("storage."))).toBe(false);
    expect(fake.calls.some((c) => c.op === "games.delete")).toBe(false);
    expect(fake.games).toHaveLength(2);
    expect(fake.objects.size).toBe(2);
  });

  it("pages through list() results beyond the page size", async () => {
    // batchSize 3: 7 position folders (3 pages at the game root) and 8 files in
    // one folder (3 pages there). Remove batches are also capped at 3.
    const objects = [...mediaFor(GAME_A, [0, 1, 2, 3, 4, 5], 1), ...mediaFor(GAME_A, [6], 8)];
    const fake = makeFake({ games: [{ id: GAME_A, expires_at: PAST }], objects });

    const report = await runCleanup(fake.client, { now: NOW, batchSize: 3 });

    expect(report.errors).toEqual([]);
    expect(report.deletedObjects).toBe(objects.length);
    expect(fake.objects.size).toBe(0);
    const rootPages = fake.listCalls.filter((c) => c.prefix === GAME_A);
    expect(rootPages.map((c) => c.offset)).toEqual([0, 3, 6]);
    const folder6Pages = fake.listCalls.filter((c) => c.prefix === `${GAME_A}/6`);
    expect(folder6Pages.map((c) => c.offset)).toEqual([0, 3, 6]);
    for (const batch of fake.removeBatches) expect(batch.length).toBeLessThanOrEqual(3);
  });

  it("pages at the default size of 100 when a folder holds more than 100 objects", async () => {
    const objects = mediaFor(GAME_A, [3], 205);
    const fake = makeFake({ games: [{ id: GAME_A, expires_at: PAST }], objects });

    const report = await runCleanup(fake.client, { now: NOW });

    expect(report.deletedObjects).toBe(205);
    const pages = fake.listCalls.filter((c) => c.prefix === `${GAME_A}/3`);
    expect(pages.map((c) => [c.limit, c.offset])).toEqual([
      [100, 0],
      [100, 100],
      [100, 200],
    ]);
    expect(fake.removeBatches.map((b) => b.length)).toEqual([100, 100, 5]);
    expect(report.deletedGames).toBe(1);
  });
});
