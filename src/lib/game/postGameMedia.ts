import { effectiveStatus, type Game, type Square } from "@/lib/game/types";

/**
 * Who may still add a photo/video to a square once the game is over, as the
 * phone predicts it (to show or hide "Add photo/video"). `register_media`
 * enforces the real rule (CLAUDE.md > Database API); hiding is a courtesy.
 *
 * - Live game: any player, any completed square.
 * - After the end (ended, or live past its deadline), until the album
 *   expires: the squares this player crossed off, and anyone's completed
 *   square for `POST_GAME_MEDIA_GRACE_MS` after the end (uploads that were in
 *   flight when a blackout or the host ended it).
 */

/** The server's grace after the end for media on someone else's square (10 minutes). */
export const POST_GAME_MEDIA_GRACE_MS = 10 * 60_000;

type GameTimes = Pick<Game, "status" | "deadline_at" | "ended_at" | "expires_at">;

/** When the game ended, as the RPCs see it: `ended_at`, or the deadline of a live game past it. Null while live. */
export function gameEndedAt(game: GameTimes, now: Date = new Date()): string | null {
  if (effectiveStatus(game, now) !== "ended") return null;
  return game.ended_at ?? game.deadline_at;
}

export type MediaGate = "ok" | "lobby" | "expired" | "not_done" | "not_yours";

/** Whether `meId` may add media to `square` now (see the header), or why not. */
export function mediaGate(
  game: GameTimes,
  square: Pick<Square, "completed_at" | "completed_by_player_id">,
  meId: string | null,
  now: Date = new Date(),
): MediaGate {
  const status = effectiveStatus(game, now);
  if (status === "lobby") return "lobby";
  if (Date.parse(game.expires_at) <= now.getTime()) return "expired";
  if (square.completed_at === null) return "not_done";
  const endedAt = gameEndedAt(game, now);
  if (endedAt === null) return "ok";
  if (meId !== null && square.completed_by_player_id === meId) return "ok";
  return now.getTime() <= Date.parse(endedAt) + POST_GAME_MEDIA_GRACE_MS ? "ok" : "not_yours";
}

/** The squares `meId` crossed off, in board order (the recap's "Your squares"). */
export function ownCompletedSquares<S extends Pick<Square, "position" | "completed_at" | "completed_by_player_id">>(
  squares: readonly S[],
  meId: string | null,
): S[] {
  if (meId === null) return [];
  return squares
    .filter((s) => s.completed_at !== null && s.completed_by_player_id === meId)
    .sort((a, b) => a.position - b.position);
}
