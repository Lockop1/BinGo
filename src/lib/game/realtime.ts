import type { RealtimeChannel, RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import type { Game, GameStatus, Player, Square } from "@/lib/game/types";
import { createClient } from "@/lib/supabase/client";

/**
 * Live sync for one game: pure merge functions (unit-tested in
 * realtime.test.ts) plus the Realtime channel wiring used by useGame.
 *
 * Realtime is an accelerator, never the only path: useGame also resyncs with a
 * full refetch on (re)subscribe, tab focus, `online` and a gentle poll, so a
 * phone that missed events (bad signal, backgrounded tab) still converges.
 */

export type GameSnapshot = { game: Game; players: Player[]; squares: Square[] };

/** A `postgres_changes` event reduced to what the merge functions need. */
export type RowChange<T> =
  | { type: "INSERT" | "UPDATE"; row: T }
  | { type: "DELETE"; old: Partial<T> };

// ---------------------------------------------------------------------------
// Timestamps

const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * Microseconds since the epoch for a Postgres `timestamptz` string, keeping
 * the sub-millisecond digits `Date.parse` drops (two edits in the same
 * millisecond must still order correctly). Strings without an offset are read
 * as UTC. Returns NaN for anything unparseable.
 */
export function timestampMicros(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const m = TIMESTAMP.exec(value.trim());
  if (!m) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? Number.NaN : ms * 1000;
  }
  const [, y, mo, d, h, mi, s, frac = "", zone] = m;
  let ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (zone && zone.toUpperCase() !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    const offsetMinutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || "0");
    ms -= sign * offsetMinutes * 60_000;
  }
  const micros = Number(frac.slice(0, 6).padEnd(6, "0"));
  return ms * 1000 + micros;
}

/** True when `incoming` is strictly newer than `held` (by `updated_at`). */
export function isNewerSquare(incoming: Pick<Square, "updated_at">, held: Pick<Square, "updated_at">): boolean {
  const a = timestampMicros(incoming.updated_at);
  const b = timestampMicros(held.updated_at);
  if (Number.isNaN(b)) return true;
  if (Number.isNaN(a)) return false;
  return a > b;
}

// ---------------------------------------------------------------------------
// Row reducers (pure; return the same array when nothing changed)

function byPosition(a: Square, b: Square): number {
  return a.position - b.position;
}

