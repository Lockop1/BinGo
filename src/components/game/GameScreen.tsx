"use client";

import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { BoardScreen } from "@/components/board/BoardScreen";
import { StartTransition, type StartSquare } from "@/components/game/StartTransition";
import { NotFound } from "@/components/join/JoinScreen";
import { Lobby } from "@/components/lobby/Lobby";
import { useUploadedMedia } from "@/components/media/useUploadedMedia";
import { PaperPage, PaperTitle } from "@/components/paper/PaperPage";
import { SessionGate } from "@/components/providers/SessionGate";
import { useSession } from "@/components/providers/SessionProvider";
import { PlayAgainLink } from "@/components/recap/PlayAgainLink";
import { Recap } from "@/components/recap/Recap";
import { RecapViewedTracker } from "@/components/providers/RecapViewedTracker";
import { PencilButton, PencilLink, pencilButtonClass } from "@/components/ui/PencilButton";
import { SkeletonLines } from "@/components/ui/Skeleton";
import {
  SAVE_DEBOUNCE_MS,
  clearActiveGame,
  goHomeOnPurpose,
  noteGameEnded,
  noteGameScreenShown,
  readActiveGameFor,
  saveActiveGame,
  toActiveGameRecord,
  warmPageForOffline,
  type ActiveGameRecord,
} from "@/lib/game/activeGame";
import type { DroppedAction } from "@/lib/game/pendingActions";
import { droppedNotices } from "@/lib/game/toasts";
import { effectiveStatus, type GameStatus, type Square } from "@/lib/game/types";
import { usePendingQueue } from "@/lib/game/useBoardState";
import { useGame, type UseGameResult } from "@/lib/game/useGame";
import { useSettings } from "@/lib/settings/useSettings";

/**
 * /game/[id]: the paper lobby, then the live board, then the recap.
 * Data and live sync live in useGame; the screen follows the game's
 * effective status, so a start or end seen via Realtime, a resync, the
 * host's own RPC result or the clock passing `deadline_at` all switch screens.
 *
 * The lobby, loading and ended states sit on paper; the live board owns the
 * whole viewport (its own background and safe-area padding), so this
 * component decides the frame rather than the route.
 *
 * A live lobby → active flip (the host's own start, or the start arriving
 * via Realtime / the resync poll on everyone else's phone) plays the start
 * transition over the freshly mounted board. Opening a game that is already
 * active shows the board straight away.
 *
 * Instant return: the last lobby / active game is kept in `bingo.activeGame`
 * (lib/game/activeGame.ts) with a snapshot of its rows, so reopening it draws
 * the board from that snapshot at once (even before the session check or the
 * network) and the fetch then reconciles. The record clears when the game
 * ends (the next open of `/` then lands on the recap once), when the server
 * says the game is gone or this phone is no longer a player (left elsewhere,
 * or removed by the host: "You're no longer in this game"), and on Leave.
 */
export function GameScreen({ gameId }: { gameId: string }) {
  const session = useSession();
  const cached = useCachedGame(gameId);
  if (session.status !== "ready" && !cached) {
    return (
      <PaperPage>
        <SessionGate>{null}</SessionGate>
      </PaperPage>
    );
  }
  return (
    <GameView
      key={gameId}
      gameId={gameId}
      cached={cached}
      sessionReady={session.status === "ready"}
      userId={session.userId ?? cached?.userId ?? null}
    />
  );
}

// The cached record, read hydration-safely (null on the server and in the
// hydrating render, so the markup matches), then straight from localStorage.
// Read on render only: later saves must not re-seed a mounted screen.
const noSubscribe = () => () => {};
const noCache = () => null;
let lastCached: ActiveGameRecord | null = null;
function cachedRecordFor(gameId: string): ActiveGameRecord | null {
  const record = readActiveGameFor(gameId);
  if (!record) return null;
  if (lastCached && lastCached.gameId === record.gameId && lastCached.savedAt === record.savedAt) return lastCached;
  lastCached = record;
  return record;
}

function useCachedGame(gameId: string): ActiveGameRecord | null {
  return useSyncExternalStore(noSubscribe, () => cachedRecordFor(gameId), noCache);
}

function Paper({ children }: { children: ReactNode }) {
  return <PaperPage>{children}</PaperPage>;
}

/** What the start transition draws: the lobby board as it was when the start landed. */
type StartShow = { key: number; name: string; squares: StartSquare[]; freeCenter: boolean };

/** setTimeout's ceiling (~24.8 days); deadline_at is at most ~8 days away (7 days + one extension of a day). */
const MAX_TIMER_MS = 2_147_000_000;

