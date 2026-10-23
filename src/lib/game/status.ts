import type { GameStatus } from "@/lib/game/types";

export const STATUS_LABEL: Record<GameStatus, string> = {
  lobby: "Lobby",
  active: "Live",
  ended: "Ended",
};

/** "Nov 22" style short date in the viewer's locale. */
export function shortDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(iso));
}
