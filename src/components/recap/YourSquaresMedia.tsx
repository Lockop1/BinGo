"use client";

import { useEffect, useId, useState } from "react";
import { AddMediaButton } from "@/components/media/AddMediaButton";
import { useSession } from "@/components/providers/SessionProvider";
import { squareTitle } from "@/components/recap/recapItems";
import { mediaGate, ownCompletedSquares } from "@/lib/game/postGameMedia";
import type { Game, Player, Square } from "@/lib/game/types";

type Props = {
  game: Pick<Game, "id" | "status" | "deadline_at" | "ended_at" | "expires_at">;
  players: readonly Player[];
  squares: readonly Square[];
  /** The heading level under the recap's own heading. */
  headingLevel?: "h2" | "h3";
};

/**
 * The recap's "Your squares": every square this phone's player crossed off,
 * each with "Add photo/video", so the night's shots can still go into the
 * album after the game ends (until it expires). Uploads go through the app's
 * background queue; the game screen folds each finished one into the album
 * (useUploadedMedia). Only your own squares: after the end, `register_media`
 * takes anyone's square only for the first 10 minutes (uploads in flight at
 * the end), so offering it here would mostly fail. Nothing shows until the
 * session says who is looking, or for a viewer who crossed nothing off.
 */
export function YourSquaresMedia({ game, players, squares, headingLevel: Heading = "h3" }: Props) {
  const headingId = useId();
  const { userId } = useSession();
  // The clock is read after mount (never during a prerender).
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const id = window.setTimeout(() => setNow(Date.now()), 0);
    return () => window.clearTimeout(id);
  }, []);

  const me = userId ? (players.find((p) => p.user_id === userId) ?? null) : null;
  if (!me || now === null) return null;
  const at = new Date(now);
  const own = ownCompletedSquares(squares, me.id).filter((s) => mediaGate(game, s, me.id, at) === "ok");
  if (own.length === 0) return null;

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2" data-testid="recap-your-squares">
      <div className="min-w-0">
        <Heading id={headingId} className="text-2xl leading-8">
          Your squares
        </Heading>
        <p className="text-lg leading-7 text-ink-soft">Add a photo or video to anything you crossed off.</p>
      </div>
      <ul className="flex min-w-0 flex-col gap-3">
        {own.map((s) => (
          <li key={s.id} className="flex min-w-0 flex-col gap-1" data-testid="your-square" data-position={s.position}>
            <span className="text-xl leading-7 break-words">{squareTitle(s)}</span>
            <AddMediaButton gameId={game.id} position={s.position} playerId={me.id} />
          </li>
        ))}
      </ul>
    </section>
  );
}
