"use client";

import { PencilButton } from "@/components/ui/PencilButton";

/**
 * Bottom-anchored actions within thumb reach: my Ready toggle and, for the
 * host, Start game (enabled only when every player is ready).
 */
export function LobbyDock({
  ready,
  readyBusy,
  onToggleReady,
  isHost,
  hostName,
  allReady,
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
  readyCount: number;
  playerCount: number;
  startBusy: boolean;
  onStart: () => void;
  error: string | null;
}) {
  const status = isHost
    ? allReady
      ? "Everyone's ready. Start when you are."
      : `${readyCount} of ${playerCount} ready. Start unlocks when everyone is.`
    : `Waiting for ${hostName || "the host"} to start`;

  return (
    <div className="lobby-dock fixed inset-x-0 bottom-0 z-30 pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[calc(var(--margin-x)+12px)] pr-4 pt-2">
      <div className="mx-auto flex w-full max-w-xl min-w-0 flex-col gap-1.5">
        <p className="truncate text-lg leading-7 text-ink-soft" data-testid="lobby-status" aria-live="polite">
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
            className="min-h-14 min-w-0 flex-1 px-3 text-2xl"
          >
            {ready ? "Not ready" : "I'm ready"}
          </PencilButton>
          {isHost ? (
            <PencilButton
              onClick={onStart}
              disabled={!allReady}
              busy={startBusy}
              data-testid="start-game"
              className="min-h-14 min-w-0 flex-1 px-3 text-2xl"
            >
              Start game
            </PencilButton>
          ) : null}
        </div>
      </div>
    </div>
  );
}
