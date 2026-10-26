import { ensureSession } from "@/lib/supabase/auth";
import { createClient, type BrowserSupabaseClient } from "@/lib/supabase/client";
import { GameError, toGameError } from "@/lib/game/errors";
import type { Game, GamePreview, Media, MediaKind, Player, Square, SquareResult } from "@/lib/game/types";
import type { Database } from "@/types/database";

/**
 * One typed wrapper per RPC in CLAUDE.md > Database API (exact argument names).
 * Every state change in the app goes through these; the client never writes
 * tables directly. Each wrapper makes sure an anonymous session exists first,
 * returns the typed row, and throws a `GameError` on failure.
 *
 * `auto_end_due_games` is service-role only (cleanup cron) and deliberately
 * has no browser wrapper. `peek_game_public` needs no session and lives in
 * `publicRpc.ts` (anon client, usable from server code).
 */

type Functions = Database["public"]["Functions"];
type Args<F extends keyof Functions> = Functions[F]["Args"];

type RpcResult<T> = { data: T | null; error: unknown };

async function call<T>(run: (supabase: BrowserSupabaseClient) => PromiseLike<RpcResult<T>>): Promise<T> {
  try {
    await ensureSession();
  } catch (cause) {
    throw new GameError("not_authenticated", cause);
  }
  let result: RpcResult<T>;
  try {
    result = await run(createClient());
  } catch (cause) {
    throw toGameError(cause);
  }
  if (result.error) throw toGameError(result.error);
  if (result.data === null || result.data === undefined) {
    throw new GameError("unknown", new Error("RPC returned no data"));
  }
  return result.data;
}

/** The generated composite type marks every field nullable; the RPC never returns nulls here. */
function asSquareResult(row: Functions["complete_square"]["Returns"]): SquareResult {
  if (row.id === null || row.applied === null) {
    throw new GameError("unknown", new Error("Malformed square_result"));
  }
  return row as SquareResult;
}

export type NewSquare = {
  position: number;
  label?: string;
  details?: string;
  target_count?: number;
};

export function createGame(args: {
  name: string;
  host_name: string;
  free_center?: boolean;
  squares?: NewSquare[];
  /**
   * When the game ends automatically (ISO string; the host's pick, 10 minutes
   * to 7 days ahead, checked by the RPC). `null` = the server default, 24 hours
   * from now.
   */
  deadlineAt: string | null;
}): Promise<Game> {
  const payload: Args<"create_game"> = {
    name: args.name,
    host_name: args.host_name,
    free_center: args.free_center ?? true,
    squares: args.squares ?? [],
  };
  if (args.deadlineAt !== null) payload.deadline_at = args.deadlineAt;
  return call((sb) => sb.rpc("create_game", payload));
}

export function joinGame(args: Args<"join_game">): Promise<Player> {
  return call((sb) => sb.rpc("join_game", args));
}

export async function peekGame(args: Args<"peek_game">): Promise<GamePreview> {
  const row = await call((sb) => sb.rpc("peek_game", args));
  if (row.name === null || row.status === null) {
    throw new GameError("game_not_found", new Error("Empty game_preview"));
  }
  return {
    name: row.name,
    status: row.status,
    player_count: row.player_count ?? 0,
    free_center: row.free_center ?? true,
  };
}

export function setReady(args: Args<"set_ready">): Promise<Player> {
  return call((sb) => sb.rpc("set_ready", args));
}

export function updateSquare(args: Args<"update_square">): Promise<Square> {
  return call((sb) => sb.rpc("update_square", args));
}

export function setFreeCenter(args: Args<"set_free_center">): Promise<Game> {
  return call((sb) => sb.rpc("set_free_center", args));
}

/** Host only, lobby only: a new deadline (ISO string), 10 minutes to 7 days from now. */
export function setDeadline(gameId: string, deadlineAt: string): Promise<Game> {
  const args: Args<"set_deadline"> = { game_id: gameId, deadline_at: deadlineAt };
  return call((sb) => sb.rpc("set_deadline", args));
}

/**
 * Host only, live games only, once per game: moves the deadline later by at
 * most one day (`already_extended` the second time). Resolves the updated game.
 */
export function extendDeadline(gameId: string, deadlineAt: string): Promise<Game> {
  const args: Args<"extend_deadline"> = { game_id: gameId, deadline_at: deadlineAt };
  return call((sb) => sb.rpc("extend_deadline", args));
}

export function startGame(args: Args<"start_game">): Promise<Game> {
  return call((sb) => sb.rpc("start_game", args));
}

export async function completeSquare(args: Args<"complete_square">): Promise<SquareResult> {
  return asSquareResult(await call((sb) => sb.rpc("complete_square", args)));
}

/**
 * Counter +1. `actionId` (the queued tap's client id, a UUID) makes the call
 * idempotent: a retry with the same id never counts twice, while different
 * taps always all count. `null` increments without that protection.
 */
export async function incrementSquare(gameId: string, position: number, actionId: string | null): Promise<SquareResult> {
  const args: Args<"increment_square"> = { game_id: gameId, position };
  if (actionId !== null) args.action_id = actionId;
  return asSquareResult(await call((sb) => sb.rpc("increment_square", args)));
}

export async function undoCompletion(args: Args<"undo_completion">): Promise<SquareResult> {
  return asSquareResult(await call((sb) => sb.rpc("undo_completion", args)));
}

export function endGame(args: Args<"end_game">): Promise<Game> {
  return call((sb) => sb.rpc("end_game", args));
}

/** A non-host player leaves the lobby (their player row is deleted). Resolves true. */
export function leaveGame(gameId: string): Promise<boolean> {
  const args: Args<"leave_game"> = { game_id: gameId };
  return call((sb) => sb.rpc("leave_game", args));
}

/** Host only, lobby only: removes another player. Resolves true. */
export function removePlayer(gameId: string, playerId: string): Promise<boolean> {
  const args: Args<"remove_player"> = { game_id: gameId, player_id: playerId };
  return call((sb) => sb.rpc("remove_player", args));
}

/**
 * Any member of an ended game: the rematch (a new lobby with the same name,
 * free_center and board, hosted by whoever asked first). Idempotent per old
 * game, so the result may be a game someone else already started; then the
 * caller is not a player in it yet (`host_user_id` is not theirs) and joins it
 * with `joinGame(game.join_code, …)`.
 */
export function playAgain(gameId: string): Promise<Game> {
  const args: Args<"play_again"> = { game_id: gameId };
  return call((sb) => sb.rpc("play_again", args));
}

export function registerMedia(
  args: Omit<Args<"register_media">, "kind"> & { kind: MediaKind },
): Promise<Media> {
  return call((sb) => sb.rpc("register_media", args));
}
