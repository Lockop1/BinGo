"use client";

import { useSyncExternalStore } from "react";
import { getDefaultUploadQueue } from "@/lib/media/defaultUploadQueue";
import type { UploadItem, UploadQueue } from "@/lib/media/uploadQueue";

const EMPTY: readonly UploadItem[] = [];
const serverSnapshot = () => EMPTY;

/**
 * Subscribes a component to the upload queue (the app-wide one by default).
 * Items are in-memory only: they disappear on reload (see uploadQueue.ts).
 */
export function useUploadQueue(queue?: UploadQueue) {
  const q = queue ?? getDefaultUploadQueue();
  const items = useSyncExternalStore(q.subscribe, q.getSnapshot, serverSnapshot);
  return { items, enqueue: q.enqueue, retry: q.retry, dismiss: q.dismiss, queue: q };
}
