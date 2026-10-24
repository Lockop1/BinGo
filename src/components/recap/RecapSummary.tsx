"use client";

import { Download, Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ColorChip } from "@/components/recap/ColorChip";
import { completedLines } from "@/components/recap/lines";
import { recapTotals, slug, squareTitle, type RecapItem } from "@/components/recap/recapItems";
import { downloadAllZip, type ZipProgress } from "@/components/recap/save";
import { PencilButton } from "@/components/ui/PencilButton";
import { track } from "@/lib/analytics";
import { errorCopy } from "@/lib/game/errors";
import { joinGame, playAgain } from "@/lib/game/rpc";
import { BOARD_SIZE, type Game, type Player, type Square } from "@/lib/game/types";
import type { GetSignedUrls } from "@/lib/media/signedUrls";
import { createClient } from "@/lib/supabase/client";

type Props = {
  game: Pick<Game, "name" | "expires_at">;
  players: readonly Player[];
  squares: readonly Square[];
  items: readonly RecapItem[];
  names: readonly string[];
  getSignedUrls: GetSignedUrls;
  onWatch: () => void;
  /** "Night recap" is the page heading on the ended screen (h1), a section elsewhere (h2). */
  headingLevel?: "h1" | "h2";
  /** The real ended game (not the media lab): the quiet rematch link at the very bottom. */
  playAgain?: PlayAgainProps;
};

/** "Saturday, November 22" in the viewer's locale. */
function longDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date(iso));
}

type ZipState = { kind: "idle" } | { kind: "working"; progress: ZipProgress | null } | { kind: "done"; failed: number } | { kind: "error" };

