import type { GameSnapshot } from "@/lib/game/realtime";
import { effectiveStatus, type GameStatus } from "@/lib/game/types";
import { sameOriginUrls } from "@/lib/pwa/registration";
import { readLocal, removeLocal, writeLocal } from "@/lib/storage/local";

/**
 * Instant return (CLAUDE.md > Night-out realities).
 *
 * - `bingo.activeGame`: the game this phone last showed in `lobby` / `active`,
 *   with a full snapshot (game, players, squares, media) so `/game/<id>` can
 *   draw the board before the network answers, and `/` can jump straight to
 *   a live board. Saved by the game screen, cleared when the game ends, when
 *   the server says "not found / not a member", and on Leave.
 * - `bingo.lastEnded`: the last game this phone saw end, so the next open of
 *   `/` lands on its recap once.
 * - A per-tab `sessionStorage` flag marks a deliberate Home visit (Leave /
 *   Home links), so `/` never bounces back to the game in that tab.
 *
 * Everything read back is validated: a corrupt or foreign value is ignored.
 * Records saved before the host-set deadline existed are upgraded on read
 * (`upgradeLegacyRecord`). Nothing here is game logic; the server still
 * decides everything once it answers (its rows win over the snapshot).
 */

export const ACTIVE_GAME_KEY = "bingo.activeGame";
export const LAST_ENDED_KEY = "bingo.lastEnded";
/** sessionStorage key: this tab went Home on purpose. */
export const STAY_HOME_KEY = "bingo.stayHome";

export const ACTIVE_GAME_VERSION = 1;
/** The game screen batches saves (every square change re-saves the snapshot). */
export const SAVE_DEBOUNCE_MS = 300;
/** `bingo.lastEnded` sends the next open to the recap only within this window. */
export const LAST_ENDED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A lobby nobody has looked at for this long no longer gets the "Back to your game" row. */
export const LOBBY_RECORD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type ActiveGameRecord = {
  version: typeof ACTIVE_GAME_VERSION;
  gameId: string;
  joinCode: string;
  name: string;
  /** Effective status when saved. An ended game is never saved (it clears the record). */
  status: Exclude<GameStatus, "ended">;
  /** The game's `deadline_at` when saved: an active game is over once it passes. */
  deadlineAt: string;
  expiresAt: string;
  /** ISO time of the save (this phone's clock). */
  savedAt: string;
  /** The anonymous user whose board this is, so the board can draw before the session check finishes. */
  userId: string | null;
  snapshot: GameSnapshot;
};

export type LastEndedRecord = {
  gameId: string;
  /** ISO time this phone saw the game end (this phone's clock, like the 24 h window it is compared with). */
  endedAt: string;
  /** An open already landed on the recap. */
  consumed: boolean;
};

// ---------------------------------------------------------------------------
// Validation (localStorage may hold anything: an old version, a hand edit, junk)

type Check = (value: unknown) => boolean;

const str: Check = (v) => typeof v === "string";
const strOrNull: Check = (v) => v === null || typeof v === "string";
/** A column older snapshots may not have at all. */
const optional =
  (check: Check): Check =>
  (v) =>
    v === undefined || check(v);
const int: Check = (v) => typeof v === "number" && Number.isInteger(v);
const bool: Check = (v) => typeof v === "boolean";
const oneOf =
  (...values: string[]): Check =>
  (v) =>
    typeof v === "string" && values.includes(v);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasShape(value: unknown, shape: Record<string, Check>): boolean {
  if (!isRecord(value)) return false;
  return Object.entries(shape).every(([key, check]) => check(value[key]));
}

const GAME_SHAPE: Record<string, Check> = {
  id: str,
  join_code: str,
  name: str,
  host_user_id: str,
  status: oneOf("lobby", "active", "ended"),
  free_center: bool,
  created_at: str,
  started_at: strOrNull,
  ended_at: strOrNull,
  deadline_at: str,
  deadline_extended_at: optional(strOrNull),
  expires_at: str,
};

const PLAYER_SHAPE: Record<string, Check> = {
  id: str,
  game_id: str,
  user_id: str,
  display_name: str,
  color: int,
  is_ready: bool,
  joined_at: str,
};

const SQUARE_SHAPE: Record<string, Check> = {
  id: str,
  game_id: str,
  position: (v) => int(v) && (v as number) >= 0 && (v as number) <= 24,
  label: str,
  details: str,
  target_count: int,
  current_count: int,
  completed_by_player_id: strOrNull,
  completed_at: strOrNull,
  updated_at: str,
};

