"use client";

import { RefreshCw } from "lucide-react";
import { NotFound } from "@/components/join/JoinScreen";
import { PlayerSwatch } from "@/components/game/PlayerSwatch";
import { PaperTitle } from "@/components/paper/PaperPage";
import { PencilButton } from "@/components/ui/PencilButton";
import { SkeletonLines } from "@/components/ui/Skeleton";
import { formatJoinCode, inviteUrl } from "@/lib/game/links";
import { STATUS_LABEL, shortDate } from "@/lib/game/status";
import { useGame } from "@/lib/game/useGame";
import { CENTER_POSITION, MAX_PLAYERS, effectiveStatus, type Game, type Player, type Square } from "@/lib/game/types";

/**
 * /game/[id] placeholder (Phase 2). Phases 3/4 replace the lobby and live
 * board; the data loading lives in useGame. Render inside <SessionGate>.
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

  const { game, players, squares, me, refresh } = result;
  const status = effectiveStatus(game);

  return (
    <div className="flex min-w-0 flex-col" data-testid="game-screen" data-status={status}>
      <p className="text-lg leading-7 text-ink-soft">{STATUS_LABEL[status]}</p>
      <PaperTitle>{game.name}</PaperTitle>

      {status === "lobby" ? (
        <Lobby game={game} players={players} squares={squares} me={me} onRefresh={refresh} />
      ) : status === "active" ? (
        <p className="text-xl leading-7">The game is live. The board is on its way.</p>
      ) : (
        <p className="text-xl leading-7">This game has ended. Album until {shortDate(game.expires_at)}.</p>
      )}
    </div>
  );
}

function Lobby({
  game,
  players,
  squares,
  me,
  onRefresh,
}: {
  game: Game;
  players: Player[];
  squares: Square[];
  me: Player | null;
  onRefresh: () => Promise<void>;
}) {
  const byPosition = new Map(squares.map((s) => [s.position, s]));
  return (
    <>
      <section className="mt-[14px] flex min-w-0 flex-col" aria-label="Invite">
        <p className="text-lg leading-7 text-ink-soft">Invite code</p>
        <p className="text-3xl leading-[42px] tracking-[0.18em]">
          <span data-testid="invite-code" data-code={game.join_code} className="sr-only">
            {game.join_code}
          </span>
          <span aria-hidden>{formatJoinCode(game.join_code)}</span>
        </p>
        <p className="truncate text-base leading-7 text-ink-soft" data-testid="invite-url">
          {inviteUrl(game.join_code)}
        </p>
      </section>

      <section className="mt-[28px] flex min-w-0 flex-col" aria-labelledby="players-heading">
        <div className="flex items-center justify-between gap-2">
          <h2 id="players-heading" className="text-2xl leading-7">
            Players <span className="text-ink-soft">{players.length}/{MAX_PLAYERS}</span>
          </h2>
          <PencilButton variant="quiet" onClick={() => void onRefresh()} aria-label="Refresh players" data-testid="refresh">
            <RefreshCw aria-hidden className="size-4" strokeWidth={2.25} />
            Refresh
          </PencilButton>
        </div>
        <ul className="mt-[7px] flex flex-col" data-testid="players">
          {players.map((p) => (
            <li key={p.id} data-testid="player" data-color={p.color} className="flex min-h-11 items-center gap-3">
              <PlayerSwatch color={p.color} />
              <span className="min-w-0 flex-1 truncate text-xl">
                {p.display_name}
                {p.id === me?.id ? <span className="text-ink-soft"> (you)</span> : null}
              </span>
              {p.user_id === game.host_user_id ? <span className="text-base text-ink-soft">host</span> : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-[28px] min-w-0" aria-label="Board">
        <ol className="grid w-full grid-cols-5 border-l-2 border-t-2 border-ink" data-testid="board">
          {Array.from({ length: 25 }, (_, position) => {
            const square = byPosition.get(position);
            const isFree = position === CENTER_POSITION && game.free_center;
            const label = isFree && !square?.label ? "FREE" : (square?.label ?? "");
            return (
              <li
                key={position}
                className="flex aspect-square min-w-0 items-center justify-center overflow-hidden border-b-2 border-r-2 border-ink p-0.5 text-center text-[11px] leading-[13px] break-words hyphens-auto"
              >
                {label}
              </li>
            );
          })}
        </ol>
      </section>
    </>
  );
}