/** The paper "Night recap" card: totals, lines, who did what, the album deadline and its actions. */
export function RecapSummary({
  game,
  players,
  squares,
  items,
  names,
  getSignedUrls,
  onWatch,
  headingLevel: Heading = "h2",
  playAgain: rematch,
}: Props) {
  const [zip, setZip] = useState<ZipState>({ kind: "idle" });
  // Counts only what is crossed off now; the album (items) keeps media from undone squares too.
  const { completed, byPlayer: counts } = recapTotals(squares);
  const lines = completedLines(squares);
  const ranked = [...players].sort(
    (a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || a.joined_at.localeCompare(b.joined_at),
  );
  const playerById = new Map(players.map((p) => [p.id, p]));
  const hasMedia = items.length > 0;

  const downloadAll = async () => {
    setZip({ kind: "working", progress: null });
    try {
      const { failed } = await downloadAllZip({
        items,
        names,
        zipName: `${slug(game.name, "bingo-night")}-recap.zip`,
        getSignedUrls,
        onProgress: (progress) => setZip({ kind: "working", progress }),
      });
      setZip({ kind: "done", failed });
    } catch {
      setZip({ kind: "error" });
    }
  };

  return (
    <section className="flex min-w-0 flex-col gap-[14px]" aria-labelledby="recap-title" data-testid="recap-summary">
      <div className="min-w-0">
        <Heading id="recap-title" className="text-4xl leading-[56px] tracking-wide">
          Night recap
        </Heading>
        <p className="text-xl leading-7 break-words text-ink-soft">{game.name}</p>
      </div>

      <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="flex items-baseline gap-1" data-testid="recap-count" data-count={completed.length}>
          <span className="text-6xl leading-none tabular-nums">{completed.length}</span>
          <span className="text-3xl leading-none tabular-nums text-ink-soft">/{BOARD_SIZE}</span>
          <span className="ml-1 text-xl leading-7">squares</span>
        </p>
        <p className="text-xl leading-7" data-testid="recap-lines" data-lines={lines.length}>
          {lines.length === 12
            ? "Blackout: all 12 lines"
            : lines.length > 0
              ? `${lines.length} bingo ${lines.length === 1 ? "line" : "lines"}`
              : "No bingo lines this time"}
        </p>
      </div>
      {lines.length > 0 && lines.length < 12 ? (
        <p className="-mt-2 text-lg leading-7 break-words text-ink-soft">{lines.join(", ")}</p>
      ) : null}

      <ul className="flex min-w-0 flex-col" aria-label="Players">
        {ranked.map((p) => {
          const n = counts.get(p.id) ?? 0;
          return (
            <li key={p.id} className="flex min-h-7 min-w-0 items-center gap-2 text-xl leading-7" data-testid="recap-player">
              <ColorChip color={p.color} />
              <span className="min-w-0 flex-1 truncate">{p.display_name}</span>
              <span className="shrink-0 tabular-nums text-ink-soft" data-testid="recap-player-count">
                {n} {n === 1 ? "square" : "squares"}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="flex min-w-0 flex-col">
        <p className="text-xl leading-7" data-testid="recap-expiry">
          Album available until {longDate(game.expires_at)}
        </p>
        <p className="text-lg leading-7 text-ink-soft">Save before it&apos;s gone.</p>
      </div>

      {hasMedia ? (
        <div className="flex min-w-0 flex-col gap-2">
          <PencilButton onClick={onWatch} data-testid="recap-watch" className="w-full">
            <Play aria-hidden className="size-5" strokeWidth={2.25} />
            Watch the recap
          </PencilButton>
          <PencilButton
            variant="secondary"
            onClick={() => void downloadAll()}
            busy={zip.kind === "working"}
            data-testid="recap-download-all"
            className="w-full"
          >
            <Download aria-hidden className="size-5" strokeWidth={2.25} />
            Download all
          </PencilButton>
          <p aria-live="polite" className="min-h-7 text-lg leading-7" data-testid="recap-download-status">
            {zip.kind === "working"
              ? zip.progress
                ? `Zipping ${zip.progress.done}/${zip.progress.total}…`
                : "Getting the album…"
              : zip.kind === "done"
                ? zip.failed > 0
                  ? `Downloaded. ${zip.failed} couldn't be fetched.`
                  : "Downloaded."
                : zip.kind === "error"
                  ? "Couldn't download the album. Check your connection and try again."
                  : null}
          </p>
          <p className="text-base leading-[22px] text-ink-soft" data-testid="recap-download-note">
            On iPhone a zip can be clunky to open. Saving each photo from the recap is the easier way.
          </p>
        </div>
      ) : (
        <div className="flex min-w-0 flex-col" data-testid="recap-no-media">
          <p className="text-xl leading-7">No photos or videos this time.</p>
          {completed.length > 0 ? (
            <ul className="mt-1 flex min-w-0 flex-col" aria-label="Completed squares">
              {completed.map((s) => {
                const by = s.completed_by_player_id ? playerById.get(s.completed_by_player_id) : undefined;
                return (
                  <li key={s.id} className="flex min-h-7 min-w-0 items-center gap-2 text-lg leading-7" data-testid="recap-square-row">
                    <span className="min-w-0 flex-1 break-words">{squareTitle(s)}</span>
                    {by ? (
                      <span className="flex shrink-0 items-center gap-1.5 text-ink-soft">
                        <ColorChip color={by.color} className="size-4" />
                        {by.display_name}
                      </span>
                    ) : (
                      <span className="shrink-0 text-ink-soft">on the house</span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      )}

      {rematch ? <PlayAgainLink {...rematch} /> : null}
    </section>
  );
}

export type PlayAgainProps = {
  game: Pick<Game, "id" | "next_game_id" | "next_join_code">;
  /** This phone's player row in the ended game (its name carries over); nothing shows without it. */
  me: Player | null;
  /** Resync the ended game (its row carries the rematch pointer). */
  refresh: () => Promise<void>;
};

/** What this phone may read of the rematch: only a player of it can select its row (RLS). */
type NextGameAccess = { id: string; readable: boolean; hostUserId: string | null };

function useNextGameAccess(nextGameId: string | null): NextGameAccess | null {
  const [access, setAccess] = useState<NextGameAccess | null>(null);
  useEffect(() => {
    if (!nextGameId) return;
    let cancelled = false;
    void createClient()
      .from("games")
      .select("id, host_user_id")
      .eq("id", nextGameId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled || error) return;
        setAccess({ id: nextGameId, readable: data !== null, hostUserId: data?.host_user_id ?? null });
      });
    return () => {
      cancelled = true;
    };
  }, [nextGameId]);
  return access !== null && access.id === nextGameId ? access : null;
}

const REMATCH_LINK =
  "inline-flex min-h-11 min-w-0 max-w-full items-center self-start text-left text-lg leading-7 text-ink-soft " +
  "underline decoration-ink-faint decoration-1 underline-offset-4 focus-visible:outline-2 " +
  "focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-default disabled:no-underline";

/**
 * The rematch, as one small muted text link under everything else on the
 * recap (never a popup, banner or button-looking thing):
 *   - no rematch yet: "Play again" starts one (`play_again`) and opens its lobby;
 *   - a rematch exists and this phone is not in it: "A new game is ready · Join"
 *     joins it in one tap under this game's display name;
 *   - this phone is in it: "Go to the new game" (or "You started …" for its host).
 * The pointer arrives on the old game's row via Realtime / the resync (which
 * polls fast for a while after the end), and once right away on mount.
 */
function PlayAgainLink({ game, me, refresh }: PlayAgainProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextGameId = game.next_game_id ?? null;
  const nextCode = game.next_join_code ?? null;
  const access = useNextGameAccess(nextGameId);

  // One fresh look when the recap opens: someone may have started a rematch already.
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // Leaving for the new game keeps the link pending; if this screen comes back
  // (Back restores it), it starts out tappable again.
  useEffect(() => () => setPending(false), []);

  if (!me) return null;
  const myName = me.display_name;
  const myUserId = me.user_id;
  const kind: "play" | "join" | "go" = !nextCode || !nextGameId ? "play" : access?.readable ? "go" : "join";

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

  const onClick = () => {
    if (pending) return;
    if (kind === "go" && nextGameId) {
      setPending(true);
      router.push(`/game/${nextGameId}`);
      return;
    }
    if (kind === "join" && nextCode) {
      void run(async () => (await joinGame({ code: nextCode, display_name: myName })).game_id);
      return;
    }
    void run(async () => {
      const next = await playAgain(game.id);
      track("play_again", { source: "recap" });
      // Someone else's rematch got there first: join it under the same name.
      if (next.host_user_id !== myUserId) {
        return (await joinGame({ code: next.join_code, display_name: myName })).game_id;
      }
      return next.id;
    });
  };

  const label = {
    play: pending ? "Starting a new game…" : "Play again",
    join: pending ? "Joining…" : "A new game is ready · Join",
    go: access?.hostUserId === myUserId ? "You started a new game · Go to it" : "Go to the new game",
  }[kind];

  return (
    <div className="-mt-1 flex min-w-0 flex-col" data-testid="rematch" data-kind={kind}>
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
        <p role="alert" className="text-lg leading-7 text-ink-soft" data-testid="rematch-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