const MEDIA_SHAPE: Record<string, Check> = {
  id: str,
  game_id: str,
  square_id: str,
  player_id: str,
  storage_path: str,
  kind: oneOf("photo", "video"),
  created_at: str,
};

function rowsOf(value: unknown, shape: Record<string, Check>, gameId: string, max: number): boolean {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every((row) => hasShape(row, shape) && (row as Record<string, unknown>).game_id === gameId)
  );
}

/** A complete, consistent snapshot of one game (every row belongs to it). */
export function isGameSnapshot(value: unknown, gameId: string): value is GameSnapshot {
  if (!isRecord(value)) return false;
  return (
    hasShape(value.game, GAME_SHAPE) &&
    (value.game as Record<string, unknown>).id === gameId &&
    rowsOf(value.players, PLAYER_SHAPE, gameId, 50) &&
    rowsOf(value.squares, SQUARE_SHAPE, gameId, 25) &&
    rowsOf(value.media, MEDIA_SHAPE, gameId, 5000)
  );
}

// Legacy records ---------------------------------------------------------------
// Builds from before the host-set deadline saved the fixed 24-hour end as
// `autoEndAt` on the record and `auto_end_at` on the snapshot's game, and had no
// `deadline_at`. The migration that introduced the deadline gave every existing
// game deadline_at = coalesce(auto_end_at, started_at + 24 h, created_at + 24 h);
// such a record gets that same value here, so the cached board still draws (and
// an active game still ends on time) until the server answers. Only read, never
// written: the next save stores the current shape.

export const LEGACY_RECORD_END_KEY = "autoEndAt";
export const LEGACY_GAME_END_KEY = "auto_end_at";
const LEGACY_DEFAULT_LENGTH_MS = 24 * 60 * 60 * 1000;

function legacyDeadline(game: Record<string, unknown>): string | null {
  const end = game[LEGACY_GAME_END_KEY];
  if (typeof end === "string") return end;
  const from = typeof game.started_at === "string" ? game.started_at : game.created_at;
  const ms = typeof from === "string" ? Date.parse(from) : Number.NaN;
  return Number.isNaN(ms) ? null : new Date(ms + LEGACY_DEFAULT_LENGTH_MS).toISOString();
}

/** A record in the current shape: legacy ones mapped (see above), anything else as is. */
export function upgradeLegacyRecord(value: Record<string, unknown>): Record<string, unknown> {
  if ("deadlineAt" in value || !(LEGACY_RECORD_END_KEY in value)) return value;
  const snapshot = value.snapshot;
  if (!isRecord(snapshot) || !isRecord(snapshot.game) || "deadline_at" in snapshot.game) return value;
  const deadline = legacyDeadline(snapshot.game);
  if (deadline === null) return value;
  const game: Record<string, unknown> = { ...snapshot.game, deadline_at: deadline };
  delete game[LEGACY_GAME_END_KEY];
  const record: Record<string, unknown> = { ...value, deadlineAt: deadline, snapshot: { ...snapshot, game } };
  delete record[LEGACY_RECORD_END_KEY];
  return record;
}

export function parseActiveGame(raw: unknown): ActiveGameRecord | null {
  if (!isRecord(raw) || raw.version !== ACTIVE_GAME_VERSION) return null;
  const value = upgradeLegacyRecord(raw);
  const ok =
    hasShape(value, {
      gameId: str,
      joinCode: str,
      name: str,
      status: oneOf("lobby", "active"),
      deadlineAt: str,
      expiresAt: str,
      savedAt: str,
      userId: strOrNull,
    }) && isGameSnapshot(value.snapshot, value.gameId as string);
  return ok ? (value as ActiveGameRecord) : null;
}

export function parseLastEnded(value: unknown): LastEndedRecord | null {
  return hasShape(value, { gameId: str, endedAt: str, consumed: bool }) ? (value as LastEndedRecord) : null;
}

// ---------------------------------------------------------------------------
// Pure rules

