import { toGameError } from "@/lib/game/errors";
import type { Media, MediaKind } from "@/lib/game/types";
import type { PreparedMedia } from "@/lib/media/types";

/**
 * Background upload queue for game media (React-free; see useUploadQueue.ts
 * for the hook and defaultUploadQueue.ts for the real Supabase wiring).
 *
 * Each item: upload the blob to the private `game-media` bucket at
 * `<game_id>/<position>/<uuid>.<ext>` with `upsert: false`, then
 * `register_media` with the same path. Items run one at a time in enqueue
 * order so a phone on bad signal is never pushing several files at once, and
 * nothing here ever blocks the board.
 *
 * Failures:
 * - Network / 5xx / unknown errors are retried automatically with backoff
 *   (at most `maxAttempts` = 3 tries), then the item is `failed` with
 *   `retryable: true` and `retry(id)` starts it again.
 * - Definitive errors (a `GameError` such as `square_not_completed` or
 *   `game_expired`, or a 4xx from Storage) fail immediately with friendly
 *   copy and `retryable: false`.
 * - A retry never re-uploads a blob that already made it: it goes straight to
 *   `register_media`, which is idempotent for the same path/player/square. A
 *   409 "already exists" on our own fresh uuid path means an earlier attempt
 *   landed but its response was lost, so it counts as uploaded.
 *
 * NOT persisted: items (and their blobs) live in memory only, because a
 * `File`/`Blob` cannot be stored in localStorage. Reloading or closing the tab
 * drops anything still queued or failed; the UI keeps them visible while the
 * page is open so the player can retry.
 */

export type UploadState = "queued" | "uploading" | "registering" | "done" | "failed";

export type UploadItem = {
  id: string;
  gameId: string;
  position: number;
  playerId: string;
  kind: MediaKind;
  contentType: string;
  /** Object name in `game-media`, fixed at enqueue so retries reuse it. */
  path: string;
  state: UploadState;
  /** Tries in the current run (resets on `retry`). */
  attempts: number;
  /** The object is in Storage; only `register_media` remains. */
  uploaded: boolean;
  /** Friendly copy when `failed`. */
  error: string | null;
  errorCode: string | null;
  /** `failed` items the player can retry (network trouble), vs definitive refusals. */
  retryable: boolean;
  media: Media | null;
  createdAt: number;
};

export type UploadOptions = { contentType: string; upsert: boolean; cacheControl: string };
type StorageResult = { data: unknown; error: unknown };

export type StorageBucketLike = {
  upload(path: string, body: Blob, options: UploadOptions): PromiseLike<StorageResult>;
  remove?(paths: string[]): PromiseLike<StorageResult>;
};
export type StorageLike = { from(bucket: string): StorageBucketLike };

export type RegisterMediaFn = (gameId: string, position: number, storagePath: string, kind: MediaKind) => Promise<Media>;

export type UploadQueueDeps = {
  /** A storage client, or a (possibly async) getter, e.g. one that ensures a session first. */
  storage: StorageLike | (() => StorageLike | Promise<StorageLike>);
  registerMedia: RegisterMediaFn;
  sleep?: (ms: number) => Promise<void>;
  randomUUID?: () => string;
  maxAttempts?: number;
  /** Delay before automatic try `attempt + 1`. */
  backoffMs?: (attempt: number) => number;
  now?: () => number;
};

export type EnqueueInput = { gameId: string; position: number; prepared: PreparedMedia; playerId: string };

export type UploadQueue = {
  enqueue(input: EnqueueInput): string;
  retry(id: string): boolean;
  /** Forget a `done` or `failed` item. */
  dismiss(id: string): boolean;
  getSnapshot(): readonly UploadItem[];
  subscribe(listener: () => void): () => void;
  /** Resolves when nothing is queued or in flight (tests, dev tools). */
  whenIdle(): Promise<void>;
};

export const MEDIA_BUCKET = "game-media";
export const MAX_UPLOAD_ATTEMPTS = 3;
export const UPLOAD_CACHE_CONTROL = "3600";

export const UPLOAD_COPY = {
  network: "Couldn't upload. Check your signal and try again.",
  tooBig: "That file is too big to upload.",
  badType: "That file type can't be uploaded.",
  denied: "You can't add media to this game anymore.",
  generic: "Couldn't upload that file.",
} as const;

class UploadFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaultBackoff = (attempt: number) => 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 400);

/** RFC 4122 v4; `crypto.randomUUID` is missing on plain-http LAN dev origins. */
export function randomUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `<game_id>/<position>/<uuid>.<ext>` (CLAUDE.md > Storage). */
export function mediaObjectPath(gameId: string, position: number, uuid: string, ext: string): string {
  return `${gameId.toLowerCase()}/${position}/${uuid}.${ext}`;
}

type StorageErrorLike = { status?: unknown; statusCode?: unknown; message?: unknown };

/** Storage error → "the object is already there" | retry | definitive failure. */
export function classifyStorageError(error: unknown): "exists" | UploadFailure {
  const e = (error && typeof error === "object" ? error : {}) as StorageErrorLike;
  const status =
    typeof e.status === "number" ? e.status : typeof e.statusCode === "string" ? Number(e.statusCode) : undefined;
  const statusCode = typeof e.statusCode === "string" ? e.statusCode : undefined;
  const message = typeof e.message === "string" ? e.message : "";
  if (status === 409 || statusCode === "409" || /already exists|duplicate/i.test(message)) return "exists";
  if (status === undefined || Number.isNaN(status) || status >= 500 || status === 408 || status === 429) {
    return new UploadFailure(UPLOAD_COPY.network, "storage_unavailable", true);
  }
  if (status === 413) return new UploadFailure(UPLOAD_COPY.tooBig, "storage_too_big", false);
  if (status === 415 || (status === 400 && /mime|type/i.test(message))) {
    return new UploadFailure(UPLOAD_COPY.badType, "storage_bad_type", false);
  }
  if (status === 401 || status === 403) return new UploadFailure(UPLOAD_COPY.denied, "storage_denied", false);
  return new UploadFailure(UPLOAD_COPY.generic, `storage_${status}`, false);
}

