"use client";

import { useEffect } from "react";
import type { Media } from "@/lib/game/types";
import { getDefaultUploadQueue } from "@/lib/media/defaultUploadQueue";
import type { UploadQueue } from "@/lib/media/uploadQueue";

/**
 * Folds each finished upload's `register_media` row for this game into the
 * held game state, so the square's strip and the album update at once instead
 * of waiting for the Realtime event or the next resync (which still arrive and
 * dedupe by id). Lives at the game screen, so an upload that finishes after
 * the game ended still reaches the recap.
 */
export function useUploadedMedia(gameId: string, applyMedia: (row: Media) => void, queue?: UploadQueue) {
  useEffect(() => {
    const q = queue ?? getDefaultUploadQueue();
    const applied = new Set<string>();
    const sync = () => {
      for (const item of q.getSnapshot()) {
        if (item.state !== "done" || !item.media || item.gameId !== gameId || applied.has(item.id)) continue;
        applied.add(item.id);
        applyMedia(item.media);
      }
    };
    sync();
    return q.subscribe(sync);
  }, [gameId, applyMedia, queue]);
}
