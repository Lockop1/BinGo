import { describe, expect, it, vi } from "vitest";
import { GAME_ERROR_COPY, GameError } from "@/lib/game/errors";
import type { Media, MediaKind } from "@/lib/game/types";
import {
  UPLOAD_COPY,
  createUploadQueue,
  type RegisterMediaFn,
  type StorageLike,
  type UploadOptions,
} from "@/lib/media/uploadQueue";
import type { PreparedMedia } from "@/lib/media/types";

const GAME = "0A1B2C3D-0000-4000-8000-000000000001";
const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

const photo = (): PreparedMedia => ({
  blob: new Blob(["jpeg"], { type: "image/jpeg" }),
  contentType: "image/jpeg",
  ext: "jpg",
  kind: "photo",
});
const video = (): PreparedMedia => ({
  blob: new Blob(["webm"], { type: "video/webm" }),
  contentType: "video/webm",
  ext: "webm",
  kind: "video",
});

type UploadResult = { data: unknown; error: unknown };

function setup(opts: {
  upload?: (path: string, n: number) => UploadResult | Promise<UploadResult>;
  register?: (path: string, n: number) => Promise<Media>;
} = {}) {
  const log: string[] = [];
  const uploads: { path: string; blob: Blob; options: UploadOptions }[] = [];
  const removed: string[][] = [];
  const buckets: string[] = [];
  const storage: StorageLike = {
    from(bucket) {
      buckets.push(bucket);
      return {
        async upload(path, blob, options) {
          uploads.push({ path, blob, options });
          log.push(`upload:${path}`);
          return opts.upload ? opts.upload(path, uploads.length) : { data: { path }, error: null };
        },
        async remove(paths) {
          removed.push(paths);
          return { data: [], error: null };
        },
      };
    },
  };
  let registers = 0;
  const registerMedia = vi.fn<RegisterMediaFn>(async (gameId: string, position: number, path: string, kind: MediaKind) => {
    registers += 1;
    log.push(`register:${path}`);
    if (opts.register) return opts.register(path, registers);
    return {
      id: `media-${registers}`,
      game_id: gameId.toLowerCase(),
      square_id: `sq-${position}`,
      player_id: "p1",
      storage_path: path,
      kind,
      created_at: new Date(0).toISOString(),
    };
  });
  const sleep = vi.fn(async () => {});
  const queue = createUploadQueue({ storage, registerMedia, sleep, backoffMs: (n) => n * 1000 });
  return { queue, storage, uploads, removed, buckets, registerMedia, sleep, log };
}

