"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { BoardGrid } from "@/components/board/BoardGrid";
import { Celebration } from "@/components/board/Celebration";
import { PlayersSheetBody } from "@/components/board/PlayersSheet";
import { SettingsSheetBody } from "@/components/board/SettingsSheet";
import { SquareSheetBody, squareTitle } from "@/components/board/SquareSheet";
import { TopBar } from "@/components/board/TopBar";
import { RecapStory } from "@/components/recap/RecapStory";
import { ExtendDeadlineForm } from "@/components/deadline/ExtendDeadlineForm";
import { useCountdown } from "@/lib/deadline/useNow";
import { track } from "@/lib/analytics";
import { buildRecapItems, recapFileNames, type RecapItem } from "@/components/recap/recapItems";
import { Sheet } from "@/components/ui/Sheet";
import { goHomeOnPurpose } from "@/lib/game/activeGame";
import { completedLines, isBlackout } from "@/lib/game/bingo";
import { diffBoards, type BoardEvent, type DisplaySquare } from "@/lib/game/boardState";
import { createCelebrationQueue, createCelebrationTracker } from "@/lib/game/celebrations";
import { GAME_ERROR_COPY, errorCopy } from "@/lib/game/errors";
import { isGameOverError, type Settled } from "@/lib/game/pendingActions";
import { endGame, extendDeadline } from "@/lib/game/rpc";
import { timestampMicros } from "@/lib/game/realtime";
import {
  createToastQueue,
  deadlineToast,
  mediaToasts,
  noteDeadlineToastShown,
  readDeadlineToastShown,
  shouldShowDeadlineToast,
  type Toast,
  type ToastInput,
} from "@/lib/game/toasts";
import type { Game, Media, Player, Square } from "@/lib/game/types";
import { useBoardState } from "@/lib/game/useBoardState";
import type { SyncState } from "@/lib/game/useGame";
import { doublePulse, pulse } from "@/lib/haptics";
import { getSignedUrls } from "@/lib/media/signedUrls";
import { paletteThemeFor, type BoardTheme } from "@/lib/settings/settings";
import { useSettings } from "@/lib/settings/useSettings";

export type BoardScreenProps = {
  game: Game;
  players: Player[];
  squares: Square[];
  /** Every photo/video registered so far (useGame keeps it live). */
  media: Media[];
  me: Player | null;
  syncState: SyncState;
  /**
   * The board is still the cached snapshot (instant return) waiting for the
   * first server answer: what that answer brings is old news (no toasts or
   * parties for it), like a fresh load.
   */
  catchingUp?: boolean;
  refresh: () => Promise<void>;
  applyGame: (row: Game) => void;
  applySquare: (row: Square) => void;
};

type SheetState =
  | { kind: "square"; position: number }
  | { kind: "players" }
  | { kind: "settings" }
  | { kind: "album" }
  | { kind: "extend" };

/** The host's extension as shown before `extend_deadline` answers. */
type ExtendOverlay = { deadline_at: string; deadline_extended_at: string; seq: number };

/** The live album as it was when opened, in board order (new uploads don't shift an open story). */
type StoryState = { items: RecapItem[]; names: string[]; startIndex: number };

/** Browser chrome color per theme (matches --whiteboard-bg / --scoreboard-bg in globals.css). */
const THEME_COLOR: Record<BoardTheme, string> = { whiteboard: "#ffffff", scoreboard: "#0b0b0d" };

/**
 * While the board is up, the browser's toolbar matches it instead of the
 * paper (layout.tsx's per-scheme theme-color metas); restored on the way out.
 */
function useThemeColor(color: string) {
  useEffect(() => {
    const metas = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
    const saved = metas.map((meta) => meta.content);
    for (const meta of metas) meta.content = color;
    return () => metas.forEach((meta, i) => (meta.content = saved[i]));
  }, [color]);
}

/** "7 of 25 crossed off · 1 bingo" under the grid. */
function progressLine(board: DisplaySquare[]): string {
  const done = board.filter((s) => s.completed_at !== null).length;
  const lines = completedLines(board).length;
  const bingo = lines === 0 ? "" : lines === 1 ? " · 1 bingo" : ` · ${lines} bingos`;
  return `${done} of ${board.length || 25} crossed off${bingo}`;
}

