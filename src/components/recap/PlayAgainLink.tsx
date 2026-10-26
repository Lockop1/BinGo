"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createdRematch, lateJoin, rematchKind, type NextGameInfo } from "@/components/recap/rematch";
import { track } from "@/lib/analytics";
import { errorCopy, toGameError } from "@/lib/game/errors";
import { joinGame, playAgain } from "@/lib/game/rpc";
import { effectiveStatus, type Game, type GameStatus, type Player } from "@/lib/game/types";
import { createClient } from "@/lib/supabase/client";

export type PlayAgainProps = {
  game: Pick<Game, "id" | "next_game_id" | "next_join_code">;
  /** This phone's player row in the ended game (its name carries over); nothing shows without it. */
  me: Player | null;
  /** Resync the ended game (its row carries the rematch pointer). */
  refresh: () => Promise<void>;
};

/** Rematches this page load already counted as `play_again` (a double tap, or Back and tap again). */
const countedRematches = new Set<string>();

/** Whether this phone is in the rematch (it can select the row only then: RLS). */
async function readRematch(id: string): Promise<{ hostUserId: string; status: GameStatus } | null> {
  const { data, error } = await createClient()
    .from("games")
    .select("host_user_id, status, deadline_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? { hostUserId: data.host_user_id, status: effectiveStatus(data) } : null;
}

/** The rematch's effective status for a phone that is not in it (status only; not found = expired). */
async function peekRematchStatus(code: string): Promise<GameStatus | null> {
  const { data, error } = await createClient().rpc("peek_game_public", { code });
  if (error) return toGameError(error).code === "game_not_found" ? "ended" : null;
  return data?.status ?? null;
}

async function lookUpRematch(id: string, code: string): Promise<NextGameInfo> {
  try {
    const row = await readRematch(id);
    if (row) return { id, readable: true, hostUserId: row.hostUserId, status: row.status };
  } catch {
    // Offline or flaky: fall back to the public status below.
  }
  try {
    return { id, readable: false, hostUserId: null, status: await peekRematchStatus(code) };
  } catch {
    return { id, readable: false, hostUserId: null, status: null };
  }
}

function useNextGameInfo(nextGameId: string | null, nextCode: string | null): NextGameInfo | null {
  const [info, setInfo] = useState<NextGameInfo | null>(null);
  useEffect(() => {
    if (!nextGameId || !nextCode) return;
    let cancelled = false;
    void lookUpRematch(nextGameId, nextCode).then((next) => {
      if (!cancelled) setInfo(next);
    });
    return () => {
      cancelled = true;
    };
  }, [nextGameId, nextCode]);
  return info !== null && info.id === nextGameId ? info : null;
}

const REMATCH_LINK =
  "inline-flex min-h-11 min-w-0 max-w-full items-center justify-center px-2 text-center text-lg leading-7 text-ink-soft " +
  "underline decoration-ink-faint decoration-1 underline-offset-4 focus-visible:outline-2 " +
  "focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-default disabled:no-underline";

/**
 * The rematch, as one small muted text link at the very bottom of the ended
 * game screen, under "Back to home" (never a popup, banner or button-looking thing):
 *   - no rematch yet: "Play again" starts one (`play_again`) and opens its lobby;
 *   - a rematch is open and this phone is not in it: "A new game is ready · Join"
 *     joins it in one tap under this game's display name;
 *   - this phone is in it: "Go to the new game" (or "You started …" for its host);
 *   - the rematch has ended: nothing (`play_again` would only hand it back).
 * The pointer arrives on the old game's row via Realtime / the resync (which
 * polls fast for a while after the end), and once right away on mount.
 */
export function PlayAgainLink({ game, me, refresh }: PlayAgainProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextGameId = game.next_game_id ?? null;
  const nextCode = game.next_join_code ?? null;
  const info = useNextGameInfo(nextGameId, nextCode);

  // One fresh look when the recap opens: someone may have started a rematch already.
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // Leaving for the new game keeps the link pending; if this screen comes back
  // (Back restores it), it starts out tappable again.
  useEffect(() => () => setPending(false), []);

  if (!me) return null;
  const kind = rematchKind({ nextGameId, nextCode }, info);
  if (kind === "none") return null;
  const myName = me.display_name;
  const myUserId = me.user_id;

  const run = async (action: () => Promise<string>) => {
    setPending(true);
    setError(null);
    try {
      const target = await action();
      router.push(`/game/${target}`);
      // Stays pending: this screen is on its way out.
    } catch (e) {
      setError(errorCopy(e));
      setPending(false);
    }
  };

  /** Joins a rematch this phone is not in yet, and counts the join. */
  const joinRematch = async (code: string, status: GameStatus | null) => {
    const player = await joinGame({ code, display_name: myName });
    track("player_joined", { late_join: lateJoin(status) });
    return player.game_id;
  };

  const onClick = () => {
    if (pending) return;
    if (kind === "go" && nextGameId) {
      setPending(true);
      router.push(`/game/${nextGameId}`);
      return;
    }
    if (kind === "join" && nextCode) {
      void run(() => joinRematch(nextCode, info?.status ?? null));
      return;
    }
    void run(async () => {
      const next = await playAgain(game.id);
      if (createdRematch({ knownNextGameId: nextGameId, returned: next, myUserId })) {
        if (!countedRematches.has(next.id)) {
          countedRematches.add(next.id);
          track("play_again", { source: "recap" });
        }
        return next.id;
      }
      if (next.host_user_id === myUserId) return next.id;
      // Someone else's rematch got there first: join it under the same name
      // (unless this phone is in it already, e.g. from another tab).
      if (await readRematch(next.id).catch(() => null)) return next.id;
      return joinRematch(next.join_code, effectiveStatus(next));
    });
  };

  const label = {
    play: pending ? "Starting a new game…" : "Play again",
    join: pending ? "Joining…" : "A new game is ready · Join",
    go: info?.hostUserId === myUserId ? "You started a new game · Go to it" : "Go to the new game",
  }[kind];

  return (
    <div className="-mt-3 flex min-w-0 flex-col items-center self-stretch" data-testid="rematch" data-kind={kind}>
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        aria-busy={pending || undefined}
        className={REMATCH_LINK}
        data-testid={kind === "play" ? "play-again" : kind === "join" ? "join-next" : "go-next"}
      >
        {label}
      </button>
      {error ? (
        <p role="alert" className="text-center text-lg leading-7 text-ink-soft" data-testid="rematch-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