describe("upload queue", () => {
  it("uploads with upsert:false to <game_id>/<position>/<uuid>.<ext>, then registers that path", async () => {
    const t = setup();
    const id = t.queue.enqueue({ gameId: GAME, position: 7, prepared: photo(), playerId: "p1" });
    expect(t.queue.getSnapshot()[0]).toMatchObject({ id, state: expect.stringMatching(/queued|uploading/) });
    await t.queue.whenIdle();

    expect(t.buckets.every((b) => b === "game-media")).toBe(true);
    expect(t.uploads).toHaveLength(1);
    const [{ path, options, blob }] = t.uploads;
    expect(path).toMatch(new RegExp(`^${GAME.toLowerCase()}/7/${UUID_RE}\\.jpg$`));
    expect(options).toEqual({ contentType: "image/jpeg", upsert: false, cacheControl: "3600" });
    expect(blob.type).toBe("image/jpeg");
    expect(t.registerMedia).toHaveBeenCalledWith(GAME, 7, path, "photo");
    const item = t.queue.getSnapshot()[0];
    expect(item).toMatchObject({ state: "done", path, uploaded: true, error: null, attempts: 1 });
    expect(item.media?.storage_path).toBe(path);
  });

  it("processes items one at a time in enqueue order", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const t = setup({
      upload: async (path, n) => {
        if (n === 1) await gate;
        return { data: { path }, error: null };
      },
    });
    const a = t.queue.enqueue({ gameId: GAME, position: 3, prepared: photo(), playerId: "p1" });
    const b = t.queue.enqueue({ gameId: GAME, position: 1, prepared: video(), playerId: "p1" });
    await Promise.resolve();
    await Promise.resolve();
    expect(t.uploads).toHaveLength(1);
    expect(t.queue.getSnapshot().find((i) => i.id === b)?.state).toBe("queued");
    release();
    await t.queue.whenIdle();

    const [pa, pb] = t.queue.getSnapshot().map((i) => i.path);
    expect(t.log).toEqual([`upload:${pa}`, `register:${pa}`, `upload:${pb}`, `register:${pb}`]);
    expect(pb).toMatch(/\/1\/[0-9a-f-]+\.webm$/);
    expect(t.queue.getSnapshot().map((i) => [i.id, i.state])).toEqual([
      [a, "done"],
      [b, "done"],
    ]);
  });

  it("retries network failures with backoff and succeeds", async () => {
    const t = setup({
      upload: (path, n) => (n < 3 ? { data: null, error: { status: 503, message: "busy" } } : { data: { path }, error: null }),
    });
    t.queue.enqueue({ gameId: GAME, position: 0, prepared: photo(), playerId: "p1" });
    await t.queue.whenIdle();
    expect(t.uploads).toHaveLength(3);
    expect(new Set(t.uploads.map((u) => u.path)).size).toBe(1);
    expect(t.sleep.mock.calls).toEqual([[1000], [2000]]);
    expect(t.queue.getSnapshot()[0]).toMatchObject({ state: "done", attempts: 3 });
  });

  it("stops after 3 automatic tries, then retry(id) starts again", async () => {
    let failing = true;
    const t = setup({
      upload: (path) => (failing ? Promise.reject(new TypeError("Failed to fetch")) : { data: { path }, error: null }),
    });
    const id = t.queue.enqueue({ gameId: GAME, position: 4, prepared: photo(), playerId: "p1" });
    await t.queue.whenIdle();
    expect(t.uploads).toHaveLength(3);
    expect(t.queue.getSnapshot()[0]).toMatchObject({
      state: "failed",
      retryable: true,
      error: UPLOAD_COPY.network,
      attempts: 3,
    });
    expect(t.registerMedia).not.toHaveBeenCalled();

    failing = false;
    expect(t.queue.retry(id)).toBe(true);
    await t.queue.whenIdle();
    expect(t.uploads).toHaveLength(4);
    expect(t.queue.getSnapshot()[0]).toMatchObject({ state: "done", attempts: 1, error: null });
  });

  it("a definitive GameError fails at once with its copy, no retry, and cleans up the object", async () => {
    const t = setup({ register: () => Promise.reject(new GameError("square_not_completed")) });
    const id = t.queue.enqueue({ gameId: GAME, position: 9, prepared: photo(), playerId: "p1" });
    await t.queue.whenIdle();
    const item = t.queue.getSnapshot()[0];
    expect(item).toMatchObject({
      state: "failed",
      retryable: false,
      errorCode: "square_not_completed",
      error: GAME_ERROR_COPY.square_not_completed,
    });
    expect(t.registerMedia).toHaveBeenCalledTimes(1);
    expect(t.sleep).not.toHaveBeenCalled();
    expect(t.removed).toEqual([[item.path]]);
    expect(t.queue.retry(id)).toBe(false);
  });

  it("maps a raw PostgREST P0001 error (game_expired) to its copy", async () => {
    const t = setup({ register: () => Promise.reject({ code: "P0001", message: "game_expired" }) });
    t.queue.enqueue({ gameId: GAME, position: 2, prepared: photo(), playerId: "p1" });
    await t.queue.whenIdle();
    expect(t.queue.getSnapshot()[0]).toMatchObject({ state: "failed", retryable: false, error: "This album has expired." });
  });

  it("a definitive Storage refusal (403) fails without retrying or registering", async () => {
    const t = setup({ upload: () => ({ data: null, error: { status: 403, statusCode: "403", message: "new row violates row-level security policy" } }) });
    t.queue.enqueue({ gameId: GAME, position: 2, prepared: photo(), playerId: "p1" });
    await t.queue.whenIdle();
    expect(t.uploads).toHaveLength(1);
    expect(t.registerMedia).not.toHaveBeenCalled();
    expect(t.queue.getSnapshot()[0]).toMatchObject({ state: "failed", retryable: false, error: UPLOAD_COPY.denied });
  });

  it("never re-uploads once the object landed: retry only re-registers", async () => {
    let online = false;
    const t = setup({
      register: async (path) => {
        if (!online) throw new TypeError("Failed to fetch");
        return {
          id: "m1",
          game_id: GAME,
          square_id: "s",
          player_id: "p1",
          storage_path: path,
          kind: "photo",
          created_at: "",
        };
      },
    });
    const id = t.queue.enqueue({ gameId: GAME, position: 5, prepared: photo(), playerId: "p1" });
    await t.queue.whenIdle();
    expect(t.uploads).toHaveLength(1);
    expect(t.registerMedia).toHaveBeenCalledTimes(3);
    expect(t.queue.getSnapshot()[0]).toMatchObject({ state: "failed", retryable: true, uploaded: true });

    online = true;
    t.queue.retry(id);
    await t.queue.whenIdle();
    expect(t.uploads).toHaveLength(1);
    expect(t.queue.getSnapshot()[0].state).toBe("done");
  });

  it("treats 409 'already exists' on its own fresh path as uploaded (lost response)", async () => {
    const t = setup({ upload: () => ({ data: null, error: { status: 409, statusCode: "409", message: "The resource already exists" } }) });
    t.queue.enqueue({ gameId: GAME, position: 6, prepared: photo(), playerId: "p1" });
    await t.queue.whenIdle();
    expect(t.registerMedia).toHaveBeenCalledTimes(1);
    expect(t.queue.getSnapshot()[0].state).toBe("done");
  });

  it("a failure does not block the next item, and subscribers hear every change", async () => {
    const t = setup({ upload: (path, n) => (n === 1 ? { data: null, error: { status: 413 } } : { data: { path }, error: null }) });
    const seen: string[] = [];
    const unsubscribe = t.queue.subscribe(() => seen.push(t.queue.getSnapshot().map((i) => i.state).join(",")));
    const a = t.queue.enqueue({ gameId: GAME, position: 1, prepared: photo(), playerId: "p1" });
    t.queue.enqueue({ gameId: GAME, position: 1, prepared: photo(), playerId: "p1" });
    await t.queue.whenIdle();
    unsubscribe();
    expect(t.queue.getSnapshot().map((i) => i.state)).toEqual(["failed", "done"]);
    expect(t.queue.getSnapshot()[0].error).toBe(UPLOAD_COPY.tooBig);
    expect(seen.at(-1)).toBe("failed,done");
    expect(seen).toContain("uploading,queued");
    expect(t.queue.dismiss(a)).toBe(true);
    expect(t.queue.getSnapshot()).toHaveLength(1);
  });
});