function byJoinedAt(a: Player, b: Player): number {
  const d = timestampMicros(a.joined_at) - timestampMicros(b.joined_at);
  if (d !== 0 && !Number.isNaN(d)) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Applies one square row (event or RPC result). A row whose `updated_at` is
 * not strictly newer than the one held is dropped: `updated_at` strictly
 * increases with every change, so an older or equal stamp is a stale or
 * duplicate delivery.
 */
export function upsertSquare(squares: Square[], row: Square): Square[] {
  const index = squares.findIndex((s) => s.id === row.id || s.position === row.position);
  if (index === -1) return [...squares, row].sort(byPosition);
  if (!isNewerSquare(row, squares[index])) return squares;
  const next = squares.slice();
  next[index] = row;
  return next;
}

export function applySquareChange(squares: Square[], change: RowChange<Square>): Square[] {
  if (change.type === "DELETE") {
    const id = change.old.id;
    if (!id) return squares;
    const next = squares.filter((s) => s.id !== id);
    return next.length === squares.length ? squares : next;
  }
  return upsertSquare(squares, change.row);
}

/** Players have no version column; the latest delivery wins. Kept in join order. */
export function upsertPlayer(players: Player[], row: Player): Player[] {
  const index = players.findIndex((p) => p.id === row.id);
  if (index === -1) return [...players, row].sort(byJoinedAt);
  const next = players.slice();
  next[index] = row;
  return next;
}

export function applyPlayerChange(players: Player[], change: RowChange<Player>): Player[] {
  if (change.type === "DELETE") {
    const id = change.old.id;
    if (!id) return players;
    const next = players.filter((p) => p.id !== id);
    return next.length === players.length ? players : next;
  }
  return upsertPlayer(players, change.row);
}

const STATUS_RANK: Record<GameStatus, number> = { lobby: 0, active: 1, ended: 2 };

/**
 * Applies a games row in place. Status only moves forward (lobby → active →
 * ended), so a row that would move it backwards is a stale read and is
 * ignored. Returns `null` when the game was deleted.
 */
export function applyGameChange(game: Game, change: RowChange<Game>): Game | null {
  if (change.type === "DELETE") return change.old.id && change.old.id !== game.id ? game : null;
  return mergeGame(game, change.row);
}

export function mergeGame(current: Game, incoming: Game): Game {
  if (incoming.id !== current.id) return current;
  if (STATUS_RANK[incoming.status] < STATUS_RANK[current.status]) return current;
  return incoming;
}

/**
 * Folds a freshly fetched snapshot into the held one. Squares keep whichever
 * version is newer per row (an event may have landed while the fetch was in
 * flight); players are replaced wholesale (the server list is authoritative);
 * the game goes through `mergeGame`.
 */
export function mergeSnapshot(current: GameSnapshot | null, incoming: GameSnapshot): GameSnapshot {
  if (!current || current.game.id !== incoming.game.id) return incoming;
  const held = new Map(current.squares.map((s) => [s.id, s]));
  const squares = incoming.squares.map((row) => {
    const mine = held.get(row.id);
    return mine && !isNewerSquare(row, mine) ? mine : row;
  });
  return { game: mergeGame(current.game, incoming.game), players: incoming.players, squares };
}

/** Converts a supabase-js payload into a RowChange (null for anything malformed). */
export function toRowChange<T extends { id: string }>(
  payload: RealtimePostgresChangesPayload<T>,
): RowChange<T> | null {
  if (payload.eventType === "DELETE") return { type: "DELETE", old: payload.old };
  const row = payload.new as Partial<T>;
  if (!row || typeof row.id !== "string") return null;
  return { type: payload.eventType, row: row as T };
}

// ---------------------------------------------------------------------------
// Channel wiring

export type GameChannelHandlers = {
  onGame: (change: RowChange<Game>) => void;
  onPlayer: (change: RowChange<Player>) => void;
  onSquare: (change: RowChange<Square>) => void;
  /** Every channel status; `SUBSCRIBED` also fires again after a reconnect. */
  onStatus: (status: `${"SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR"}`) => void;
};

/**
 * One channel per game with `postgres_changes` on games (`id=eq.<id>`),
 * players and squares (`game_id=eq.<id>`). RLS decides who receives events.
 * Returns an unsubscribe function that removes the channel.
 */
export function subscribeToGame(gameId: string, handlers: GameChannelHandlers): () => void {
  const supabase = createClient();
  // Unique topic per mount: supabase-js returns an existing channel for a
  // repeated topic, and bindings cannot be added to an already-joined channel
  // (React Strict Mode mounts effects twice in development).
  const suffix = Math.random().toString(36).slice(2, 10);
  const channel: RealtimeChannel = supabase
    .channel(`game:${gameId}:${suffix}`)
    .on<Game>("postgres_changes", { event: "*", schema: "public", table: "games", filter: `id=eq.${gameId}` }, (p) => {
      const change = toRowChange(p);
      if (change) handlers.onGame(change);
    })
    .on<Player>(
      "postgres_changes",
      { event: "*", schema: "public", table: "players", filter: `game_id=eq.${gameId}` },
      (p) => {
        const change = toRowChange(p);
        if (change) handlers.onPlayer(change);
      },
    )
    .on<Square>(
      "postgres_changes",
      { event: "*", schema: "public", table: "squares", filter: `game_id=eq.${gameId}` },
      (p) => {
        const change = toRowChange(p);
        if (change) handlers.onSquare(change);
      },
    )
    .subscribe((status) => handlers.onStatus(status));

  return () => {
    void supabase.removeChannel(channel);
  };
}

// ---------------------------------------------------------------------------
// Resync cadence

export const DEFAULT_SYNC_POLL_MS = 15_000;
const MIN_SYNC_POLL_MS = 500;

/**
 * Poll interval for the visible-tab resync. `NEXT_PUBLIC_SYNC_POLL_MS`
 * overrides the 15s default (the e2e uses 1500); junk or tiny values fall
 * back to the default.
 */
export function syncPollMs(raw: string | undefined = process.env.NEXT_PUBLIC_SYNC_POLL_MS): number {
  if (!raw) return DEFAULT_SYNC_POLL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= MIN_SYNC_POLL_MS ? Math.round(n) : DEFAULT_SYNC_POLL_MS;
}
