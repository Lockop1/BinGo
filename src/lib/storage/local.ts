/**
 * Tiny typed localStorage helpers. Every access is wrapped in try/catch, so a
 * private window, blocked storage or SSR never throws: reads fall back to
 * `null` and writes are silently dropped.
 */

import type { StoredSettings } from "@/lib/settings/settings";

export type ActiveGameRecord = {
  gameId: string;
  /** ISO timestamp of when this phone last opened the game. */
  savedAt: string;
};

type LocalSchema = {
  "bingo.displayName": string;
  /** Placeholder for Phase 7 (instant return to the active board). */
  "bingo.activeGame": ActiveGameRecord;
  /** Board settings for this phone (validated field by field on read, see lib/settings). */
  "bingo.settings": StoredSettings;
} & {
  /** Bingo line ids (and "blackout") this phone has already celebrated for a game. */
  [key: `bingo.celebrated.${string}`]: string[];
};

export type LocalKey = keyof LocalSchema;

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readLocal<K extends LocalKey>(key: K): LocalSchema[K] | null {
  try {
    const raw = storage()?.getItem(key);
    if (raw === null || raw === undefined) return null;
    return JSON.parse(raw) as LocalSchema[K];
  } catch {
    return null;
  }
}

export function writeLocal<K extends LocalKey>(key: K, value: LocalSchema[K]): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
    notify(key);
  } catch {
    // Storage full or unavailable: nothing to do.
  }
}

export function removeLocal(key: LocalKey): void {
  try {
    storage()?.removeItem(key);
    notify(key);
  } catch {
    // Unavailable: nothing to do.
  }
}

// Same-tab subscribers (the `storage` event only fires in other tabs).
const listeners = new Set<(key: LocalKey) => void>();

function notify(key: LocalKey) {
  listeners.forEach((listener) => listener(key));
}

/** Subscribe to changes of `key` from this tab and other tabs. Returns an unsubscribe. */
export function subscribeLocal(key: LocalKey, onChange: () => void): () => void {
  const local = (changed: LocalKey) => {
    if (changed === key) onChange();
  };
  const remote = (event: StorageEvent) => {
    if (event.key === key || event.key === null) onChange();
  };
  listeners.add(local);
  if (typeof window !== "undefined") window.addEventListener("storage", remote);
  return () => {
    listeners.delete(local);
    if (typeof window !== "undefined") window.removeEventListener("storage", remote);
  };
}

export function readDisplayName(): string {
  const value = readLocal("bingo.displayName");
  return typeof value === "string" ? value : "";
}

export function saveDisplayName(name: string): void {
  writeLocal("bingo.displayName", name);
}
