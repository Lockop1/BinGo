import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * Daily cleanup logic for the cron route (src/app/api/cron/cleanup/route.ts).
 *
 * This module never creates a Supabase client: the route passes in the
 * service-role client, so the admin import stays confined to the route file
 * (ESLint enforces that). Keeping the logic here makes it testable with a fake.
 *
 * Steps:
 *  1. rpc("auto_end_due_games"): end active games past their deadline_at (the
 *     backstop: phones already treat them as ended).
 *  2. Select games with expires_at < now (ids only, oldest first, capped).
 *  3. Per expired game: delete every object under `game-media/<game_id>/`
 *     (walking folders recursively, since Storage list() is per folder,
 *     non-recursive and paginated), then delete the game row (cascades to
 *     players, squares, media). The row is deleted ONLY if storage cleanup
 *     fully succeeded; otherwise it stays so the next run retries.
 *
 * Failures are recorded in the report and never abort the run.
 */

export const MEDIA_BUCKET = "game-media";

/** Storage `remove()` and `list()` page size cap. */
export const MAX_BATCH_SIZE = 100;

/** Expired games processed per run; the rest are picked up by the next run. */
export const MAX_GAMES_PER_RUN = 500;

/** Folder depth guard. Objects are `<game_id>/<position>/<file>`, so 2 levels of folders. */
const MAX_FOLDER_DEPTH = 8;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CleanupStep =
  | "auto_end"
  | "select_expired"
  | "list_storage"
  | "remove_storage"
  | "delete_game";

export type CleanupError = {
  /** null for run-level steps (auto_end, select_expired). */
  gameId: string | null;
  step: CleanupStep;
  message: string;
};

export type CleanupReport = {
  endedGames: number;
  expiredGames: number;
  deletedGames: number;
  deletedObjects: number;
  errors: CleanupError[];
  durationMs: number;
};

export type CleanupOptions = {
  /** Reference time for expiry (defaults to the current time). */
  now?: Date;
  /** Page size for list() and chunk size for remove(); clamped to 1..100. Default 100. */
  batchSize?: number;
};

class StepError extends Error {
  constructor(
    readonly step: CleanupStep,
    message: string,
  ) {
    super(message);
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

type Storage = SupabaseClient<Database>["storage"];

/** Recursively collects every object path under `prefix` (a folder, no trailing slash). */
async function collectObjectPaths(
  storage: Storage,
  prefix: string,
  pageSize: number,
  depth = 0,
): Promise<string[]> {
  if (depth > MAX_FOLDER_DEPTH) {
    throw new StepError("list_storage", `folder nesting deeper than ${MAX_FOLDER_DEPTH} under ${prefix}`);
  }

  const bucket = storage.from(MEDIA_BUCKET);
  const files: string[] = [];
  const folders: string[] = [];

  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await bucket.list(prefix, {
      limit: pageSize,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw new StepError("list_storage", `${prefix}/: ${messageOf(error)}`);
    const page = data ?? [];
    for (const entry of page) {
      if (!entry.name) continue;
      const path = `${prefix}/${entry.name}`;
      // Storage returns folders (common prefixes) with id === null.
      if (entry.id === null) folders.push(path);
      else files.push(path);
    }
    if (page.length < pageSize) break;
  }

  for (const folder of folders) {
    files.push(...(await collectObjectPaths(storage, folder, pageSize, depth + 1)));
  }
  return files;
}

/**
 * Deletes every object under `<gameId>/`, calling `onRemoved` after each successful
 * batch so partially completed work is still counted if a later batch fails.
 */
async function deleteGameObjects(
  storage: Storage,
  gameId: string,
  batchSize: number,
  onRemoved: (count: number) => void,
): Promise<void> {
  // Never let a malformed id turn into a bucket-root (or other game's) prefix.
  if (!UUID_RE.test(gameId)) throw new StepError("list_storage", `refusing non-uuid game id`);

  const paths = await collectObjectPaths(storage, gameId, batchSize);
  for (let i = 0; i < paths.length; i += batchSize) {
    const chunk = paths.slice(i, i + batchSize);
    const { error } = await storage.from(MEDIA_BUCKET).remove(chunk);
    if (error) throw new StepError("remove_storage", messageOf(error));
    onRemoved(chunk.length);
  }
}

export async function runCleanup(
  client: SupabaseClient<Database>,
  opts: CleanupOptions = {},
): Promise<CleanupReport> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const batchSize = Math.min(MAX_BATCH_SIZE, Math.max(1, Math.floor(opts.batchSize ?? MAX_BATCH_SIZE)));

  const report: CleanupReport = {
    endedGames: 0,
    expiredGames: 0,
    deletedGames: 0,
    deletedObjects: 0,
    errors: [],
    durationMs: 0,
  };
  const fail = (gameId: string | null, step: CleanupStep, err: unknown) => {
    report.errors.push({ gameId, step, message: messageOf(err) });
  };

  // 1. Auto-end overdue active games. Independent of expiry, so a failure here
  //    is recorded and the run continues.
  try {
    const { data, error } = await client.rpc("auto_end_due_games");
    if (error) fail(null, "auto_end", error);
    else report.endedGames = typeof data === "number" ? data : Number(data ?? 0);
  } catch (err) {
    fail(null, "auto_end", err);
  }

  // 2. Expired games (ids only).
  let expiredIds: string[] = [];
  try {
    const { data, error } = await client
      .from("games")
      .select("id")
      .lt("expires_at", now.toISOString())
      .order("expires_at", { ascending: true })
      .limit(MAX_GAMES_PER_RUN);
    if (error) fail(null, "select_expired", error);
    else expiredIds = (data ?? []).map((row) => row.id);
  } catch (err) {
    fail(null, "select_expired", err);
  }
  report.expiredGames = expiredIds.length;

  // 3. Per game: storage first, then the row only if storage fully succeeded.
  for (const gameId of expiredIds) {
    try {
      await deleteGameObjects(client.storage, gameId, batchSize, (n) => {
        report.deletedObjects += n;
      });
    } catch (err) {
      fail(gameId, err instanceof StepError ? err.step : "list_storage", err);
      continue; // keep the row; tomorrow's run retries
    }

    try {
      const { error } = await client.from("games").delete().eq("id", gameId);
      if (error) fail(gameId, "delete_game", error);
      else report.deletedGames += 1;
    } catch (err) {
      fail(gameId, "delete_game", err);
    }
  }

  report.durationMs = Date.now() - started;
  return report;
}
