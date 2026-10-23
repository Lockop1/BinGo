"use client";

import type { ReactNode } from "react";
import { BoardScreen } from "@/components/board/BoardScreen";
import { NotFound } from "@/components/join/JoinScreen";
import { Lobby } from "@/components/lobby/Lobby";
import { PaperPage, PaperTitle } from "@/components/paper/PaperPage";
import { SessionGate } from "@/components/providers/SessionGate";
import { useSession } from "@/components/providers/SessionProvider";
import { PencilButton } from "@/components/ui/PencilButton";
import { SkeletonLines } from "@/components/ui/Skeleton";
import { STATUS_LABEL, shortDate } from "@/lib/game/status";
import { useGame } from "@/lib/game/useGame";
import { effectiveStatus } from "@/lib/game/types";

/**
 * /game/[id]: the paper lobby, then the live board, then the ended state.
 * Data and live sync live in useGame; the screen follows the game's
 * effective status, so a start or end seen via Realtime, a resync or the
 * host's own RPC result all switch screens.
 *
 * The lobby, loading and ended states sit on paper; the live board owns the
 * whole viewport (its own background and safe-area padding), so this
 * component decides the frame rather than the route.
 */
export function GameScreen({ gameId }: { gameId: string }) {
  const session = useSession();
  if (session.status !== "ready") {
    return (
      <PaperPage>
        <SessionGate>{null}</SessionGate>
      </PaperPage>
    );
  }
  return <GameView gameId={gameId} />;
}

function Paper({ children }: { children: ReactNode }) {
  return <PaperPage>{children}</PaperPage>;
}

function GameView({ gameId }: { gameId: string }) {
  const result = useGame(gameId);

  if (result.status === "loading") {
    return (
      <Paper>
        <SkeletonLines lines={4} label="Loading game" />
      </Paper>
    );
  }
  if (result.status === "not_found") {
    return (
      <Paper>
        <NotFound />
      </Paper>
    );
  }
  if (result.status === "error") {
    return (
      <Paper>
        <div role="alert" className="flex flex-col items-start gap-3">
          <p className="text-xl leading-7">{result.error.message}</p>
          <PencilButton variant="secondary" onClick={() => void result.refresh()}>
            Try again
          </PencilButton>
        </div>
      </Paper>
    );
  }

  const { game } = result;
  const status = effectiveStatus(game);

  if (status === "active") {
    return (
      <BoardScreen
        game={game}
        players={result.players}
        squares={result.squares}
        me={result.me}
        syncState={result.syncState}
        refresh={result.refresh}
        applyGame={result.applyGame}
        applySquare={result.applySquare}
      />
    );
  }

  return (
    <Paper>
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
            <p className="text-xl leading-7" data-testid="ended-placeholder">
              This game has ended. Album until {shortDate(game.expires_at)}.
            </p>
          </>
        )}
      </div>
    </Paper>
  );
}
