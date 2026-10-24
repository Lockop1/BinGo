"use client";

import { Images, Settings } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Player } from "@/lib/game/types";
import type { SyncState } from "@/lib/game/useGame";
import { playerColor, type PaletteTheme } from "@/lib/palette";

const ICON_BUTTON =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-[10px] text-board-ink " +
  "focus-visible:outline-[3px] focus-visible:-outline-offset-[3px] focus-visible:outline-board-ink active:bg-board-surface";

/** A resync must have been showing `syncing` this long before the soft dot appears. */
export const SYNCING_MARK_DELAY_MS = 400;

/**
 * What the top bar says about sync. `none` when live; `syncing` (a soft dot)
 * once a sync has lasted past SYNCING_MARK_DELAY_MS; `pending` (hollow dot +
 * "sending") while taps wait in the queue; `offline` (muted dot + "offline")
 * when the last resync failed or the browser reports no connection.
 */
export type SyncMark = "none" | "syncing" | "pending" | "offline";

export function syncMarkFor({
  syncState,
  online,
  pendingCount,
  syncingLong,
}: {
  syncState: SyncState;
  /** `navigator.onLine`. */
  online: boolean;
  pendingCount: number;
  /** `syncState` has been `syncing` for longer than SYNCING_MARK_DELAY_MS. */
  syncingLong: boolean;
}): SyncMark {
  if (syncState === "offline" || !online) return "offline";
  if (pendingCount > 0) return "pending";
  if (syncState === "syncing" && syncingLong) return "syncing";
  return "none";
}

/** True once `active` has stayed true for `delayMs`; false again as soon as it drops. */
function useHeldFor(active: boolean, delayMs: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => setHeld(true), delayMs);
    return () => {
      window.clearTimeout(timer);
      setHeld(false);
    };
  }, [active, delayMs]);
  return active && held;
}

function subscribeOnline(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}
const isOnline = () => navigator.onLine;
const assumeOnline = () => true;

/**
 * The only thing above the grid: game name, a quiet sync mark (see SyncMark),
 * players, settings, album (with a small count once there is media).
 *
 * No layout shift for the frequent case: the soft syncing dot lives in a
 * fixed slot that is always reserved at the end of the title (it only fades
 * in and out). The offline / sending mark is a 44px tap target (retry) and
 * only takes room from the truncating title; the buttons never move.
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
  const online = useSyncExternalStore(subscribeOnline, isOnline, assumeOnline);
  const syncingLong = useHeldFor(syncState === "syncing", SYNCING_MARK_DELAY_MS);
  const mark = syncMarkFor({ syncState, online, pendingCount, syncingLong });
  const offline = mark === "offline";
  return (
    <header className="flex min-w-0 shrink-0 items-center gap-0.5 pb-0.5 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.25rem,env(safe-area-inset-right))] pt-[max(0.25rem,env(safe-area-inset-top))]">
      <h1 className="min-w-0 flex-1 truncate font-board text-xl leading-tight" data-testid="board-title">
        {name}
      </h1>

      {/* Always in the layout; only its opacity changes. Decorative: a slow sync needs no announcement. */}
      <span
        aria-hidden
        data-testid="sync-dot"
        data-visible={mark === "syncing"}
        className={`mx-1 inline-block size-1.5 shrink-0 rounded-full bg-board-muted transition-opacity duration-300 motion-reduce:transition-none ${
          mark === "syncing" ? "opacity-70" : "opacity-0"
        }`}
      />
      {mark === "pending" || offline ? (
        <button
          type="button"
          onClick={onRetry}
          data-testid="sync-mark"
          data-sync-state={offline ? "offline" : syncState}
          data-pending-count={pendingCount}
          aria-label={`${offline ? "Offline" : "Sending"}${pendingCount ? `, ${pendingCount} waiting` : ""}. Retry`}
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 px-2 font-sans text-base text-board-muted"
        >
          <span
            aria-hidden
            className={`inline-block size-2.5 rounded-full border-[1.5px] border-board-muted ${
              offline ? "bg-board-muted" : "bg-transparent"
            }`}
          />
          <span aria-hidden>{offline ? "offline" : "sending"}</span>
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