function toFailure(error: unknown): UploadFailure {
  if (error instanceof UploadFailure) return error;
  const gameError = toGameError(error);
  // `unknown` = network trouble or an unexpected response; `not_authenticated` = no session yet (offline sign-in).
  const retryable = gameError.code === "unknown" || gameError.code === "not_authenticated";
  // `not_allowed` here means register_media refused post-game media (not the uploader's square and the
  // grace window is over): show the upload copy, not the undo copy that code carries elsewhere.
  const copy = retryable
    ? UPLOAD_COPY.network
    : gameError.code === "not_allowed"
      ? UPLOAD_COPY.denied
      : gameError.message;
  return new UploadFailure(copy, gameError.code, retryable);
}

export function createUploadQueue(deps: UploadQueueDeps): UploadQueue {
  const sleep = deps.sleep ?? defaultSleep;
  const uuid = deps.randomUUID ?? randomUUID;
  const maxAttempts = deps.maxAttempts ?? MAX_UPLOAD_ATTEMPTS;
  const backoff = deps.backoffMs ?? defaultBackoff;
  const now = deps.now ?? Date.now;

  let items: readonly UploadItem[] = [];
  const blobs = new Map<string, Blob>();
  const listeners = new Set<() => void>();
  let pumping: Promise<void> | null = null;

  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  const get = (id: string) => items.find((item) => item.id === id);
  const patch = (id: string, change: Partial<UploadItem>) => {
    items = items.map((item) => (item.id === id ? { ...item, ...change } : item));
    emit();
  };

  const getStorage = async (): Promise<StorageLike> =>
    typeof deps.storage === "function" ? await deps.storage() : deps.storage;

  async function upload(item: UploadItem, blob: Blob): Promise<void> {
    const storage = await getStorage();
    const { error } = await storage.from(MEDIA_BUCKET).upload(item.path, blob, {
      contentType: item.contentType,
      upsert: false,
      cacheControl: UPLOAD_CACHE_CONTROL,
    });
    if (!error) return;
    const outcome = classifyStorageError(error);
    if (outcome === "exists") return;
    throw outcome;
  }

  async function removeOrphan(path: string) {
    try {
      const storage = await getStorage();
      await storage.from(MEDIA_BUCKET).remove?.([path]);
    } catch {
      // Best effort: the daily cleanup removes it with the game anyway.
    }
  }

  async function process(id: string) {
    for (let attempt = 1; ; attempt += 1) {
      const item = get(id);
      if (!item) return;
      patch(id, { attempts: attempt, state: item.uploaded ? "registering" : "uploading", error: null, errorCode: null });
      try {
        if (!item.uploaded) {
          const blob = blobs.get(id);
          if (!blob) throw new UploadFailure(UPLOAD_COPY.generic, "missing_blob", false);
          await upload(item, blob);
          patch(id, { uploaded: true, state: "registering" });
        }
        const media = await deps.registerMedia(item.gameId, item.position, item.path, item.kind);
        blobs.delete(id);
        patch(id, { state: "done", media, retryable: false });
        return;
      } catch (error) {
        const failure = toFailure(error);
        if (!failure.retryable || attempt >= maxAttempts) {
          const current = get(id);
          patch(id, { state: "failed", error: failure.message, errorCode: failure.code, retryable: failure.retryable });
          if (!failure.retryable) {
            blobs.delete(id);
            // The object made it but the game refused it (e.g. expired): don't leave it behind.
            if (current?.uploaded) void removeOrphan(item.path);
          }
          return;
        }
        await sleep(backoff(attempt));
      }
    }
  }

  function pump(): Promise<void> {
    if (pumping) return pumping;
    const run = async () => {
      for (;;) {
        const next = items.find((item) => item.state === "queued");
        if (!next) return;
        await process(next.id);
      }
    };
    // `.finally` always runs after the assignment below; re-pump in case something
    // was queued in the gap between the loop ending and this callback.
    pumping = run().finally(() => {
      pumping = null;
      if (items.some((item) => item.state === "queued")) void pump();
    });
    return pumping;
  }

  return {
    enqueue({ gameId, position, prepared, playerId }) {
      const id = uuid();
      const path = mediaObjectPath(gameId, position, uuid(), prepared.ext);
      blobs.set(id, prepared.blob);
      items = [
        ...items,
        {
          id,
          gameId,
          position,
          playerId,
          kind: prepared.kind,
          contentType: prepared.contentType,
          path,
          state: "queued",
          attempts: 0,
          uploaded: false,
          error: null,
          errorCode: null,
          retryable: false,
          media: null,
          createdAt: now(),
        },
      ];
      emit();
      void pump();
      return id;
    },
    retry(id) {
      const item = get(id);
      if (!item || item.state !== "failed" || !item.retryable) return false;
      patch(id, { state: "queued", attempts: 0, error: null, errorCode: null });
      void pump();
      return true;
    },
    dismiss(id) {
      const item = get(id);
      if (!item || (item.state !== "done" && item.state !== "failed")) return false;
      blobs.delete(id);
      items = items.filter((i) => i.id !== id);
      emit();
      return true;
    },
    getSnapshot: () => items,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async whenIdle() {
      while (pumping) await pumping;
    },
  };
}
