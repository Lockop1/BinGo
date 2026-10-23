"use client";

import Link from "next/link";
import { ChevronRight, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { SkeletonLines } from "@/components/ui/Skeleton";
import { PencilButton } from "@/components/ui/PencilButton";
import { errorCopy } from "@/lib/game/errors";
import { STATUS_LABEL, shortDate } from "@/lib/game/status";
import { effectiveStatus, type Game } from "@/lib/game/types";
import { createClient } from "@/lib/supabase/client";

type Row = { game: Game; playerCount: number };

type State = { status: "loading" } | { status: "ready"; rows: Row[] } | { status: "error"; message: string };

async function loadGames(): Promise<Row[]> {
  const supabase = createClient();
  // RLS limits this to games this phone's anonymous user is a player in.
  const { data: games, error } = await supabase
    .from("games")
    .select("*")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  if (games.length === 0) return [];

  const { data: players, error: playersError } = await supabase
    .from("players")
    .select("game_id")
    .in(
      "game_id",
      games.map((g) => g.id),
    );
  if (playersError) throw playersError;

  const counts = new Map<string, number>();
  for (const p of players) counts.set(p.game_id, (counts.get(p.game_id) ?? 0) + 1);
  return games.map((game) => ({ game, playerCount: counts.get(game.id) ?? 0 }));
}

/** Never rejects. */
async function loadState(): Promise<State> {
  try {
    return { status: "ready", rows: await loadGames() };
  } catch (error) {
    return { status: "error", message: errorCopy(error) };
  }
}

/** "Your games": games on this phone from the last 30 days. Render inside <SessionGate>. */
export function YourGames() {
  const [state, setState] = useState<State>({ status: "loading" });

  const load = useCallback(() => loadState().then(setState), []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === "loading") return <SkeletonLines lines={3} label="Loading your games" />;

  if (state.status === "error") {
    return (
      <div role="alert" className="flex flex-col items-start gap-2">
        <p className="text-lg leading-7 text-ink-soft">{state.message}</p>
        <PencilButton
          variant="secondary"
          onClick={() => {
            setState({ status: "loading" });
            void load();
          }}
        >
          Try again
        </PencilButton>
      </div>
    );
  }

  if (state.rows.length === 0) {
    return (
      <div className="flex flex-col">
        <p className="text-xl leading-7">No games on this phone yet.</p>
        <p className="text-lg leading-7 text-ink-soft">Games you create or join stay here for 30 days.</p>
      </div>
    );
  }

  const now = new Date();
  return (
    <ul className="flex flex-col" data-testid="your-games">
      {state.rows.map(({ game, playerCount }) => {
        const status = effectiveStatus(game, now);
        return (
          <li key={game.id}>
            <Link
              href={`/game/${game.id}`}
              data-testid="game-row"
              className="flex min-h-14 items-center gap-3 border-b border-dashed border-ink-faint py-1 active:bg-highlight/40"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-2xl leading-7">{game.name}</span>
                <span className="text-base leading-7 text-ink-soft">
                  {STATUS_LABEL[status]}
                  {status === "ended" ? ` · Album until ${shortDate(game.expires_at)}` : null}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1 text-base text-ink-soft" aria-label={`${playerCount} players`}>
                <Users aria-hidden className="size-4" strokeWidth={2} />
                {playerCount}
              </span>
              <ChevronRight aria-hidden className="size-5 shrink-0 text-ink-soft" strokeWidth={2} />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
