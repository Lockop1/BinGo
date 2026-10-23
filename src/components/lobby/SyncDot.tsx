"use client";

import type { SyncState } from "@/lib/game/useGame";

const COPY: Record<SyncState, string> = { live: "Live", syncing: "Syncing", offline: "Offline" };

/**
 * Tiny sync indicator. Tapping it forces a resync (handy after a long
 * tunnel); it never blocks anything.
 */
export function SyncDot({ state, onResync }: { state: SyncState; onResync: () => void }) {
  return (
    <button
      type="button"
      onClick={onResync}
      data-testid="refresh"
      data-sync-state={state}
      aria-label={`${COPY[state]}. Refresh`}
      className="-ml-2 inline-flex min-h-11 items-center gap-1.5 px-2 text-base text-ink-soft focus-visible:outline-2 focus-visible:outline-ink"
    >
      <span
        aria-hidden
        className={`inline-block size-2.5 rounded-[48%_52%_45%_55%/55%_45%_52%_48%] border-[1.5px] transition-colors duration-200 ${
          state === "live"
            ? "border-[var(--sync-live)] bg-[var(--sync-live)]"
            : state === "syncing"
              ? "border-[var(--sync-wait)] bg-transparent"
              : "border-danger bg-danger"
        }`}
      />
      <span aria-hidden>{COPY[state].toLowerCase()}</span>
    </button>
  );
}