function squareName(board: DisplaySquare[], position: number): string {
  const label = board.find((s) => s.position === position)?.label.trim();
  return label || `square ${position + 1}`;
}

/** Toast copy for news from other phones (who undid it is inferred: only the completer or the host can). */
function toastFor(
  event: Exclude<BoardEvent, { type: "own_completed" }>,
  board: DisplaySquare[],
  players: Player[],
  meId: string | null,
  host: Player | null,
): ToastInput {
  const byId = (id: string | null) => (id ? (players.find((p) => p.id === id) ?? null) : null);
  const label = squareName(board, event.position);
  if (event.type === "completed") {
    const who = byId(event.by);
    return { text: `${who?.display_name ?? "Someone"} got ${label}`, color: who?.color ?? null, position: event.position };
  }
  const completer = byId(event.previousBy);
  let undoer: Player | null = null;
  if (event.previousBy === meId || (host && event.previousBy === host.id)) undoer = host;
  else if (host && host.id === meId) undoer = completer;
  if (!undoer || undoer.id === meId) return { text: `${label} was undone`, color: null, position: event.position };
  return { text: `${undoer.display_name} undid ${label}`, color: undoer.color, position: event.position };
}

/**
 * The live board (status `active`). The board owns the screen: a slim top bar,
 * then the 5×5 grid. Completions are optimistic (useBoardState) and every
 * change from other phones shows as a cross-off plus a toast. Each new bingo
 * line celebrates once per phone. The album button (and each thumbnail in a
 * square's sheet) opens the story viewer over the live album so far.
 */
