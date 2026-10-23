"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/components/providers/SessionProvider";
import { type GameError, toGameError } from "@/lib/game/errors";
import type { Game, Player, Square } from "@/lib/game/types";
import { createClient } from "@/lib/supabase/client";

export type GameSnapshot = { game: Game; players: Player[]; squares: Square[] };

export type UseGameState =
  | { status: "loading" }
  | ({ status: "ready" } & GameSnapshot)
  | { status: "not_found" }
  | { status: "error"; error: GameError };

export type UseGameResult = UseGameState & {
  /** The caller's player row, once loaded. */
  me: Player | null;
  /** Re-fetch game, players and squares. Resolves when the new state is set. */
  refresh: () => Promise<void>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** Never rejects: failures become a `not_found` / `error` state. */
async function loadGameState(gameId: string): Promise<UseGameState> {
  try {
    const snapshot = await fetchGameSnapshot(gameId);
    return snapshot ? { status: "ready", ...snapshot } : { status: "not_found" };
  } catch (error) {
    return { status: "error", error: toGameError(error) };
  }
}

/**
 * Game data for /game/[id]: initial fetch plus `refresh()`. Use inside
 * <SessionGate>. Realtime subscriptions are layered on in Phase 3.
 */
export function useGame(gameId: string): UseGameResult {
  const { userId } = useSession();
  const [state, setState] = useState<UseGameState>({ status: "loading" });
  const request = useRef(0);

  const refresh = useCallback(() => {
    const id = ++request.current;
    return loadGameState(gameId).then((next) => {
      if (id === request.current) setState(next);
    });
  }, [gameId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const me = state.status === "ready" ? (state.players.find((p) => p.user_id === userId) ?? null) : null;
  return { ...state, me, refresh };
}
