"use client";

import { Images, Settings } from "lucide-react";
import { Fragment, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Toasts } from "@/components/board/Toasts";
import { isUnderOneHour } from "@/lib/deadline/format";
import { useCountdown } from "@/lib/deadline/useNow";
import type { Toast } from "@/lib/game/toasts";
import type { Player } from "@/lib/game/types";
import type { SyncState } from "@/lib/game/useGame";
import { playerColor, type PaletteTheme } from "@/lib/palette";

const ICON_BUTTON =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-[10px] text-board-ink " +
  "focus-visible:outline-[3px] focus-visible:-outline-offset-[3px] focus-visible:outline-board-ink active:bg-board-surface";

/** A resync must have been showing `syncing` this long before the soft dot appears. */
export const SYNCING_MARK_DELAY_MS = 400;

/**
 * A game name longer than this many characters gets a width floor next to the
 * countdown (`TITLE_FLOOR`), so a long name never truncates to two letters.
 */
export const TITLE_MIN_CHARS = 8;

/**
 * The title's floor: about TITLE_MIN_CHARS characters plus the ellipsis in the
 * board's title face (20 px marker on the whiteboard, "Saturday…" ≈ 4.9em;
 * condensed caps on the scoreboard, "SATURDAY…" ≈ 3.9em), but never so wide
 * that the countdown's first unit (at most "59m" plus its gap, under 1.75rem)
 * loses its room.
 */
const TITLE_FLOOR =
  "min-w-[min(5em,calc(100%-1.75rem))] in-data-[theme=scoreboard]:min-w-[min(4em,calc(100%-1.75rem))]";

/**
 * What the top bar says about sync. `none` when live; `syncing` (a soft dot)
 * once a sync has lasted past SYNCING_MARK_DELAY_MS; `pending` (hollow dot +
 * "sending") while taps wait in the queue; `offline` (muted dot + "offline")
 * when the last resync failed or the browser reports no connection.
 */
export type SyncMark = "none" | "syncing" | "pending" | "offline";

export function syncMarkFor({
  syncState,
  online,
  pendingCount,
  syncingLong,
}: {
  syncState: SyncState;
  /** `navigator.onLine`. */
  online: boolean;
  pendingCount: number;
  /** `syncState` has been `syncing` for longer than SYNCING_MARK_DELAY_MS. */
  syncingLong: boolean;
}): SyncMark {
  if (syncState === "offline" || !online) return "offline";
  if (pendingCount > 0) return "pending";
  if (syncState === "syncing" && syncingLong) return "syncing";
  return "none";
}

/** True once `active` has stayed true for `delayMs`; false again as soon as it drops. */
function useHeldFor(active: boolean, delayMs: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => setHeld(true), delayMs);
    return () => {
      window.clearTimeout(timer);
      setHeld(false);
    };
  }, [active, delayMs]);
  return active && held;
}

function subscribeOnline(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}
const isOnline = () => navigator.onLine;
const assumeOnline = () => true;

/**
 * "4h 12m" right after the game name: small, muted, the sync mark's type size.
 * Under an hour it takes the board's ink color (`data-urgent`), still small.
 * Renders nothing until mounted (hydration-safe) and once the deadline has
 * passed (the game screen moves to the recap then). Tapping it opens Players,
 * where the deadline line and the host's Extend live.
 *
 * Never broken mid-label (`white-space: nowrap`, each unit a box of its own).
 * When a long name at its floor leaves too little room for the whole label,
 * the trailing unit drops onto a second line that is clipped, so only whole
 * units show: "23h 59m" reads "23h", "6d 23h" reads "6d" (one-unit labels such
 * as "45m" never change). The full label stays the text and the accessible
 * name. The tap area stays at least 44 px wide (`before:`), whatever the width.
 */
function DeadlineCountdown({ deadlineAt, hidden, onTap }: { deadlineAt: string | null; hidden: boolean; onTap: () => void }) {
  const { now, countdown } = useCountdown(deadlineAt);
  if (!now || !countdown || countdown.tier === "passed" || !deadlineAt) return null;
  const urgent = isUnderOneHour(new Date(deadlineAt), now);
  const units = countdown.label.split(" ");
  return (
    <button
      type="button"
      onClick={onTap}
      tabIndex={hidden ? -1 : undefined}
      aria-hidden={hidden || undefined}
      aria-label={`Time left: ${countdown.label}. Players`}
      data-testid="deadline-countdown"
      data-tier={countdown.tier}
      data-urgent={urgent ? "true" : undefined}
      className={`relative flex h-11 flex-[0_1_auto] items-center pl-1 font-sans text-base whitespace-nowrap tabular-nums transition-opacity duration-200 before:absolute before:inset-y-0 before:left-1/2 before:w-[max(100%,2.75rem)] before:-translate-x-1/2 motion-reduce:transition-none ${
        urgent ? "text-board-ink" : "text-board-muted"
      } ${hidden ? "pointer-events-none opacity-0" : "opacity-100"}`}
    >
      {/* One 44 px line of whole units; a unit that does not fit wraps below it and is clipped. */}
      <span className="flex h-11 flex-wrap content-start gap-x-[0.3em] overflow-hidden leading-11">
        {units.map((unit, i) => (
          <Fragment key={i}>
            {i > 0 ? " " : null}
            <span>{unit}</span>
          </Fragment>
        ))}
      </span>
    </button>
  );
}

