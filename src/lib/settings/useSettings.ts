"use client";

import { useSyncExternalStore } from "react";
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  loadSettings,
  resolveTheme,
  sameSettings,
  saveSettings,
  systemTheme,
  type BoardTheme,
  type Settings,
} from "@/lib/settings/settings";
import { subscribeLocal } from "@/lib/storage/local";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function darkQuery(): MediaQueryList | null {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(DARK_QUERY) : null;
  } catch {
    return null;
  }
}

function subscribePrefersDark(onChange: () => void): () => void {
  const query = darkQuery();
  if (!query) return () => {};
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const getPrefersDark = () => darkQuery()?.matches ?? false;
const getServerPrefersDark = () => false;

// useSyncExternalStore needs a stable snapshot: re-parse on every read, but
// hand back the cached object while nothing actually changed.
let cached: Settings = DEFAULT_SETTINGS;
function getSettings(): Settings {
  const next = loadSettings();
  if (!sameSettings(next, cached)) cached = next;
  return cached;
}
const getServerSettings = (): Settings => DEFAULT_SETTINGS;
const subscribeSettings = (onChange: () => void) => subscribeLocal(SETTINGS_KEY, onChange);

export type UseSettings = {
  settings: Settings;
  /** The theme to draw: pinned, or the phone's. */
  theme: BoardTheme;
  /** What the phone's color scheme asks for (labelled "phone default" in the sheet). */
  systemTheme: BoardTheme;
  update: (patch: Partial<Settings>) => void;
};

/**
 * This phone's board settings, live: follows `prefers-color-scheme` changes,
 * writes from this tab and `storage` events from other tabs.
 *
 * Hydration: the server snapshot is the defaults with a light scheme, so a
 * server render and the first hydrating render agree; React then re-renders
 * with the stored values. In practice the board only ever mounts after the
 * client-side session check (GameScreen), i.e. as a plain client render, where
 * useSyncExternalStore reads storage synchronously before the first paint, so
 * the stored theme shows with no flash.
 */
export function useSettings(): UseSettings {
  const settings = useSyncExternalStore(subscribeSettings, getSettings, getServerSettings);
  const prefersDark = useSyncExternalStore(subscribePrefersDark, getPrefersDark, getServerPrefersDark);
  return {
    settings,
    theme: resolveTheme(settings, prefersDark),
    systemTheme: systemTheme(prefersDark),
    update: saveSettings,
  };
}
