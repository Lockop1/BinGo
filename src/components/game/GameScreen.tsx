"use client";

import { useState, type ReactNode } from "react";
import { BoardScreen } from "@/components/board/BoardScreen";
import { StartTransition, type StartSquare } from "@/components/game/StartTransition";
import { NotFound } from "@/components/join/JoinScreen";
import { Lobby } from "@/components/lobby/Lobby";
import { useUploadedMedia } from "@/components/media/useUploadedMedia";
import { PaperPage } from "@/components/paper/PaperPage";
import { SessionGate } from "@/components/providers/SessionGate";
import { useSession } from "@/components/providers/SessionProvider";
import { Recap } from "@/components/recap/Recap";
import { PencilButton, PencilLink } from "@/components/ui/PencilButton";
import { SkeletonLines } from "@/components/ui/Skeleton";
import { useGame } from "@/lib/game/useGame";
import { effectiveStatus, type GameStatus } from "@/lib/game/types";
import { useSettings } from "@/lib/settings/useSettings";

/**
 * /game/[id]: the paper lobby, then the live board, then the recap.
 * Data and live sync live in useGame; the screen follows the game's
 * effective status, so a start or end seen via Realtime, a resync or the
 * host's own RPC result all switch screens.
 *
 * The lobby, loading and ended states sit on paper; the live board owns the
 * whole viewport (its own background and safe-area padding), so this
 * component decides the frame rather than the route.
 *
 * A live lobby → active flip (the host's own start, or the start arriving
 * via Realtime / the resync poll on everyone else's phone) plays the start
 * transition over the freshly mounted board. Opening a game that is already
 * active shows the board straight away.
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

/** What the start transition draws: the lobby board as it was when the start landed. */
type StartShow = { key: number; name: string; squares: StartSquare[]; freeCenter: boolean };

function GameView({ gameId }: { gameId: string }) {
  const result = useGame(gameId);
  const { settings, theme } = useSettings();
  useUploadedMedia(gameId, result.applyMedia);

  // Effective status as last rendered on this mount (null until the game has
  // loaded), so only a flip seen live starts the transition. Adjusted during
  // render (not in an effect) so the board never paints a frame before the
  // overlay covers it.
  const liveStatus: GameStatus | null = result.status === "ready" ? effectiveStatus(result.game) : null;
  const [seen, setSeen] = useState<GameStatus | null>(null);
  const [start, setStart] = useState<StartShow | null>(null);
  if (result.status === "ready" && liveStatus !== null && liveStatus !== seen) {
    setSeen(liveStatus);
    if (seen === "lobby" && liveStatus === "active") {
      setStart((previous) => ({
        key: (previous?.key ?? 0) + 1,
        name: result.game.name,
        squares: result.squares.map((s) => ({ position: s.position, label: s.label })),
        freeCenter: result.game.free_center,
      }));
    } else if (liveStatus !== "active") {
      setStart(null);
    }
  }

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
      <>
        <BoardScreen
          game={game}
          players={result.players}
          squares={result.squares}
          media={result.media}
          me={result.me}
          syncState={result.syncState}
          refresh={result.refresh}
          applyGame={result.applyGame}
          applySquare={result.applySquare}
        />
        {start ? (
          <StartTransition
            key={start.key}
            theme={theme}
            textSize={settings.textSize}
            squareSize={settings.squareSize}
            name={start.name}
            squares={start.squares}
            freeCenter={start.freeCenter}
            onDone={() => setStart(null)}
          />
        ) : null}
      </>
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
          // Ended: the paper recap (its story viewer brings its own dark backdrop).
          <div className="flex min-w-0 flex-col gap-7" data-testid="game-ended">
            <Recap game={game} players={result.players} squares={result.squares} media={result.media} headingLevel="h1" />
            <PencilLink href="/" variant="secondary" className="w-full" data-testid="back-home">
              Back to home
            </PencilLink>
          </div>
        )}
      </div>
    </Paper>
  );
}
