"use client";

import { useEffect } from "react";
import { track } from "@/lib/analytics";

/** Games whose recap was already counted in this page load (the game id never leaves the phone). */
const viewed = new Set<string>();

/**
 * Sends `recap_viewed` once per game per page load when the recap mounts.
 * Renders nothing. `gameId` is only the de-duplication key; just the media
 * count is sent.
 */
export function RecapViewedTracker({ gameId, mediaCount }: { gameId: string; mediaCount: number }) {
  useEffect(() => {
    if (viewed.has(gameId)) return;
    viewed.add(gameId);
    track("recap_viewed", { media_count: mediaCount });
    // Counted once on mount: later media arriving does not re-send it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId]);
  return null;
}
