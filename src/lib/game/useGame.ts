"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useSession } from "@/components/providers/SessionProvider";
import { type GameError, toGameError } from "@/lib/game/errors";
import {
  applyGameChange,
  applyPlayerChange,
  applySquareChange,
  mergeGame,
  mergeSnapshot,
  subscribeToGame,
  syncPollMs,
  upsertPlayer,
  upsertSquare,
  type GameSnapshot,
  type RowChange,
} from "@/lib/game/realtime";
import { effectiveStatus, type Game, type Player, type Square } from "@/lib/game/types";
import { createClient } from "@/lib/supabase/client";

export type { GameSnapshot } from "@/lib/game/realtime";

export type UseGameState =
  | { status: "loading" }
  | ({ status: "ready" } & GameSnapshot)
  | { status: "not_found" }
  | { status: "error"; error: GameError };

/**
 * `live`: the last resync succeeded (Realtime events, if any, apply on top).
 * `syncing`: a resync has been in flight for a moment. `offline`: the browser
 * is offline or the last resync failed; the held state is still shown.
 */
export type SyncState = "live" | "syncing" | "offline";

export type UseGameResult = UseGameState & {
  /** The caller's player row, once loaded. */
  me: Player | null;
  /** Re-fetch game, players and squares. Resolves when the new state is set. */
  refresh: () => Promise<void>;
  syncState: SyncState;
  /** Fold an authoritative row returned by an RPC into the held state. */
  applyGame: (row: Game) => void;
  applyPlayer: (row: Player) => void;
  applySquare: (row: Square) => void;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only show `syncing` for a resync that takes longer than this (no flicker on fast polls). */
const SYNCING_DELAY_MS = 400;
/** A fetch that raced a newer event or RPC result is retried this many times before merging anyway. */
const RACE_RETRIES = 2;

/** Loads one game (RLS: members only) with its players and squares in parallel. */
export async function fetchGameSnapshot(gameId: string): Promise<GameSnapshot | null> {
  if (!UUID.test(gameId)) return null;
  const supabase = createClient();
  const [gameRes, playersRes, squaresRes] = await Promise.all([
    supabase.from("games").select("*").eq("id", gameId).maybeSingle(),
    supabase.from("players").select("*").eq("game_id", gameId).order("joined_at", { ascending: true }),
    supabase.from("squares").select("*").eq("game_id", gameId).order("position", { ascending: true }),
  ]);
  if (gameRes.error) throw gameRes.error;
  if (!gameRes.data) return null;
  if (playersRes.error) throw playersRes.error;
  if (squaresRes.error) throw squaresRes.error;
  return { game: gameRes.data, players: playersRes.data, squares: squaresRes.data };
}

// Browser signals as external stores (no setState inside effects).
function subscribeOnline(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}
function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}
const isOnline = () => navigator.onLine;
const isVisible = () => document.visibilityState === "visible";
const alwaysTrue = () => true;

/**
 * Game data for /game/[id], kept live. Use inside <SessionGate>.
 *
 * - Realtime: one channel per game; INSERT/UPDATE/DELETE events are merged
 *   with the pure reducers in realtime.ts (stale square events are dropped).
 * - Resync: a full refetch on channel `SUBSCRIBED` (initial join and every
 *   reconnect), when the tab becomes visible, on `online`, and every
 *   `syncPollMs()` while visible and the game has not ended. Overlapping
 *   requests coalesce into one follow-up fetch; the screen never shows a
 *   spinner for a resync (only `syncState`).
 */