/** The record for a snapshot, or null when the game is (effectively) over and must not be saved. */
export function toActiveGameRecord(
  snapshot: GameSnapshot,
  userId: string | null,
  now: Date = new Date(),
): ActiveGameRecord | null {
  const status = effectiveStatus(snapshot.game, now);
  if (status === "ended") return null;
  const { game, players, squares, media } = snapshot;
  return {
    version: ACTIVE_GAME_VERSION,
    gameId: game.id,
    joinCode: game.join_code,
    name: game.name,
    status,
    deadlineAt: game.deadline_at,
    expiresAt: game.expires_at,
    savedAt: now.toISOString(),
    userId,
    snapshot: { game, players, squares, media },
  };
}

function time(iso: string | null): number {
  return iso === null ? Number.NaN : Date.parse(iso);
}

/**
 * Still worth returning to: an active game before its deadline, or a lobby
 * looked at in the last day; never past the game's 30-day expiry.
 */
export function isReturnable(record: ActiveGameRecord, now: number): boolean {
  const expires = time(record.expiresAt);
  if (!(now < expires)) return false;
  if (record.status === "active") {
    const deadline = time(record.deadlineAt);
    return Number.isNaN(deadline) || now < deadline;
  }
  const saved = time(record.savedAt);
  return !Number.isNaN(saved) && now - saved < LOBBY_RECORD_MAX_AGE_MS;
}

/** The recap is still due: not landed on yet and seen ending less than a day ago. */
export function isRecapDue(record: LastEndedRecord, now: number): boolean {
  if (record.consumed) return false;
  const ended = time(record.endedAt);
  return !Number.isNaN(ended) && now - ended < LAST_ENDED_MAX_AGE_MS;
}

export type OpenInput = {
  active: ActiveGameRecord | null;
  lastEnded: LastEndedRecord | null;
  /** This page load started at `/` and has not shown a game yet (an app open, not in-app navigation). */
  freshOpen: boolean;
  /** This tab went Home on purpose (Leave / Home links, `?stay=1`). */
  stay: boolean;
  now: number;
};

export type OpenDecision =
  /** Go to `/game/<gameId>`: the live board (`active`) or the recap once (`ended`). */
  | { kind: "game"; gameId: string; via: "active" | "ended" }
  /** Show home; `back` feeds the quiet "Back to your game" row. */
  | { kind: "home"; back: ActiveGameRecord | null };

/**
 * What `/` does on an open. Only a live (`active`) game is jumped to; a lobby
 * gets the "Back to your game" row instead, so home stays reachable while
 * friends are still joining. Without a returnable game, a game seen ending in
 * the last day opens its recap once.
 */
export function decideOpen({ active, lastEnded, freshOpen, stay, now }: OpenInput): OpenDecision {
  const endedHere = lastEnded !== null && active !== null && lastEnded.gameId === active.gameId;
  const back = active && !endedHere && isReturnable(active, now) ? active : null;
  if (freshOpen && !stay) {
    if (back && back.status === "active") return { kind: "game", gameId: back.gameId, via: "active" };
    if (!back && lastEnded && isRecapDue(lastEnded, now)) return { kind: "game", gameId: lastEnded.gameId, via: "ended" };
  }
  return { kind: "home", back };
}

// ---------------------------------------------------------------------------
// Storage

/** Games whose screen was left with Leave: a save already scheduled must not bring the record back. */
const suppressed = new Set<string>();

export function readActiveGame(): ActiveGameRecord | null {
  return parseActiveGame(readLocal(ACTIVE_GAME_KEY));
}

export function readActiveGameFor(gameId: string): ActiveGameRecord | null {
  const record = readActiveGame();
  return record && record.gameId === gameId ? record : null;
}

export function saveActiveGame(record: ActiveGameRecord): void {
  if (suppressed.has(record.gameId)) return;
  writeLocal(ACTIVE_GAME_KEY, record);
}

/** Forgets the record if it is this game's (or unreadable); another game's record stays. */
export function clearActiveGame(gameId: string): void {
  const raw = readLocal(ACTIVE_GAME_KEY) as unknown;
  if (raw === null) return;
  const record = parseActiveGame(raw);
  if (!record || record.gameId === gameId) removeLocal(ACTIVE_GAME_KEY);
}

export function readLastEnded(): LastEndedRecord | null {
  return parseLastEnded(readLocal(LAST_ENDED_KEY));
}

/** A game this phone was in just ended: drop its record and let the next open land on the recap once. */
export function noteGameEnded(gameId: string, now: Date = new Date()): void {
  clearActiveGame(gameId);
  writeLocal(LAST_ENDED_KEY, { gameId, endedAt: now.toISOString(), consumed: false });
}

