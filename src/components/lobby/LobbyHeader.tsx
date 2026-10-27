"use client";

import { useRouter } from "next/navigation";
import { Flag, LogOut } from "lucide-react";
import { useState, type ReactNode } from "react";
import { SyncDot } from "@/components/lobby/SyncDot";
import { PencilButton } from "@/components/ui/PencilButton";
import { leaveToHome } from "@/lib/game/activeGame";
import { errorCopy, toGameError } from "@/lib/game/errors";
import { endGame, leaveGame } from "@/lib/game/rpc";
import type { Game } from "@/lib/game/types";
import type { SyncState } from "@/lib/game/useGame";

const HEADER_ACTION =
  "-mr-2 inline-flex min-h-11 items-center gap-1.5 px-2 text-lg text-ink-soft underline decoration-ink-faint " +
  "decoration-2 underline-offset-4 disabled:opacity-45";

/**
 * Lobby title row. A player's Leave really leaves (`leave_game` frees their
 * slot and color, so Start is never blocked by someone who went home), then
 * forgets the game on this phone and goes home. The host cannot leave (no host
 * transfer); they get End game instead, behind a confirm step (`end_game`
 * works from the lobby too).
 *
 * The game name is the page title: big, heavier pencil type with a
 * hand-drawn underline; the deadline and the lobby hint sit under it as
 * smaller lines, and a faint pencil rule closes the header off from the rest.
 */
export function LobbyHeader({
  gameId,
  name,
  isHost,
  syncState,
  onResync,
  applyGame,
  deadline = null,
}: {
  gameId: string;
  name: string;
  isHost: boolean;
  syncState: SyncState;
  onResync: () => void;
  applyGame: (row: Game) => void;
  /** The deadline line, shown right under the game name. */
  deadline?: ReactNode;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const leave = async () => {
    setBusy(true);
    setError(null);
    try {
      await leaveGame(gameId);
    } catch (cause) {
      // Already not a player (e.g. the host removed us): leaving is done anyway.
      if (toGameError(cause).code !== "game_not_found") {
        setError(errorCopy(cause));
        setBusy(false);
        onResync();
        return;
      }
    }
    // Forget the game here and stay home (a scheduled save cannot bring it back).
    // Reset before leaving: Next keeps this screen mounted (hidden) for Back.
    leaveToHome(gameId);
    setBusy(false);
    router.replace("/");
  };

  const end = async () => {
    setBusy(true);
    setError(null);
    try {
      // Status becomes ended: GameScreen shows the recap.
      applyGame(await endGame({ game_id: gameId }));
    } catch (cause) {
      setError(errorCopy(cause));
      setBusy(false);
      onResync();
    }
  };

  return (
    <header className="lobby-header flex min-w-0 flex-col">
      <div className="flex min-h-11 items-center justify-between gap-2">
        <SyncDot state={syncState} onResync={onResync} />
        {isHost ? (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
            disabled={confirming}
            data-testid="lobby-end-game"
            className={HEADER_ACTION}
          >
            <Flag aria-hidden className="size-4" strokeWidth={2.25} />
            End game
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void leave()}
            disabled={busy}
            aria-busy={busy || undefined}
            data-testid="leave-lobby"
            className={HEADER_ACTION}
          >
            <LogOut aria-hidden className="size-4" strokeWidth={2.25} />
            Leave
          </button>
        )}
      </div>
      {isHost && confirming ? (
        <div
          className="mt-1 flex min-w-0 flex-col gap-2 border-y-2 border-dashed border-ink-faint py-[14px]"
          data-testid="lobby-end-game-panel"
        >
          <p className="text-xl leading-7">End the game for everyone?</p>
          <p className="text-lg leading-7 text-ink-soft" data-testid="host-leave-hint">
            The host can&apos;t leave the lobby, so ending it closes the game.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <PencilButton onClick={() => void end()} busy={busy} data-testid="lobby-end-game-confirm">
              End game
            </PencilButton>
            <PencilButton
              variant="quiet"
              onClick={() => setConfirming(false)}
              disabled={busy}
              data-testid="lobby-end-game-cancel"
            >
              Keep the lobby
            </PencilButton>
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-lg leading-7 text-danger" data-testid="lobby-header-error">
          {error}
        </p>
      ) : null}
      <h1 className="lobby-title relative mt-[7px] w-fit max-w-full pb-[7px]" data-testid="lobby-title">
        {name}
        <PencilUnderline />
      </h1>
      <div className="mt-[7px] flex min-w-0 flex-col">
        {deadline}
      </div>
      <PencilRule />
    </header>
  );
}

/** A quick double pencil stroke under the title, drawn in once (instant with reduced motion). */
function PencilUnderline() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 300 14"
      preserveAspectRatio="none"
      className="lobby-title-underline pointer-events-none absolute bottom-0 left-0 h-[14px] w-full overflow-visible"
    >
      <path
        d="M2 7.6C48 5.4 96 9.6 150 7.2S246 5 298 7.4"
        pathLength={1}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.6}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d="M12 10.6C80 8.8 150 11.4 214 9.8S270 9.2 290 10"
        pathLength={1}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        opacity={0.55}
      />
    </svg>
  );
}

/** A faint, slightly wavy ruled line that separates the header from the lobby below. */
function PencilRule() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 300 14"
      preserveAspectRatio="none"
      className="pointer-events-none mt-[7px] block h-[14px] w-full text-ink-faint"
      data-testid="lobby-header-rule"
    >
      <path
        d="M1 7.4C70 6.2 140 8.4 200 7S270 6.4 299 7.6"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