/**
 * The only thing above the grid: game name, a quiet countdown to the deadline
 * (see DeadlineCountdown), a quiet sync mark (see SyncMark),
 * players, settings, album (with a small count once there is media). A toast
 * takes the game name's place while it shows (see Toasts); nothing else moves.
 *
 * No layout shift for the frequent case: the soft syncing dot lives in a
 * fixed slot that is always reserved at the end of the title (it only fades
 * in and out). The offline / sending mark is a 44px tap target (retry) and
 * only takes room from the truncating title; the buttons never move.
 *
 * Title and countdown share the slot: the title (flex basis 0, at most its own
 * width) grows into whatever the whole countdown leaves. When even that is not
 * room enough, a name longer than TITLE_MIN_CHARS keeps its floor (TITLE_FLOOR)
 * and the countdown gives way instead, down to its first unit (see
 * DeadlineCountdown); only then does the title shrink below the floor.
 */
export function TopBar({
  name,
  players,
  theme,
  syncState,
  pendingCount,
  mediaCount,
  onPlayers,
  onSettings,
  onAlbum,
  onRetry,
  toast = null,
  onToast,
  deadlineAt = null,
}: {
  name: string;
  players: Player[];
  theme: PaletteTheme;
  syncState: SyncState;
  pendingCount: number;
  /** Photos and videos in the album so far. */
  mediaCount: number;
  onPlayers: () => void;
  onSettings: () => void;
  onAlbum: () => void;
  onRetry: () => void;
  /** The toast showing now (it covers the title), if any. */
  toast?: Toast | null;
  onToast?: (toast: Toast) => void;
  /** The game's `deadline_at`, counted down after the name. */
  deadlineAt?: string | null;
}) {
  const dots = players.slice(0, 4);
  const names = useMemo(() => players.map((p) => p.display_name), [players]);
  const online = useSyncExternalStore(subscribeOnline, isOnline, assumeOnline);
  const syncingLong = useHeldFor(syncState === "syncing", SYNCING_MARK_DELAY_MS);
  const mark = syncMarkFor({ syncState, online, pendingCount, syncingLong });
  const offline = mark === "offline";
  return (
    <header className="flex min-w-0 shrink-0 items-center gap-0.5 pb-0.5 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.25rem,env(safe-area-inset-right))] pt-[max(0.25rem,env(safe-area-inset-top))]">
      {/* Centre slot: the title, or the current toast over it (same box, so no layout shift). */}
      <div className="relative flex min-w-0 flex-1 items-center self-stretch">
        <h1
          className={`max-w-max flex-[1_1_0%] truncate font-board text-xl leading-tight transition-opacity duration-200 motion-reduce:transition-none ${
            Array.from(name).length > TITLE_MIN_CHARS ? TITLE_FLOOR : "min-w-0"
          } ${toast ? "opacity-0" : "opacity-100"}`}
          data-testid="board-title"
        >
          {name}
        </h1>
        <DeadlineCountdown deadlineAt={deadlineAt} hidden={toast !== null} onTap={onPlayers} />
        <Toasts toast={toast} theme={theme} names={names} onTap={(t) => onToast?.(t)} />
      </div>

      {/* Always in the layout; only its opacity changes. Decorative: a slow sync needs no announcement. */}
      <span
        aria-hidden
        data-testid="sync-dot"
        data-visible={mark === "syncing"}
        className={`mx-1 inline-block size-1.5 shrink-0 rounded-full bg-board-muted transition-opacity duration-300 motion-reduce:transition-none ${
          mark === "syncing" ? "opacity-70" : "opacity-0"
        }`}
      />
      {mark === "pending" || offline ? (
        <button
          type="button"
          onClick={onRetry}
          data-testid="sync-mark"
          data-sync-state={offline ? "offline" : syncState}
          data-pending-count={pendingCount}
          aria-label={`${offline ? "Offline" : "Sending"}${pendingCount ? `, ${pendingCount} waiting` : ""}. Retry`}
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 px-2 font-sans text-base text-board-muted"
        >
          <span
            aria-hidden
            className={`inline-block size-2.5 rounded-full border-[1.5px] border-board-muted ${
              offline ? "bg-board-muted" : "bg-transparent"
            }`}
          />
          <span aria-hidden>{offline ? "offline" : "sending"}</span>
        </button>
      ) : null}

      <button
        type="button"
        onClick={onPlayers}
        data-testid="players-button"
        aria-label={`Players: ${players.length}`}
        className={`${ICON_BUTTON} w-auto gap-1.5 px-2`}
      >
        <span aria-hidden className="flex items-center">
          {dots.map((p, i) => (
            <span
              key={p.id}
              className={`inline-block size-4 rounded-full border-2 border-board-bg ${i > 0 ? "-ml-1.5" : ""}`}
              style={{ backgroundColor: playerColor(p.color, theme).fill }}
            />
          ))}
        </span>
        <span className="font-board text-lg leading-none tabular-nums" data-testid="players-count">
          {players.length}
        </span>
      </button>

      <button type="button" onClick={onSettings} aria-label="Settings" data-testid="settings-button" className={ICON_BUTTON}>
        <Settings aria-hidden className="size-6" strokeWidth={2.25} />
      </button>

      <button
        type="button"
        onClick={onAlbum}
        aria-label={mediaCount > 0 ? `Album: ${mediaCount} so far` : "Album"}
        data-testid="album-button"
        data-count={mediaCount}
        className={`${ICON_BUTTON} relative`}
      >
        <Images aria-hidden className="size-6" strokeWidth={2.25} />
        {mediaCount > 0 ? (
          <span
            aria-hidden
            data-testid="album-count"
            className="absolute right-0.5 top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-board-ink px-1 font-sans text-[11px] font-semibold leading-none text-board-bg tabular-nums"
          >
            {mediaCount > 99 ? "99+" : mediaCount}
          </span>
        ) : null}
      </button>
    </header>
  );
}
