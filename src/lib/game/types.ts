import type { Database, Tables } from "@/types/database";

type GameRow = Tables<"games">;
type OptionalColumns =
  | "next_game_id"
  | "next_join_code"
  | "deadline_extended_at"
  | "updated_at"
  | "countdown_ends_at"
  | "end_reason";
/**
 * A `games` row. The rematch columns (set by `play_again`),
 * `deadline_extended_at` (set by `extend_deadline`), `updated_at` (the row
 * version `mergeGame` compares), `countdown_ends_at` (set by `start_game`) and
 * `end_reason` (set with every end) are optional on the client: game snapshots
 * cached in `bingo.activeGame` by builds from before they existed are restored
 * as they were saved. Read them with `?? null` (or `countdownEndsAt` /
 * `endReason`). `deadline_at` is always present (`activeGame.ts` fills it in
 * for such older snapshots).
 */
export type Game = Omit<GameRow, OptionalColumns> & Partial<Pick<GameRow, OptionalColumns>>;
export type Player = Tables<"players">;
export type Square = Tables<"squares">;
export type Media = Tables<"media">;

export type GameStatus = Database["public"]["Enums"]["game_status"];
export type MediaKind = Database["public"]["Enums"]["media_kind"];

/**
 * `square_result` with the nullability the RPCs actually produce: every
 * `squares` column is present, only the completion fields can be null.
 */
export type SquareResult = Square & { applied: boolean };

/** `game_preview` (from `peek_game`); `status` is already the effective status. */
export type GamePreview = {
  name: string;
  status: GameStatus;
  player_count: number;
  free_center: boolean;
};

export const MAX_PLAYERS = 10;
export const BOARD_SIZE = 25;
export const CENTER_POSITION = 12;

/**
 * The status every RPC acts on (CLAUDE.md > Database API > Effective status):
 * an `active` game whose `deadline_at` has passed is treated as ended even
 * before the daily cron sets `status = 'ended'`.
 */
export function effectiveStatus(
  game: Pick<Game, "status" | "deadline_at">,
  now: Date = new Date(),
): GameStatus {
  if (game.status === "active" && new Date(game.deadline_at).getTime() <= now.getTime()) return "ended";
  return game.status;
}

/** Why an ended game ended (`games.end_reason`, set with `status = 'ended'`). */
export type EndReason = "host" | "deadline" | "blackout";

const END_REASONS: readonly string[] = ["host", "deadline", "blackout"];

/** The game's `end_reason`, or null (not ended, or a snapshot from before the column). */
export function endReason(game: Pick<Game, "end_reason">): EndReason | null {
  const reason = game.end_reason ?? null;
  return reason !== null && END_REASONS.includes(reason) ? (reason as EndReason) : null;
}

/**
 * When the shared start countdown ends (`start_game` sets it 5 seconds after
 * the start; squares can be completed from then on). Null for a lobby, a game
 * started before the countdown existed, or a snapshot without the column.
 */
export function countdownEndsAt(game: Pick<Game, "countdown_ends_at">): string | null {
  const at = game.countdown_ends_at ?? null;
  return at !== null && !Number.isNaN(Date.parse(at)) ? at : null;
}

/**
 * The game is live but still counting down to its start: every phone shows the
 * countdown instead of the board, and the completion RPCs answer
 * `countdown_in_progress`. `now` is the server clock as best known on this
 * phone (`serverNow()` in serverClock.ts); the board appears when it passes.
 */
export function isInCountdown(
  game: Pick<Game, "status" | "deadline_at" | "countdown_ends_at">,
  now: Date = new Date(),
): boolean {
  if (effectiveStatus(game, now) !== "active") return false;
  const at = countdownEndsAt(game);
  return at !== null && Date.parse(at) > now.getTime();
}

/** Whole seconds left on the start countdown (5, 4, 3, 2, 1), 0 once it has run out. */
export function countdownSecondsLeft(game: Pick<Game, "countdown_ends_at">, nowMs: number): number {
  const at = countdownEndsAt(game);
  if (at === null) return 0;
  return Math.max(0, Math.ceil((Date.parse(at) - nowMs) / 1000));
}
