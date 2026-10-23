"use client";

import { Check, MessageCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PencilButton } from "@/components/ui/PencilButton";
import { inviteUrl } from "@/lib/game/links";
import type { Game, Player, Square } from "@/lib/game/types";
import { shareOrCopy } from "@/lib/share";

type ShareGame = Pick<Game, "name" | "join_code">;
type ShareSquare = Pick<Square, "label" | "position" | "completed_by_player_id">;

/** Square text for messages; the free center can be blank. */
function squareText(square: ShareSquare): string {
  const label = square.label.trim();
  if (label) return label;
  return square.position === 12 ? "the free space" : "a square";
}

/** "Jake just completed Skyline Chili", or a nudge for an open square. */
export function shareMessage(square: ShareSquare, players: readonly Pick<Player, "id" | "display_name">[]): string {
  const completer = square.completed_by_player_id
    ? players.find((p) => p.id === square.completed_by_player_id)
    : undefined;
  return completer ? `${completer.display_name} just completed ${squareText(square)}` : `Who's up for ${squareText(square)}?`;
}

type Feedback = "copied" | "failed" | null;

/** "Share to group chat": the phone's share sheet with the invite link, or copy it. */
export function ShareButton({ game, square, players }: { game: ShareGame; square: ShareSquare; players: readonly Player[] }) {
  const [feedback, setFeedback] = useState<Feedback>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const share = async () => {
    const outcome = await shareOrCopy({ title: game.name, text: shareMessage(square, players), url: inviteUrl(game.join_code) });
    if (outcome === "shared" || outcome === "dismissed") return;
    setFeedback(outcome === "copied" ? "copied" : "failed");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setFeedback(null), 2500);
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <PencilButton variant="secondary" onClick={() => void share()} data-testid="share-group">
        <MessageCircle aria-hidden className="size-5" strokeWidth={2.25} />
        Share to group chat
      </PencilButton>
      <span aria-live="polite" data-testid="share-feedback" className="inline-flex min-h-7 items-center gap-1 text-lg">
        {feedback === "copied" ? (
          <>
            <Check aria-hidden className="size-4" strokeWidth={3} />
            Copied
          </>
        ) : feedback === "failed" ? (
          <span className="text-danger">Couldn&apos;t share. Try again.</span>
        ) : null}
      </span>
    </div>
  );
}