/** The recap of `gameId` was opened (or left on purpose): the next open goes home. */
export function consumeLastEnded(gameId: string): void {
  const record = readLastEnded();
  if (record && record.gameId === gameId && !record.consumed) writeLocal(LAST_ENDED_KEY, { ...record, consumed: true });
}

// ---------------------------------------------------------------------------
// Deliberate Home visits (per tab)

function sessionStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Set by the Leave / Home links: `/` shows home in this tab instead of jumping back. */
export function markStayHome(): void {
  try {
    sessionStore()?.setItem(STAY_HOME_KEY, "1");
  } catch {
    // Unavailable: the in-app navigation check still keeps `/` from bouncing.
  }
}

/** "Back to your game": the deliberate Home visit is over. */
export function clearStayHome(): void {
  try {
    sessionStore()?.removeItem(STAY_HOME_KEY);
  } catch {
    // Unavailable: nothing to clear.
  }
}

export function isStayHome(search: string = typeof window === "undefined" ? "" : window.location.search): boolean {
  let flagged = false;
  try {
    flagged = sessionStore()?.getItem(STAY_HOME_KEY) === "1";
  } catch {
    flagged = false;
  }
  return flagged || new URLSearchParams(search).get("stay") === "1";
}

/** Leave in the lobby (after `leave_game` removed the membership): forget the game here and stay home. */
export function leaveToHome(gameId: string): void {
  suppressed.add(gameId);
  clearActiveGame(gameId);
  markStayHome();
}

/** Home from the board / recap: keep the game (the row brings it back), just don't bounce. */
export function goHomeOnPurpose(gameId: string, { ended = false }: { ended?: boolean } = {}): void {
  if (ended) consumeLastEnded(gameId);
  markStayHome();
}

// ---------------------------------------------------------------------------
// Opens vs in-app navigation (per page load)

let gameShown = false;

/**
 * A game screen mounted in this page load. From now on a visit to `/` is in-app
 * navigation, not an open; a recap that was due for this game has been seen;
 * and saves for it are allowed again (after a Leave).
 */
export function noteGameScreenShown(gameId: string): void {
  gameShown = true;
  suppressed.delete(gameId);
  consumeLastEnded(gameId);
}

/**
 * Inline script for home's server HTML. It runs while the HTML is parsed,
 * before home first paints: if this phone has a game record (or a recap due),
 * home stays invisible until the client has decided where to go, so a
 * returning player never sees it flash. Otherwise (first visit, no game) home
 * paints straight from the server HTML, which is also all the offline shell
 * shows before any JavaScript runs. Deliberately coarse: hiding when nothing
 * happens only delays home until hydration. Never throws.
 */
export const HOME_GUARD_SCRIPT =
  "(function(){try{var w=document.currentScript&&document.currentScript.parentElement;if(!w)return;" +
  `var e=null;try{e=JSON.parse(localStorage.getItem(${JSON.stringify(LAST_ENDED_KEY)})||"null")}catch(x){}` +
  `if(localStorage.getItem(${JSON.stringify(ACTIVE_GAME_KEY)})!==null||(e&&e.consumed===false))w.style.visibility="hidden"` +
  "}catch(x){}})();";

/** This page load started at `/` (app launch, reload, typed URL) and has not shown a game yet. */
export function isFreshOpen(): boolean {
  if (gameShown || typeof window === "undefined") return false;
  try {
    const [entry] = performance.getEntriesByType("navigation");
    const start = new URL(entry?.name ?? window.location.href, window.location.origin);
    return start.pathname === "/";
  } catch {
    return window.location.pathname === "/";
  }
}

// ---------------------------------------------------------------------------
// Offline copy of the game page

/**
 * Asks the service worker to cache this game page's HTML (and whatever this
 * page has loaded so far), through its existing `WARM` message. Pages reached
 * by client-side navigation (join → game, `/` → game) are never fetched as a
 * document, so without this a reload on no signal would find nothing cached.
 * The worker re-checks every URL against its policy (no game data is cached).
 */
export function warmPageForOffline(url: string): void {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.ready
      .then((registration) => {
        const loaded = performance.getEntriesByType("resource").map((entry) => entry.name);
        registration.active?.postMessage({
          type: "WARM",
          pages: [url],
          assets: sameOriginUrls(loaded, window.location.origin),
        });
      })
      .catch(() => {});
  } catch {
    // No worker: nothing to warm.
  }
}
