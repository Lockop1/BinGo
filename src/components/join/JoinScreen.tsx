"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { PaperTitle } from "@/components/paper/PaperPage";
import { useSession } from "@/components/providers/SessionProvider";
import { PencilButton } from "@/components/ui/PencilButton";
import { SkeletonLines } from "@/components/ui/Skeleton";
import { TextField } from "@/components/ui/TextField";
import { GameError, errorCopy, toGameError } from "@/lib/game/errors";
import { normalizeJoinCode } from "@/lib/game/links";
import { joinGame, peekGame } from "@/lib/game/rpc";
import { STATUS_LABEL } from "@/lib/game/status";
import { MAX_PLAYERS, type GamePreview } from "@/lib/game/types";
import { DISPLAY_NAME_MAX, isValidDisplayName, normalizeSingleLine } from "@/lib/game/validation";
import { saveDisplayName } from "@/lib/storage/local";
import { useStoredDisplayName } from "@/lib/storage/useStoredDisplayName";
import { createClient } from "@/lib/supabase/client";

type State =
  | { status: "loading" }
  | { status: "not_found" }
  | { status: "member"; gameId: string }
  | { status: "ready"; preview: GamePreview }
  | { status: "error"; message: string };

/**
 * The game id if this user is a player in the game with this code, else null. Filters on
 * `players.user_id` explicitly (inner join), so a membership is never inferred from merely
 * being able to read the game row; RLS still limits what is readable on top of this.
 */
async function findMembership(code: string, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const { data, error } = await createClient()
    .from("games")
    .select("id, players!inner(user_id)")
    .eq("join_code", code)
    .eq("players.user_id", userId)
    .maybeSingle();
  if (error) return null;
  return data?.id ?? null;
}

/** Never rejects. */
async function loadState(code: string, userId: string | null): Promise<State> {
  if (code.length === 0) return { status: "not_found" };
  try {
    const [preview, memberGameId] = await Promise.all([peekGame({ code }), findMembership(code, userId)]);
    return memberGameId ? { status: "member", gameId: memberGameId } : { status: "ready", preview };
  } catch (error) {
    const gameError = toGameError(error);
    return gameError.code === "game_not_found"
      ? { status: "not_found" }
      : { status: "error", message: gameError.message };
  }
}

/** /g/[code]: preview the game, pick a display name, join. Render inside <SessionGate> (needs the user id). */
export function JoinScreen({ rawCode }: { rawCode: string }) {
  const code = normalizeJoinCode(rawCode);
  const router = useRouter();
  const { userId } = useSession();
  const [state, setState] = useState<State>({ status: "loading" });

  const load = useCallback(() => loadState(code, userId).then(setState), [code, userId]);

  // Next keeps this route mounted (hidden) after navigating away, and a back/forward cache
  // restore keeps the whole page. Either way the screen must come back fresh: a re-check of
  // membership and a new form (never the old one still showing "Joining…").
  useEffect(() => {
    let current = true;
    void loadState(code, userId).then((next) => {
      if (current) setState(next);
    });
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      setState({ status: "loading" });
      void loadState(code, userId).then((next) => {
        if (current) setState(next);
      });
    };
    window.addEventListener("pageshow", onPageShow);
    return () => {
      current = false;
      window.removeEventListener("pageshow", onPageShow);
      // Runs when the route is hidden (or unmounted): showing it again starts from loading,
      // which also remounts JoinForm with its busy state cleared.
      setState({ status: "loading" });
    };
  }, [code, userId]);

  // Already a player in this game (e.g. the host opening their own link): go straight in.
  useEffect(() => {
    if (state.status === "member") router.replace(`/game/${state.gameId}`);
  }, [state, router]);

  if (code.length === 0 || state.status === "not_found") return <NotFound />;

  if (state.status === "loading" || state.status === "member") {
    return <SkeletonLines lines={3} label="Loading game" />;
  }

  if (state.status === "error") {
    return (
      <div role="alert" className="flex flex-col items-start gap-3">
        <p className="text-xl leading-7">{state.message}</p>
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

  return <JoinForm code={code} preview={state.preview} />;
}

export function NotFound() {
  return (
    <div className="flex flex-col items-start" data-testid="not-found">
      <PaperTitle>We couldn&apos;t find that game.</PaperTitle>
      <p className="text-lg leading-7 text-ink-soft">Check the link with whoever sent it.</p>
      <Link href="/" className="mt-[14px] inline-flex min-h-11 items-center text-xl underline decoration-2 underline-offset-4">
        Go home
      </Link>
    </div>
  );
}

function JoinForm({ code, preview }: { code: string; preview: GamePreview }) {
  const router = useRouter();
  const storedName = useStoredDisplayName();
  const [draft, setDraft] = useState<string | null>(null);
  const name = draft ?? storedName;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<GameError | null>(null);
  const submitting = useRef(false);

  const ended = preview.status === "ended" || error?.code === "game_ended";
  const full = preview.player_count >= MAX_PLAYERS || error?.code === "game_full";
  const canJoin = !ended && !full && isValidDisplayName(name);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canJoin || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    const displayName = normalizeSingleLine(name);
    try {
      const player = await joinGame({ code, display_name: displayName });
      saveDisplayName(displayName);
      // Clear busy in the same transition as the navigation, so the button never flashes back
      // to "Join" here, and a restored copy of this screen is never stuck on "Joining…".
      submitting.current = false;
      startTransition(() => {
        setBusy(false);
        router.replace(`/game/${player.game_id}`);
      });
    } catch (err) {
      submitting.current = false;
      setBusy(false);
      setError(toGameError(err));
    }
  }

  return (
    <div className="flex min-w-0 flex-col">
      <p className="text-lg leading-7 text-ink-soft">You&apos;re invited to</p>
      <PaperTitle>{preview.name}</PaperTitle>
      <p className="text-xl leading-7" data-testid="join-status">
        {STATUS_LABEL[preview.status]}
        {preview.status === "active" ? " — You'll jump straight in" : null}
        <span className="text-ink-soft"> · </span>
        <span data-testid="player-count">
          {Math.min(preview.player_count, MAX_PLAYERS)}/{MAX_PLAYERS}
        </span>
        <span className="text-ink-soft"> players</span>
      </p>

      {ended ? (
        <div className="mt-[28px] flex flex-col items-start">
          <p className="text-xl leading-7">This game has already ended.</p>
          <Link href="/" className="inline-flex min-h-11 items-center text-xl underline decoration-2 underline-offset-4">
            Go home
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="mt-[28px] flex min-w-0 flex-col gap-4" noValidate>
          <TextField
            label="Your name"
            value={name}
            onChange={setDraft}
            max={DISPLAY_NAME_MAX}
            placeholder="What friends call you"
            autoCapitalize="words"
            enterKeyHint="go"
            data-testid="join-name"
            disabled={full}
            required
          />
          {full ? (
            <p className="text-lg leading-7" role="status">
              This game is full (10 players).
            </p>
          ) : null}
          {error && error.code !== "game_full" ? (
            <p role="alert" className="text-lg leading-7 text-danger">
              {errorCopy(error)}
            </p>
          ) : null}
          <PencilButton type="submit" disabled={!canJoin} busy={busy} className="w-full text-2xl" data-testid="join-game">
            {busy ? "Joining…" : "Join"}
          </PencilButton>
        </form>
      )}
    </div>
  );
}
