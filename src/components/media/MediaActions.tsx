"use client";

import { useEffect, useState } from "react";
import { AddMediaButton } from "@/components/media/AddMediaButton";
import { ShareButton } from "@/components/media/ShareButton";
import { GAME_ERROR_COPY } from "@/lib/game/errors";
import { mediaGate, type MediaGate } from "@/lib/game/postGameMedia";
import type { Game, Player, Square } from "@/lib/game/types";
import type { prepareMedia } from "@/lib/media/prepare";
import type { UploadQueue } from "@/lib/media/uploadQueue";

type Props = {
  game: Pick<Game, "id" | "name" | "join_code" | "status" | "deadline_at" | "ended_at" | "expires_at">;
  square: Pick<Square, "position" | "label" | "completed_at" | "completed_by_player_id">;
  me: Pick<Player, "id"> | null;
  players: readonly Player[];
  /**
   * The square's completion is still only optimistic on this phone (offline,
   * or the RPC is in flight). `register_media` needs it on the server, so Add
   * waits until it lands instead of uploading into a definitive refusal.
   */
  pending?: boolean;
  queue?: UploadQueue;
  prepare?: typeof prepareMedia;
};

/** Why "Add photo/video" is not offered, by gate (`ok` and the stored-status fallback have none). */
const GATE_HINT: Record<Exclude<MediaGate, "ok">, string> = {
  lobby: GAME_ERROR_COPY.game_not_started,
  expired: GAME_ERROR_COPY.game_expired,
  not_done: "Complete it to add a photo or video.",
  not_yours: "Now the game is over, only whoever crossed it off can add photos or videos.",
};

/**
 * The square sheet's media row: "Add photo/video" (once the square is done,
 * while the game is live, or after the end for the player who crossed it off
 * (anyone during the 10 minutes right after the end), until the album
 * expires; see postGameMedia.ts) and "Share to group chat". `register_media`
 * re-checks all of this; hiding is only a courtesy.
 */
export function MediaActions({ game, square, me, players, pending = false, queue, prepare }: Props) {
  // The clock is read after mount (never during a prerender); until then the
  // stored status stands in. The RPC re-checks expiry and status regardless.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const id = window.setTimeout(() => setNow(Date.now()), 0);
    return () => window.clearTimeout(id);
  }, []);
  const gate: MediaGate =
    now !== null
      ? mediaGate(game, square, me?.id ?? null, new Date(now))
      : game.status === "lobby"
        ? "lobby"
        : square.completed_at === null
          ? "not_done"
          : "ok";

  let hint: string | null = null;
  if (gate !== "ok") hint = GATE_HINT[gate];
  else if (pending) hint = "You can add a photo or video once this is saved.";

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="media-actions">
      {me && !hint ? (
        <AddMediaButton gameId={game.id} position={square.position} playerId={me.id} queue={queue} prepare={prepare} />
      ) : hint ? (
        <p className="text-lg leading-7 text-ink-soft" data-testid="media-hint">
          {hint}
        </p>
      ) : null}
      <ShareButton game={game} square={square} players={players} />
    </div>
  );
}
