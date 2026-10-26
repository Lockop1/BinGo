/**
 * Stable error codes raised by the RPCs (`error.code === "P0001"`,
 * `error.message` = code). See CLAUDE.md > Database API > Error codes.
 * Anything else (network failures, 42501, unexpected messages) is `unknown`.
 */
export const GAME_ERROR_CODES = [
  "not_authenticated",
  "game_not_found",
  "game_ended",
  "game_full",
  "game_not_in_lobby",
  "game_not_active",
  "game_not_ended",
  "game_not_started",
  "game_expired",
  "not_host",
  "not_allowed",
  "host_cannot_leave",
  "player_not_found",
  "players_not_ready",
  "deadline_passed",
  "already_extended",
  "invalid_deadline",
  "invalid_name",
  "invalid_display_name",
  "invalid_squares",
  "invalid_position",
  "label_too_long",
  "details_too_long",
  "invalid_target_count",
  "is_counter",
  "not_counter",
  "square_not_completed",
  "invalid_storage_path",
  "invalid_kind",
  "invalid_argument",
  "join_code_generation_failed",
] as const;

export type GameErrorCode = (typeof GAME_ERROR_CODES)[number] | "unknown";

const GENERIC = "Something went wrong. Check your connection and try again.";

/** User-facing copy per code. Client-bug codes get the generic line. */
export const GAME_ERROR_COPY: Record<GameErrorCode, string> = {
  not_authenticated: "Still connecting. Try again in a moment.",
  game_not_found: "We couldn't find that game.",
  game_ended: "This game has already ended.",
  game_full: "This game is full (10 players).",
  game_not_in_lobby: "The game has already started.",
  game_not_active: "The game isn't live.",
  game_not_ended: "The game isn't over yet.",
  game_not_started: "Media can be added once the game starts.",
  game_expired: "This album has expired.",
  not_host: "Only the host can do that.",
  not_allowed: "Only the person who completed it or the host can undo this.",
  host_cannot_leave: "The host can't leave. End the game instead.",
  player_not_found: "That player has already left.",
  players_not_ready: "Everyone needs to tap Ready first.",
  deadline_passed: "The deadline has passed. Pick a new one before starting.",
  already_extended: "The deadline can only be extended once.",
  invalid_deadline: "Pick a time between 10 minutes and 7 days from now.",
  invalid_name: "Game name must be 1–60 characters.",
  invalid_display_name: "Name must be 1–24 characters.",
  invalid_squares: GENERIC,
  invalid_position: GENERIC,
  label_too_long: "Square text is limited to 40 characters.",
  details_too_long: "Details are limited to 200 characters.",
  invalid_target_count: "Counter target must be 1–99.",
  is_counter: GENERIC,
  not_counter: GENERIC,
  square_not_completed: "Media can only be attached to completed squares.",
  invalid_storage_path: GENERIC,
  invalid_kind: GENERIC,
  invalid_argument: GENERIC,
  join_code_generation_failed: "Couldn't create the game. Please try again.",
  unknown: GENERIC,
};

const KNOWN = new Set<string>(GAME_ERROR_CODES);

export class GameError extends Error {
  readonly code: GameErrorCode;
  override readonly cause: unknown;

  constructor(code: GameErrorCode, cause?: unknown) {
    super(GAME_ERROR_COPY[code]);
    this.name = "GameError";
    this.code = code;
    this.cause = cause;
  }
}

type ErrorLike = { code?: unknown; message?: unknown };

/** Maps a PostgREST / supabase-js error (or anything thrown) to a GameError. */
export function toGameError(error: unknown): GameError {
  if (error instanceof GameError) return error;
  if (error && typeof error === "object") {
    const { code, message } = error as ErrorLike;
    if (code === "P0001" && typeof message === "string" && KNOWN.has(message)) {
      return new GameError(message as GameErrorCode, error);
    }
  }
  return new GameError("unknown", error);
}

/** Copy for any thrown value, for inline error lines. */
export function errorCopy(error: unknown): string {
  return toGameError(error).message;
}
