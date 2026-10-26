import type { Database, Tables } from "@/types/database";

type GameRow = Tables<"games">;
type OptionalColumns = "next_game_id" | "next_join_code" | "deadline_extended_at";
/**
 * A `games` row. The rematch columns (set by `play_again`) and
 * `deadline_extended_at` (set by `extend_deadline`) are optional on the client:
 * game snapshots cached in `bingo.activeGame` by builds from before they
 * existed are restored as they were saved. Read them with `?? null`.
 * `deadline_at` is always present (`activeGame.ts` fills it in for such older
 * snapshots).
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
