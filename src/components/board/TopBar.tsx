"use client";

import { Images, Settings } from "lucide-react";
import type { Player } from "@/lib/game/types";
import type { SyncState } from "@/lib/game/useGame";
import { playerColor, type PaletteTheme } from "@/lib/palette";

const ICON_BUTTON =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-[10px] text-board-ink " +
  "focus-visible:outline-[3px] focus-visible:-outline-offset-[3px] focus-visible:outline-board-ink active:bg-board-surface";

/**
 * The only thing above the grid: game name, a quiet sync mark (only when not
 * live or when taps are waiting), players, settings, album (with a small
 * count once there is media).
 */
export function TopBar({
  name,
  players,
  theme,
  syncState,
  pendingCount,
  mediaCount,
  onPlayers,
  onSettings,
  onAlbum,
  onRetry,
}: {
  name: string;
  players: Player[];
  theme: PaletteTheme;
  syncState: SyncState;
  pendingCount: number;
  /** Photos and videos in the album so far. */
  mediaCount: number;
  onPlayers: () => void;
  onSettings: () => void;
  onAlbum: () => void;
  onRetry: () => void;
}) {
  const dots = players.slice(0, 4);
  const showSync = syncState === "offline" || pendingCount > 0;
  return (
    <header className="flex min-w-0 shrink-0 items-center gap-0.5 pb-0.5 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.25rem,env(safe-area-inset-right))] pt-[max(0.25rem,env(safe-area-inset-top))]">
      <h1 className="min-w-0 flex-1 truncate font-board text-xl leading-tight" data-testid="board-title">
        {name}
      </h1>

      {showSync ? (
        <button
          type="button"
          onClick={onRetry}
          data-testid="sync-mark"
          data-sync-state={syncState}
          data-pending-count={pendingCount}
          aria-label={`${syncState === "offline" ? "Offline" : "Sending"}${pendingCount ? `, ${pendingCount} waiting` : ""}. Retry`}
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 px-2 font-sans text-base text-board-muted"
        >
          <span
            aria-hidden
            className={`inline-block size-2.5 rounded-full border-[1.5px] ${
              syncState === "offline" ? "border-board-danger bg-board-danger" : "border-board-muted bg-transparent"
            }`}
          />
          <span aria-hidden>{syncState === "offline" ? "offline" : "sending"}</span>
        </button>
      ) : null}

      <button
        type="button"
        onClick={onPlayers}
        data-testid="players-button"
        aria-label={`Players: ${players.length}`}
        className={`${ICON_BUTTON} w-auto gap-1.5 px-2`}
      >
        <span aria-hidden className="flex items-center">
          {dots.map((p, i) => (
            <span
              key={p.id}
              className={`inline-block size-4 rounded-full border-2 border-board-bg ${i > 0 ? "-ml-1.5" : ""}`}
              style={{ backgroundColor: playerColor(p.color, theme).fill }}
            />
          ))}
        </span>
        <span className="font-board text-lg leading-none tabular-nums" data-testid="players-count">
          {players.length}
        </span>
      </button>

      <button type="button" onClick={onSettings} aria-label="Settings" data-testid="settings-button" className={ICON_BUTTON}>
        <Settings aria-hidden className="size-6" strokeWidth={2.25} />
      </button>

      <button
        type="button"
        onClick={onAlbum}
        aria-label={mediaCount > 0 ? `Album: ${mediaCount} so far` : "Album"}
        data-testid="album-button"
        data-count={mediaCount}
        className={`${ICON_BUTTON} relative`}
      >
        <Images aria-hidden className="size-6" strokeWidth={2.25} />
        {mediaCount > 0 ? (
          <span
            aria-hidden
            data-testid="album-count"
            className="absolute right-0.5 top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-board-ink px-1 font-sans text-[11px] font-semibold leading-none text-board-bg tabular-nums"
          >
            {mediaCount > 99 ? "99+" : mediaCount}
          </span>
        ) : null}
      </button>
    </header>
  );
}