export function useGame(gameId: string): UseGameResult {
  const { userId } = useSession();
  const [state, setState] = useState<UseGameState>({ status: "loading" });
  const [syncing, setSyncing] = useState(false);
  const [failed, setFailed] = useState(false);
  const online = useSyncExternalStore(subscribeOnline, isOnline, alwaysTrue);
  const visible = useSyncExternalStore(subscribeVisibility, isVisible, alwaysTrue);

  /** Bumped by every event / RPC result applied, so a fetch can tell it raced one. */
  const mutationSeq = useRef(0);
  const running = useRef<Promise<void> | null>(null);
  const queued = useRef(false);
  const gameIdRef = useRef(gameId);

  useEffect(() => {
    gameIdRef.current = gameId;
  }, [gameId]);

  const fetchOnce = useCallback(async () => {
    for (let attempt = 0; ; attempt++) {
      const seqAtStart = mutationSeq.current;
      let snapshot: GameSnapshot | null;
      try {
        snapshot = await fetchGameSnapshot(gameId);
      } catch (error) {
        if (gameIdRef.current !== gameId) return;
        setFailed(true);
        // Keep showing held data; only an initial load turns into an error screen.
        setState((prev) => (prev.status === "ready" ? prev : { status: "error", error: toGameError(error) }));
        return;
      }
      if (gameIdRef.current !== gameId) return;
      // Something newer was applied while this fetch was in flight: its rows may
      // predate it. Fetch again rather than briefly reverting (squares are also
      // protected by updated_at in mergeSnapshot).
      if (seqAtStart !== mutationSeq.current && attempt < RACE_RETRIES) continue;
      setFailed(false);
      setState((prev) => {
        if (!snapshot) return { status: "not_found" };
        const held = prev.status === "ready" ? { game: prev.game, players: prev.players, squares: prev.squares } : null;
        return { status: "ready", ...mergeSnapshot(held, snapshot) };
      });
      return;
    }
  }, [gameId]);

  const refresh = useCallback((): Promise<void> => {
    if (running.current) {
      queued.current = true;
      return running.current;
    }
    const run = (async () => {
      const timer = window.setTimeout(() => setSyncing(true), SYNCING_DELAY_MS);
      try {
        do {
          queued.current = false;
          await fetchOnce();
        } while (queued.current);
      } finally {
        window.clearTimeout(timer);
        running.current = null;
        setSyncing(false);
      }
    })();
    running.current = run;
    return run;
  }, [fetchOnce]);

  /** Applies a reducer to the held snapshot (no-op until loaded). */
  const apply = useCallback((reduce: (snapshot: GameSnapshot) => GameSnapshot | null) => {
    mutationSeq.current++;
    setState((prev) => {
      if (prev.status !== "ready") return prev;
      const next = reduce({ game: prev.game, players: prev.players, squares: prev.squares });
      if (!next) return { status: "not_found" };
      if (next.game === prev.game && next.players === prev.players && next.squares === prev.squares) return prev;
      return { status: "ready", ...next };
    });
  }, []);

  const applyGame = useCallback((row: Game) => apply((s) => ({ ...s, game: mergeGame(s.game, row) })), [apply]);
  const applyPlayer = useCallback((row: Player) => apply((s) => ({ ...s, players: upsertPlayer(s.players, row) })), [apply]);
  const applySquare = useCallback((row: Square) => apply((s) => ({ ...s, squares: upsertSquare(s.squares, row) })), [apply]);

  // Initial load.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Realtime channel; SUBSCRIBED (first join or a reconnect) triggers a resync.
  useEffect(() => {
    if (!UUID.test(gameId)) return;
    return subscribeToGame(gameId, {
      onGame: (change: RowChange<Game>) => apply((s) => {
        const game = applyGameChange(s.game, change);
        return game ? { ...s, game } : null;
      }),
      onPlayer: (change) => apply((s) => ({ ...s, players: applyPlayerChange(s.players, change) })),
      onSquare: (change) => apply((s) => ({ ...s, squares: applySquareChange(s.squares, change) })),
      onStatus: (status) => {
        if (status === "SUBSCRIBED") void refresh();
      },
    });
  }, [gameId, apply, refresh]);

  // Back to the tab, or back online: resync right away.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const onOnline = () => void refresh();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [refresh]);

  // Gentle poll while the tab is visible and the game can still change.
  const ready = state.status === "ready";
  const ended = state.status === "ready" && effectiveStatus(state.game) === "ended";
  useEffect(() => {
    if (!ready || ended || !visible) return;
    const timer = window.setInterval(() => void refresh(), syncPollMs());
    return () => window.clearInterval(timer);
  }, [ready, ended, visible, refresh]);

  const syncState: SyncState = !online || failed ? "offline" : syncing ? "syncing" : "live";
  const me = state.status === "ready" ? (state.players.find((p) => p.user_id === userId) ?? null) : null;
  return { ...state, me, refresh, syncState, applyGame, applyPlayer, applySquare };
}