/** Re-renders once `at` passes, so the effective status flips to ended on time. */
function useRerenderAt(at: string | null) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!at) return;
    const ms = Date.parse(at) - Date.now();
    if (!(ms > 0)) return;
    const timer = window.setTimeout(() => setTick((t) => t + 1), Math.min(ms + 50, MAX_TIMER_MS));
    return () => window.clearTimeout(timer);
  }, [at, tick]);
}

/**
 * Keeps `bingo.activeGame` in step with what this screen shows (debounced;
 * flushed when the page is hidden or the screen goes), clears it when the
 * game ends or is gone, and notes a live end in `bingo.lastEnded`.
 */
function useActiveGameRecord(
  gameId: string,
  result: UseGameResult,
  status: GameStatus | null,
  cached: ActiveGameRecord | null,
  userId: string | null,
  removed: boolean,
) {
  // This page load has shown a game: `/` is in-app navigation from now on,
  // and a recap that was due for this game has now been opened.
  useEffect(() => {
    noteGameScreenShown(gameId);
  }, [gameId]);

  const pendingSave = useRef<ActiveGameRecord | null>(null);
  const ready = result.status === "ready";
  const game = ready ? result.game : null;
  const players = ready ? result.players : null;
  const squares = ready ? result.squares : null;
  const media = ready ? result.media : null;
  const member = result.me !== null;
  const confirmed = result.confirmed;
  const saveable = game !== null && member && status !== null && status !== "ended";

  useEffect(() => {
    pendingSave.current = null;
    if (!saveable || !game || !players || !squares || !media) return;
    // Still exactly the cached snapshot: nothing new to keep.
    const snapshot = cached?.snapshot;
    if (
      !confirmed &&
      snapshot &&
      snapshot.game === game &&
      snapshot.players === players &&
      snapshot.squares === squares &&
      snapshot.media === media
    ) {
      return;
    }
    const record = toActiveGameRecord({ game, players, squares, media }, userId);
    if (!record) return;
    pendingSave.current = record;
    const timer = window.setTimeout(() => {
      pendingSave.current = null;
      saveActiveGame(record);
    }, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [saveable, game, players, squares, media, confirmed, cached, userId]);

  // A save still waiting when the page is hidden or the screen goes is written now.
  useEffect(() => {
    const flush = () => {
      const record = pendingSave.current;
      pendingSave.current = null;
      if (record) saveActiveGame(record);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
    };
  }, []);

  // Pages reached by client-side navigation are not in the service worker's
  // cache yet: ask it to keep this one, so a reload with no signal still works.
  const warmed = useRef(false);
  useEffect(() => {
    if (!saveable || warmed.current) return;
    warmed.current = true;
    warmPageForOffline(`${window.location.origin}/game/${gameId}`);
  }, [saveable, gameId]);

  // Ended, gone or no longer ours: forget the game; a live end (seen on
  // server data while this screen was up) lets the next open of `/` land on
  // the recap once.
  const lastConfirmed = useRef<GameStatus | null>(null);
  const notFound = result.status === "not_found" || removed;
  useEffect(() => {
    if (notFound) {
      pendingSave.current = null;
      clearActiveGame(gameId);
      return;
    }
    if (status === null) return;
    if (status === "ended") {
      pendingSave.current = null;
      const before = lastConfirmed.current;
      if (confirmed && (before === "lobby" || before === "active")) noteGameEnded(gameId);
      else clearActiveGame(gameId);
    }
    if (confirmed) lastConfirmed.current = status;
  }, [gameId, notFound, status, confirmed]);
}

function squareLabel(squares: readonly Square[], position: number): string {
  const label = squares.find((s) => s.position === position)?.label.trim();
  return label || `square ${position + 1}`;
}

/** What this phone last knew about the game, for "Join again" once it is no longer a player. */
type KnownGame = { code: string; name: string };

/**
 * This phone was a player and is not any more: the host removed it from the
 * lobby (or it left from another tab). The game is invisible to it now (RLS),
 * so all it can offer is the invite link again, if it still knows the code.
 */
function NoLongerInGame({ gameId, known }: { gameId: string; known: KnownGame | null }) {
  return (
    <div className="flex min-w-0 flex-col items-start" data-testid="no-longer-in-game">
      <PaperTitle>You&apos;re no longer in this game</PaperTitle>
      <p className="text-lg leading-7 text-ink-soft">
        {known ? `You're not on the player list for ${known.name} any more.` : "You're not on the player list any more."}{" "}
        The host may have removed you from the lobby.
      </p>
      <div className="mt-[14px] flex flex-wrap items-center gap-3">
        {known ? (
          // A full page load, not a client navigation: Next keeps the join screen this tab
          // used before mounted (Activity), still showing its old "Joining…" state.
          <a href={`/g/${known.code}`} className={pencilButtonClass("primary")} data-testid="join-again">
            Join again
          </a>
        ) : null}
        <PencilLink href="/" variant="secondary" data-testid="no-longer-home" onClick={() => goHomeOnPurpose(gameId)}>
          Home
        </PencilLink>
      </div>
    </div>
  );
}

/** How long the "Couldn't save …" line stays up unless dismissed. */
const NOTICE_MS = 8_000;

/**
 * One short line for taps that never made it (the game had already ended
 * when they were sent, or too many waited offline). Lives at the game screen,
 * so it survives the switch from the board to the recap that usually follows.
 */
function DroppedNotice({
  dropped,
  squares,
  onDismiss,
}: {
  dropped: readonly DroppedAction[];
  squares: readonly Square[];
  onDismiss: (clientIds: string[]) => void;
}) {
  const lines = droppedNotices(dropped, (position) => squareLabel(squares, position));
  const text = lines.join("\n");
  const ids = dropped.map((d) => d.action.clientId).join(",");
  const dismiss = useCallback(() => onDismiss(ids ? ids.split(",") : []), [ids, onDismiss]);
  useEffect(() => {
    if (!text) return;
    const timer = window.setTimeout(dismiss, NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [text, dismiss]);
  if (lines.length === 0) return null;
  return (
    <div
      role="status"
      data-testid="dropped-notice"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-[max(8px,env(safe-area-inset-bottom))]"
    >
      <div className="index-card pointer-events-auto flex min-w-0 max-w-md items-center gap-1 pl-3 font-pencil text-lg leading-6 text-ink">
        <p className="min-w-0 flex-1 py-2">
          {lines.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </p>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          data-testid="dropped-notice-dismiss"
          className="flex size-11 shrink-0 items-center justify-center text-ink-soft"
        >
          <X aria-hidden className="size-4" strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}

function GameView({
  gameId,
  cached,
  sessionReady,
  userId,
}: {
  gameId: string;
  /** This game's `bingo.activeGame` record, if any: drawn until the first fetch answers. */
  cached: ActiveGameRecord | null;
  /** False while the session check is still running (only reached with a cached snapshot). */
  sessionReady: boolean;
  userId: string | null;
}) {
  const result = useGame(gameId, {
    initial: cached?.snapshot ?? null,
    enabled: sessionReady,
    userIdHint: cached?.userId ?? null,
  });
  const { settings, theme } = useSettings();
  useUploadedMedia(gameId, result.applyMedia);
  // Sends taps restored from storage whatever this screen shows, and reports any it had to drop.
  const queue = usePendingQueue(gameId);

  // An active game moves to the recap the moment deadline_at passes (an
  // extension arriving via Realtime / resync re-arms the timer).
  useRerenderAt(result.status === "ready" ? result.game.deadline_at : null);

  // Effective status as last rendered on this mount (null until the game has
  // loaded), so only a flip seen live starts the transition: a lobby that was
  // only the cached snapshot does not count. Adjusted during render (not in an
  // effect) so the board never paints a frame before the overlay covers it.
  const liveStatus: GameStatus | null = result.status === "ready" ? effectiveStatus(result.game) : null;
  const [seen, setSeen] = useState<{ status: GameStatus; confirmed: boolean } | null>(null);
  const [start, setStart] = useState<StartShow | null>(null);
  if (
    result.status === "ready" &&
    liveStatus !== null &&
    (liveStatus !== seen?.status || result.confirmed !== seen.confirmed)
  ) {
    setSeen({ status: liveStatus, confirmed: result.confirmed });
    if (seen?.status === "lobby" && seen.confirmed && liveStatus === "active") {
      setStart((previous) => ({
        key: (previous?.key ?? 0) + 1,
        name: result.game.name,
        squares: result.squares.map((s) => ({ position: s.position, label: s.label })),
        freeCenter: result.game.free_center,
      }));
    } else if (liveStatus !== "active") {
      setStart(null);
    }
  }

  // "No longer in this game": this phone had the game (it knows its code) and
  // now the server says not found, or the player list no longer has us (a
  // Realtime DELETE of our own row, before the resync turns into not found).
  const readyGame = result.status === "ready" ? result.game : null;
  const [known, setKnown] = useState<KnownGame | null>(() =>
    cached ? { code: cached.joinCode, name: cached.name } : null,
  );
  if (readyGame && (known?.code !== readyGame.join_code || known.name !== readyGame.name)) {
    setKnown({ code: readyGame.join_code, name: readyGame.name });
  }
  const [wasMember, setWasMember] = useState(false);
  if (result.me !== null && !wasMember) setWasMember(true);
  const removed =
    (result.status === "not_found" && known !== null) ||
    (result.status === "ready" && result.confirmed && sessionReady && wasMember && result.me === null);

  useActiveGameRecord(gameId, result, liveStatus, cached, userId, removed);

  const notice = (
    <DroppedNotice
      dropped={queue.dropped}
      squares={result.status === "ready" ? result.squares : NO_SQUARES}
      onDismiss={queue.acknowledge}
    />
  );
  // The notice keeps its place (second child) while the screen in front of it changes.
  return (
    <>
      <GameBody
        gameId={gameId}
        result={result}
        removed={removed}
        known={known}
        status={liveStatus}
        start={start}
        onStartDone={() => setStart(null)}
        theme={theme}
        settings={settings}
      />
      {notice}
    </>
  );
}

const NO_SQUARES: readonly Square[] = [];

type Look = ReturnType<typeof useSettings>;

/** Whichever screen the game's state calls for. */
function GameBody({
  gameId,
  result,
  removed,
  known,
  status,
  start,
  onStartDone,
  theme,
  settings,
}: {
  gameId: string;
  result: UseGameResult;
  /** This phone was a player and no longer is. */
  removed: boolean;
  known: KnownGame | null;
  status: GameStatus | null;
  start: StartShow | null;
  onStartDone: () => void;
  theme: Look["theme"];
  settings: Look["settings"];
}) {
  if (result.status === "loading") {
    return (
      <Paper>
        <SkeletonLines lines={4} label="Loading game" />
      </Paper>
    );
  }
  if (removed) {
    return (
      <Paper>
        <NoLongerInGame gameId={gameId} known={known} />
      </Paper>
    );
  }
  if (result.status === "not_found") {
    return (
      <Paper>
        <NotFound />
      </Paper>
    );
  }
  if (result.status === "error") {
    return (
      <Paper>
        <div role="alert" className="flex flex-col items-start gap-3">
          <p className="text-xl leading-7">{result.error.message}</p>
          <PencilButton variant="secondary" onClick={() => void result.refresh()}>
            Try again
          </PencilButton>
        </div>
      </Paper>
    );
  }

  const { game } = result;

  if (status === "active") {
    return (
      <>
        <BoardScreen
          game={game}
          players={result.players}
          squares={result.squares}
          media={result.media}
          me={result.me}
          syncState={result.syncState}
          catchingUp={!result.confirmed}
          refresh={result.refresh}
          applyGame={result.applyGame}
          applySquare={result.applySquare}
        />
        {start ? (
          <StartTransition
            key={start.key}
            theme={theme}
            textSize={settings.textSize}
            squareSize={settings.squareSize}
            name={start.name}
            squares={start.squares}
            freeCenter={start.freeCenter}
            onDone={onStartDone}
          />
        ) : null}
      </>
    );
  }

  return (
    <Paper>
      <div className="flex min-w-0 flex-col" data-testid="game-screen" data-status={status} data-sync-state={result.syncState}>
        {status === "lobby" ? (
          <Lobby
            game={game}
            players={result.players}
            squares={result.squares}
            me={result.me}
            syncState={result.syncState}
            refresh={result.refresh}
            applyGame={result.applyGame}
            applyPlayer={result.applyPlayer}
            applySquare={result.applySquare}
          />
        ) : (
          // Ended: the paper recap (its story viewer brings its own dark backdrop).
          <div className="flex min-w-0 flex-col gap-7" data-testid="game-ended">
            <RecapViewedTracker gameId={game.id} mediaCount={result.media.length} />
            <Recap
              game={game}
              players={result.players}
              squares={result.squares}
              media={result.media}
              headingLevel="h1"
            />
            <PencilLink
              href="/"
              variant="secondary"
              className="w-full"
              data-testid="back-home"
              onClick={() => goHomeOnPurpose(gameId, { ended: true })}
            >
              Back to home
            </PencilLink>
            {/* The quiet rematch link is the very last thing on the recap, under Back to home. */}
            <PlayAgainLink game={game} me={result.me} refresh={result.refresh} />
          </div>
        )}
      </div>
    </Paper>
  );
}
