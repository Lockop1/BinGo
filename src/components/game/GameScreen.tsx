"use client";

import { NotFound } from "@/components/join/JoinScreen";
import { Lobby } from "@/components/lobby/Lobby";
import { PaperTitle } from "@/components/paper/PaperPage";
import { PencilButton } from "@/components/ui/PencilButton";
import { SkeletonLines } from "@/components/ui/Skeleton";
import { STATUS_LABEL, shortDate } from "@/lib/game/status";
import { useGame } from "@/lib/game/useGame";
import { effectiveStatus } from "@/lib/game/types";

/**
 * /game/[id]: the lobby (Phase 3), then the live board (Phase 4 placeholder
 * for now) and the ended state. Data and live sync live in useGame; the
 * screen follows the game's effective status, so a start seen via Realtime,
 * a resync or the host's own start_game result all leave the lobby.
 * Render inside <SessionGate>.
 */
export function GameScreen({ gameId }: { gameId: string }) {
  const result = useGame(gameId);

  if (result.status === "loading") return <SkeletonLines lines={4} label="Loading game" />;
  if (result.status === "not_found") return <NotFound />;
  if (result.status === "error") {
    return (
      <div role="alert" className="flex flex-col items-start gap-3">
        <p className="text-xl leading-7">{result.error.message}</p>
        <PencilButton variant="secondary" onClick={() => void result.refresh()}>
          Try again
        </PencilButton>
      </div>
    );
  }

  const { game } = result;
  const status = effectiveStatus(game);

  return (
    <div className="flex min-w-0 flex-col" data-testid="game-screen" data-status={status}>
      {status === "lobby" ? (
        <Lobby
          game={game}
          players={result.players}
          squares={result.squares}
          me={result.me}
          syncState={result.syncState}
          refresh={result.refresh}
          applyGame={result.applyGame}
          applyPlayer={result.applyPlayer}
          applySquare={result.applySquare}
        />
      ) : (
        <>
          <p className="text-lg leading-7 text-ink-soft">{STATUS_LABEL[status]}</p>
          <PaperTitle>{game.name}</PaperTitle>
          {status === "active" ? (
            <p className="text-xl leading-7" data-testid="active-placeholder">
              The game is live. The board is on its way.
            </p>
          ) : (
            <p className="text-xl leading-7" data-testid="ended-placeholder">
              This game has ended. Album until {shortDate(game.expires_at)}.
            </p>
          )}
        </>
      )}
    </div>
  );
}
