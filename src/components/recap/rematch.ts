import type { Game, GameStatus } from "@/lib/game/types";

/**
 * Pure decisions behind the recap's rematch link (PlayAgainLink.tsx), kept
 * apart so they are unit-tested. Game rules stay in SQL (`play_again`,
 * `join_game`); this only decides what to show and what to count.
 */

/** What this phone knows about the rematch the old game points at. */
export type NextGameInfo = {
  id: string;
  /** This phone can select the rematch's row (RLS): it is a player of it. */
  readable: boolean;
  /** The rematch's host, when readable. */
  hostUserId: string | null;
  /**
   * The rematch's effective status: from its row when readable, else from
   * `peek_game_public(next_join_code)` (`ended` also when that says not found,
   * i.e. the rematch expired). Null when the lookup failed (offline).
   */
  status: GameStatus | null;
};

/**
 * - `play`: no rematch yet, "Play again" starts one;
 * - `join`: a rematch is open and this phone is not in it, one tap joins;
 * - `go`: this phone is in the open rematch;
 * - `none`: nothing to show (the rematch has ended, or is still being looked up).
 */
export type RematchKind = "play" | "join" | "go" | "none";

export function rematchKind(
  pointer: { nextGameId: string | null; nextCode: string | null },
  info: NextGameInfo | null,
): RematchKind {
  if (!pointer.nextGameId || !pointer.nextCode) return "play";
  // Still looking: show nothing rather than a Join that may vanish a moment later.
  if (info === null || info.id !== pointer.nextGameId) return "none";
  // `play_again` keeps returning the ended rematch, so there is no fresh one to offer.
  if (info.status === "ended") return "none";
  if (info.readable) return "go";
  // Not a player of it (or the lookup failed): join; `join_game` has the final word.
  return "join";
}

/**
 * Whether this `play_again` call created the rematch (so `play_again` is
 * counted): the returned game is hosted by this phone and the old game did not
 * point at a rematch before the tap. Losing the race (someone else's rematch
 * came back) or getting this phone's own earlier rematch back is not a new one.
 */
export function createdRematch(args: {
  knownNextGameId: string | null;
  returned: Pick<Game, "id" | "host_user_id">;
  myUserId: string;
}): boolean {
  return args.knownNextGameId === null && args.returned.host_user_id === args.myUserId;
}

/** `player_joined.late_join` for a rematch joined from the recap. */
export function lateJoin(status: GameStatus | null): boolean {
  return status === "active";
}
