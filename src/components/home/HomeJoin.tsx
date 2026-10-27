"use client";

import { useRouter } from "next/navigation";
import { startTransition, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { JOIN_CODE_LENGTH, codeFromInput, homeJoinOutcome } from "@/components/home/homeJoin";
import { findMembership } from "@/components/join/findMembership";
import { JoinCodeInput } from "@/components/join/JoinCodeInput";
import { PencilButton } from "@/components/ui/PencilButton";
import { GAME_ERROR_COPY, toGameError } from "@/lib/game/errors";
import { peekGame } from "@/lib/game/rpc";
import type { GamePreview } from "@/lib/game/types";
import { ensureSession } from "@/lib/supabase/auth";

/**
 * Home's "Got a code? Join a game" line, for a friend who only has the code (read out, or typed
 * into a chat). Checks the code with `peek_game` first, so an unknown, full or ended game
 * gets its message right here instead of a dead-end screen; otherwise it goes on to
 * `/g/<CODE>`, where the name is picked and `join_game` decides.
 */
export function HomeJoin() {
  const router = useRouter();
  const errorId = useId();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every submit and every edit: an answer for an older code is dropped.
  const attempt = useRef(0);
  const code = codeFromInput(value);
  const canSubmit = code.length >= JOIN_CODE_LENGTH && !busy;

  // Next keeps Home mounted (hidden) after navigating on, and Back shows it again: never
  // stuck on "Checking…".
  useEffect(
    () => () => {
      attempt.current++;
      setBusy(false);
    },
    [],
  );

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    const id = ++attempt.current;
    setError(null);
    if (code.length !== JOIN_CODE_LENGTH) {
      setError(GAME_ERROR_COPY.game_not_found);
      return;
    }
    setBusy(true);
    let preview: GamePreview | null = null;
    try {
      preview = await peekGame({ code });
    } catch (cause) {
      const gameError = toGameError(cause);
      if (gameError.code !== "game_not_found") {
        if (id !== attempt.current) return;
        setBusy(false);
        setError(gameError.message);
        return;
      }
    }
    // A full or ended game may be this phone's own: the join screen then takes it straight in.
    let isMember = false;
    if (preview && homeJoinOutcome(code, preview, false) !== "go") {
      const userId = await ensureSession().then(
        (session) => session.user.id,
        () => null,
      );
      isMember = (await findMembership(code, userId)) !== null;
    }
    if (id !== attempt.current) return;
    const outcome = homeJoinOutcome(code, preview, isMember);
    if (outcome !== "go") {
      setBusy(false);
      setError(GAME_ERROR_COPY[outcome]);
      return;
    }
    // Clear busy in the same transition as the navigation (no flash back to "Join").
    startTransition(() => {
      setBusy(false);
      router.push(`/g/${code}`);
    });
  }

  return (
    <section className="mt-[28px] flex min-w-0 flex-col" aria-label="Join a game">
      <form onSubmit={onSubmit} noValidate className="flex min-w-0 flex-col">
        <JoinCodeInput
          label="Got a code? Join a game"
          value={value}
          onChange={(next) => {
            attempt.current++;
            setBusy(false);
            setError(null);
            setValue(next);
          }}
          placeholder="ABCD-2345"
          enterKeyHint="go"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          data-testid="home-join-code"
          action={
            <PencilButton
              type="submit"
              variant="secondary"
              disabled={code.length < JOIN_CODE_LENGTH}
              busy={busy}
              className="shrink-0"
              data-testid="home-join-button"
            >
              {busy ? "Checking…" : "Join"}
            </PencilButton>
          }
        />
        <p
          id={errorId}
          role="alert"
          className="min-h-7 text-lg leading-7 text-danger"
          data-testid="home-join-error"
        >
          {error}
        </p>
      </form>
    </section>
  );
}
