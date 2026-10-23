"use client";

import { useSyncExternalStore } from "react";
import { readDisplayName, subscribeLocal } from "@/lib/storage/local";

const subscribe = (onChange: () => void) => subscribeLocal("bingo.displayName", onChange);
const serverSnapshot = () => "";

/** The saved display name (`bingo.displayName`), hydration-safe ("" on the server). */
export function useStoredDisplayName(): string {
  return useSyncExternalStore(subscribe, readDisplayName, serverSnapshot);
}
