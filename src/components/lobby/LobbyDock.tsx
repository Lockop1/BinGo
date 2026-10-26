"use client";

import { PencilButton } from "@/components/ui/PencilButton";

/** One line at every width: a step smaller below 360 px, where two 24 px labels would wrap. */
const DOCK_BUTTON = "px-2! text-xl min-[360px]:px-3! min-[360px]:text-2xl";

/**
 * Bottom-anchored actions within thumb reach: my Ready toggle and, for the
 * host, Start game (enabled only when every player is ready and the deadline
 * is still ahead; `start_game` refuses a passed one with `deadline_passed`).
 */
export function LobbyDock({
  ready,
  readyBusy,
  onToggleReady,
  isHost,
  hostName,
  allReady,
  deadlinePassed = false,
  deadlinePending = false,
  readyCount,
  playerCount,
  startBusy,
  onStart,
  error,
}: {
  ready: boolean;
  readyBusy: boolean;
  onToggleReady: () => void;
  isHost: boolean;
  hostName: string;
  allReady: boolean;
  /** The deadline has gone by: the host must pick a new one before starting. */
  deadlinePassed?: boolean;
  /** The host's new deadline has not been confirmed yet. */
  deadlinePending?: boolean;
  readyCount: number;
  playerCount: number;
  startBusy: boolean;
  onStart: () => void;
  error: string | null;
}) {
  const host = hostName || "the host";
  let status: string;
  if (deadlinePassed) status = isHost ? "Pick a new deadline first" : `Waiting for ${host} to set a new deadline`;
  else if (!isHost) status = `Waiting for ${host} to start`;
  else if (allReady) status = "Everyone's ready. Start when you are.";
  else status = `${readyCount} of ${playerCount} ready. Start unlocks when everyone is.`;

  return (
    <div className="lobby-dock fixed inset-x-0 bottom-0 z-30 pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[calc(var(--margin-x)+12px)] pr-4 pt-2">
      <div className="mx-auto flex w-full max-w-xl min-w-0 flex-col gap-1.5">
        {/* Wraps instead of cutting off on a 320 px phone (the lobby keeps room for two lines). */}
        <p className="text-pretty text-lg leading-6 text-ink-soft" data-testid="lobby-status" aria-live="polite">
          {status}
        </p>
        {error ? (
          <p role="alert" className="text-lg leading-6 text-danger" data-testid="lobby-error">
            {error}
          </p>
        ) : null}
        <div className="flex min-w-0 gap-2">
          <PencilButton
            variant={ready ? "secondary" : "primary"}
            onClick={onToggleReady}
            aria-busy={readyBusy || undefined}
            data-testid="ready-toggle"
            data-ready={ready}
            className={`min-h-14 min-w-0 flex-1 whitespace-nowrap ${DOCK_BUTTON}`}
          >
            {ready ? "Not ready" : "I'm ready"}
          </PencilButton>
          {isHost ? (
            <PencilButton
              onClick={onStart}
              disabled={!allReady || deadlinePassed || deadlinePending}
              busy={startBusy}
              data-testid="start-game"
              className={`min-h-14 min-w-0 flex-1 whitespace-nowrap ${DOCK_BUTTON}`}
            >
              Start game
            </PencilButton>
          ) : null}
        </div>
      </div>
    </div>
  );
}
