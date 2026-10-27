import { normalizeJoinCode } from "@/lib/game/links";
import { MAX_PLAYERS, type GamePreview } from "@/lib/game/types";

/** Join codes are always 8 characters (CLAUDE.md > Input rules). */
export const JOIN_CODE_LENGTH = 8;

/**
 * What someone typed or pasted on Home → the code the DB would use: upper-cased, spaces and
 * dashes dropped (`normalizeJoinCode`), so `abcd-efgh` and `abcd efgh` both work. A pasted
 * invite link (`…/g/ABCD-2345`) yields its code.
 */
export function codeFromInput(raw: string): string {
  const link = /\/g\/([^/?#\s]+)/.exec(raw);
  return normalizeJoinCode(link ? link[1] : raw);
}

export type HomeJoinOutcome = "go" | "game_not_found" | "game_full" | "game_ended";

/**
 * Whether Home may send this code on to `/g/<code>`, or which inline message to show instead.
 * Only predicts what `join_game` would answer, to save a dead-end screen; the join screen and
 * the RPC still decide. A member always goes on (the join screen takes them straight in, even
 * to a full or ended game of theirs).
 */
export function homeJoinOutcome(code: string, preview: GamePreview | null, isMember: boolean): HomeJoinOutcome {
  if (code.length !== JOIN_CODE_LENGTH || preview === null) return "game_not_found";
  if (isMember) return "go";
  if (preview.status === "ended") return "game_ended";
  if (preview.player_count >= MAX_PLAYERS) return "game_full";
  return "go";
}