export function BoardScreen({
  game,
  players,
  squares,
  media,
  me,
  syncState,
  catchingUp = false,
  refresh,
  applyGame,
  applySquare,
}: BoardScreenProps) {
  const { settings, theme, systemTheme, update: updateSettings } = useSettings();
  const paletteTheme = paletteThemeFor(theme);
  useThemeColor(THEME_COLOR[theme]);
  const isHost = me !== null && me.user_id === game.host_user_id;
  const host = useMemo(() => players.find((p) => p.user_id === game.host_user_id) ?? null, [players, game.host_user_id]);

  const [toasts] = useState(() => createToastQueue());
  const [celebrations] = useState(() => createCelebrationQueue());
  const [tracker] = useState(() => createCelebrationTracker(game.id));
  const toast = useSyncExternalStore(toasts.subscribe, () => toasts.getState().current, () => null);
  const celebration = useSyncExternalStore(celebrations.subscribe, celebrations.getState, celebrations.getState);

  const onSettled = useCallback(
    (settled: Settled) => {
      // "The game is over" failures get one notice from the game screen (it outlives the board).
      if (settled.outcome === "failed" && settled.errorCode && !isGameOverError(settled.errorCode)) {
        toasts.push({ text: GAME_ERROR_COPY[settled.errorCode], tone: "error", position: settled.action.position });
      }
    },
    [toasts],
  );
  const boardState = useBoardState(game.id, squares, me, { applySquare, refresh, onSettled });
  const { board } = boardState;

  // The board can mount from a snapshot taken just before start_game (the
  // host's own start): fetch once so the free center and late changes arrive
  // without waiting for the next poll.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Toasts, haptics and celebrations from what changed on screen.
  const previous = useRef<DisplaySquare[] | null>(null);
  // Catching up, plus the first board after it: the server's answer to a cached snapshot.
  const settling = useRef(catchingUp);
  const meId = me?.id ?? null;
  useEffect(() => {
    const prev = previous.current;
    previous.current = board;
    const lines = completedLines(board);
    const blackout = isBlackout(board);
    if (prev === null) {
      // First board on this mount: whatever is done already is old news.
      tracker.seed(lines, blackout);
      return;
    }
    const oldNews = catchingUp || settling.current;
    settling.current = catchingUp;
    if (oldNews) {
      // Lines the server reports are old news; this phone's own taps still celebrate.
      const base = board.map((s) => s.base);
      tracker.seed(completedLines(base), isBlackout(base));
    }
    for (const event of diffBoards(prev, board, meId)) {
      if (event.type === "own_completed") pulse();
      else if (!oldNews) toasts.push(toastFor(event, board, players, meId, host));
    }
    const fresh = tracker.observe(lines, blackout);
    if (fresh) {
      // Credit the color of whoever crossed off the latest square in the line(s).
      let latest: DisplaySquare | null = null;
      for (const s of board) {
        if (!fresh.positions.includes(s.position) || !s.completed_by_player_id || !s.completed_at) continue;
        if (!latest || timestampMicros(latest.completed_at) < timestampMicros(s.completed_at)) latest = s;
      }
      const color = latest ? (players.find((p) => p.id === latest.completed_by_player_id)?.color ?? null) : null;
      celebrations.push(fresh, { color });
      doublePulse();
    }
  }, [board, meId, players, host, toasts, tracker, celebrations, catchingUp]);

  // "Jake added a photo to Skyline Chili": media from other phones after mount
  // (not what the first answer to a cached snapshot brings).
  const seenMedia = useRef<Set<string> | null>(null);
  useEffect(() => {
    const seen = seenMedia.current;
    if (seen === null || catchingUp) {
      seenMedia.current = new Set([...(seen ?? []), ...media.map((m) => m.id)]);
      return;
    }
    const news = mediaToasts(seen, media, { players, squares, meId });
    for (const m of media) seen.add(m.id);
    for (const t of news) toasts.push(t);
  }, [media, players, squares, meId, toasts, catchingUp]);

  // The host's extension shows at once (countdown, sheets); the returned row then takes over.
  const [extendOverlay, setExtendOverlay] = useState<ExtendOverlay | null>(null);
  const shownGame = useMemo(
    () =>
      extendOverlay
        ? { ...game, deadline_at: extendOverlay.deadline_at, deadline_extended_at: extendOverlay.deadline_extended_at }
        : game,
    [game, extendOverlay],
  );

  // "1 hour left.": once per phone per deadline value (bingo.deadlineToast.<gameId>), when the
  // countdown first drops under an hour, or on load if it already has. The clock ticks when the
  // countdown label changes, so the crossing is seen within seconds.
  const deadlineClock = useCountdown(shownGame.deadline_at).now;
  useEffect(() => {
    if (!deadlineClock) return;
    const deadlineAt = shownGame.deadline_at;
    if (!shouldShowDeadlineToast(readDeadlineToastShown(game.id), deadlineAt, deadlineClock)) return;
    noteDeadlineToastShown(game.id, deadlineAt);
    toasts.push(deadlineToast());
  }, [deadlineClock, shownGame.deadline_at, game.id, toasts]);

  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetOpenRef = useRef(false);
  useEffect(() => {
    sheetOpenRef.current = sheetOpen;
  }, [sheetOpen]);
  // Settings → Host → Extend: the settings sheet closes first, the extend sheet opens once it is gone.
  const sheetAfterClose = useRef<SheetState | null>(null);
  const [story, setStory] = useState<StoryState | null>(null);
  // A thumbnail tap closes the square sheet first and opens the story once the
  // sheet is gone, so the two never fight over focus, Escape or scroll lock.
  const storyAfterSheet = useRef<StoryState | null>(null);
  const openSheet = (next: SheetState) => {
    storyAfterSheet.current = null;
    sheetAfterClose.current = null;
    setSheet(next);
    setSheetOpen(true);
  };
  const closeSheet = () => {
    setSheetOpen(false);
    if (sheet?.kind === "square") boardState.clearOutcome(sheet.position);
  };

  const albumStory = (mediaId: string | null): StoryState | null => {
    const items = buildRecapItems(media, squares, players);
    if (items.length === 0) return null;
    const at = mediaId ? items.findIndex((item) => item.media.id === mediaId) : 0;
    return { items, names: recapFileNames(items), startIndex: Math.max(0, at) };
  };
  const openAlbum = () => {
    const next = albumStory(null);
    if (next) setStory(next);
    else openSheet({ kind: "album" });
  };
  const openMedia = (mediaId: string) => {
    const next = albumStory(mediaId);
    if (!next) return;
    storyAfterSheet.current = next;
    closeSheet();
  };
  const onSquareSheetGone = () => {
    const next = storyAfterSheet.current;
    storyAfterSheet.current = null;
    if (next) setStory(next);
  };

  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
  const endTheGame = async () => {
    setEnding(true);
    setEndError(null);
    try {
      // Status becomes ended: GameScreen swaps the board for the recap.
      const ended = await endGame({ game_id: game.id });
      track("game_ended", endedProps(board, players.length, ended, "host"));
      applyGame(ended);
    } catch (error) {
      setEndError(errorCopy(error));
      void refresh();
    } finally {
      setEnding(false);
    }
  };

  const [extendError, setExtendError] = useState<string | null>(null);
  const [extendRetry, setExtendRetry] = useState<string | null>(null);
  const [extendKey, setExtendKey] = useState(0);
  const extendSeq = useRef(0);
  const openExtend = () => {
    setExtendError(null);
    setExtendRetry(null);
    sheetAfterClose.current = { kind: "extend" };
    setSheetOpen(false);
  };
  const onSheetGone = () => {
    const next = sheetAfterClose.current;
    sheetAfterClose.current = null;
    if (!next) return;
    setExtendKey((k) => k + 1);
    openSheet(next);
  };
  // Host only (extend_deadline enforces host, live, once and the 1-day cap): optimistic, then reconciled.
  const saveExtension = async (iso: string) => {
    const id = ++extendSeq.current;
    setExtendOverlay({ deadline_at: iso, deadline_extended_at: new Date().toISOString(), seq: id });
    setExtendError(null);
    setSheetOpen(false);
    try {
      applyGame(await extendDeadline(game.id, iso));
    } catch (error) {
      const message = errorCopy(error);
      void refresh();
      if (sheetOpenRef.current) {
        toasts.push({ text: message, tone: "error" });
      } else {
        // Give the choice back with the reason.
        setExtendError(message);
        setExtendRetry(iso);
        setExtendKey((k) => k + 1);
        openSheet({ kind: "extend" });
      }
    } finally {
      setExtendOverlay((o) => (o?.seq === id ? null : o));
    }
  };

  const selected = sheet?.kind === "square" ? board.find((s) => s.position === sheet.position) : undefined;
  const selectedMedia = selected ? media.filter((m) => m.square_id === selected.id) : NO_MEDIA;
  const current = celebration.current;
  const highlight = current && current.phase === "highlight" ? current.positions : NO_CELLS;

  const onToast = (t: Toast) => {
    toasts.dismiss(t.id);
    if (t.target === "players") openSheet({ kind: "players" });
    else if (t.position !== null) openSheet({ kind: "square", position: t.position });
  };

  return (
    <main
      className="board flex min-h-dvh w-full min-w-0 flex-1 flex-col overflow-x-hidden"
      data-theme={theme}
      data-text-size={settings.textSize}
      data-square-size={settings.squareSize}
      data-testid="game-screen"
      data-status="active"
      data-sync-state={syncState}
      data-celebrations={celebration.shown}
    >
      <TopBar
        name={game.name}
        players={players}
        theme={paletteTheme}
        syncState={syncState}
        pendingCount={boardState.pendingCount}
        mediaCount={media.length}
        onPlayers={() => openSheet({ kind: "players" })}
        onSettings={() => openSheet({ kind: "settings" })}
        onAlbum={openAlbum}
        onRetry={() => {
          boardState.retry();
          void refresh();
        }}
        toast={toast}
        onToast={onToast}
        deadlineAt={shownGame.deadline_at}
      />

      <div className="flex min-w-0 flex-1 flex-col items-center pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[max(0.375rem,env(safe-area-inset-left))] pr-[max(0.375rem,env(safe-area-inset-right))] pt-2">
        <section
          className="w-full min-w-0"
          // Full width on phones; on wide or landscape screens no taller than the viewport.
          style={{ maxWidth: "min(36rem, max(18rem, calc(100dvh - 5.5rem)))" }}
          aria-label={`${game.name} board`}
        >
          <BoardGrid
            board={board}
            players={players}
            theme={paletteTheme}
            highlight={highlight}
            onSelect={(position) => openSheet({ kind: "square", position })}
          />
          <p className="mt-2 px-1 text-center font-board text-base text-board-muted" data-testid="board-progress">
            {progressLine(board)}
          </p>
        </section>
      </div>

      <Celebration celebration={current} theme={paletteTheme} onDismiss={celebrations.dismiss} />

      <Sheet
        open={sheetOpen && sheet?.kind === "square" && selected !== undefined}
        onClose={closeSheet}
        title={squareTitle(selected)}
        testId="square-sheet"
        onExitComplete={onSquareSheetGone}
      >
        {selected ? (
          <SquareSheetBody
            game={game}
            square={selected}
            players={players}
            me={me}
            isHost={isHost}
            theme={paletteTheme}
            outcome={boardState.outcomeFor(selected.position)}
            syncState={syncState}
            media={selectedMedia}
            onOpenMedia={openMedia}
            onComplete={() => {
              boardState.complete(selected.position);
              setSheetOpen(false);
            }}
            onIncrement={() => boardState.increment(selected.position)}
            onUndo={() => boardState.undo(selected.position)}
          />
        ) : null}
      </Sheet>

      <Sheet
        open={sheetOpen && sheet?.kind === "players"}
        onClose={closeSheet}
        title="Players"
        testId="players-sheet"
      >
        <PlayersSheetBody game={shownGame} players={players} board={board} meId={meId} theme={paletteTheme} />
        {/* Home on purpose: `/` stays home (with a "Back to your game" row) instead of jumping back here.
            The sheet closes first: the router keeps this screen's state for the way back. */}
        <Link
          href="/"
          onClick={() => {
            goHomeOnPurpose(game.id);
            setSheetOpen(false);
          }}
          data-testid="board-home"
          className="mb-1 inline-flex min-h-11 items-center text-lg text-ink-soft underline decoration-ink-faint decoration-2 underline-offset-4"
        >
          Back to home
        </Link>
      </Sheet>

      <Sheet
        open={sheetOpen && sheet?.kind === "settings"}
        onClose={closeSheet}
        title="Settings"
        testId="settings-sheet"
        onExitComplete={onSheetGone}
      >
        <SettingsSheetBody
          game={shownGame}
          settings={settings}
          theme={theme}
          systemTheme={systemTheme}
          onChange={updateSettings}
          // Host only (the gear is the one way in; extend_deadline / end_game enforce it again).
          host={
            isHost
              ? { ending, error: endError, onEndGame: () => void endTheGame(), onExtend: openExtend }
              : undefined
          }
        />
      </Sheet>

      <Sheet
        open={sheetOpen && sheet?.kind === "extend" && isHost}
        onClose={closeSheet}
        title="Extend deadline"
        testId="extend-sheet"
      >
        <ExtendDeadlineForm
          key={extendKey}
          currentIso={game.deadline_at}
          initialIso={extendRetry}
          error={extendError}
          onSave={(iso) => void saveExtension(iso)}
        />
      </Sheet>

      <Sheet open={sheetOpen && sheet?.kind === "album"} onClose={closeSheet} title="Album" testId="album-sheet">
        <p className="pb-2 text-xl leading-7" data-testid="album-empty">
          No photos yet — complete a square and add one from its sheet.
        </p>
      </Sheet>

      {story ? (
        <RecapStory
          items={story.items}
          names={story.names}
          startIndex={story.startIndex}
          getSignedUrls={getSignedUrls}
          onClose={() => setStory(null)}
        />
      ) : null}
    </main>
  );
}

/**
 * `game_ended` analytics: counts only (see lib/analytics.ts). `by: "auto"` is
 * the deadline passing (sent from the host's phone by GameScreen); such a game
 * ends at its `deadline_at`. `by: "blackout"` is the 25th square ending the
 * game on the server (sent by GameScreen from the phone that crossed it off).
 */
export function endedProps(
  board: readonly { position: number; completed_at: string | null }[],
  playerCount: number,
  game: Game,
  by: "host" | "auto" | "blackout",
) {
  const started = game.started_at ? Date.parse(game.started_at) : NaN;
  const endedAt = game.ended_at ?? (by === "auto" ? game.deadline_at : null);
  const ended = endedAt ? Date.parse(endedAt) : Date.now();
  const minutes = (ended - started) / 60_000;
  return {
    squares_completed: board.filter((s) => s.completed_at !== null).length,
    lines: completedLines(board).length,
    blackout: isBlackout(board),
    duration_min: Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : 0,
    player_count: playerCount,
    by,
  };
}

const NO_CELLS: readonly number[] = [];
const NO_MEDIA: readonly Media[] = [];
