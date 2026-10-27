import { timestampMicros } from "@/lib/game/realtime";
import { endReason, type Game, type Square } from "@/lib/game/types";

/**
 * Who finished the board of a game that ended in a blackout: the server ends
 * it in the same transaction as the 25th completion, so that square's
 * `completed_at` is exactly the game's `ended_at` (both `now()` of one
 * transaction). Returns that square's completer (a `players.id`), or null for
 * any other end, an unknown finisher, or rows that do not line up (yet).
 */
export function blackoutFinisher(
  game: Pick<Game, "end_reason" | "ended_at">,
  squares: readonly Pick<Square, "completed_at" | "completed_by_player_id">[],
): string | null {
  if (endReason(game) !== "blackout" || !game.ended_at) return null;
  const ended = timestampMicros(game.ended_at);
  if (Number.isNaN(ended)) return null;
  const last = squares.find((s) => s.completed_at !== null && timestampMicros(s.completed_at) === ended);
  return last?.completed_by_player_id ?? null;
}
