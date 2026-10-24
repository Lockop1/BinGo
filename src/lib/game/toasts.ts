/**
 * Toast queue for the live board: one small banner at a time, each shown for
 * ~2.5 s, the rest waiting in line (never stacked). Framework-free so it can
 * be unit-tested; the board subscribes with useSyncExternalStore.
 */

export type ToastTone = "info" | "error";

export type Toast = {
  id: string;
  text: string;
  tone: ToastTone;
  /** Player palette index for the swatch (null: none). */
  color: number | null;
  /** Square the toast is about; tapping it opens that square's sheet. */
  position: number | null;
};

export type ToastInput = Omit<Toast, "id" | "tone" | "color" | "position"> &
  Partial<Pick<Toast, "id" | "tone" | "color" | "position">>;

export type ToastState = {
  current: Toast | null;
  queued: readonly Toast[];
};

export const TOAST_MS = 2500;
/** Waiting toasts beyond this drop the oldest (a flood after a reconnect stays short). */
export const MAX_QUEUED = 4;

type Timer = unknown;

export type ToastQueueOptions = {
  durationMs?: number;
  maxQueued?: number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
};

export type ToastQueue = {
  push(input: ToastInput): Toast | null;
  /** Hide the current toast (or drop a waiting one by id) and move on. */
  dismiss(id?: string): void;
  clear(): void;
  getState(): ToastState;
  subscribe(listener: () => void): () => void;
  dispose(): void;
};

export function createToastQueue(options: ToastQueueOptions = {}): ToastQueue {
  const durationMs = options.durationMs ?? TOAST_MS;
  const maxQueued = options.maxQueued ?? MAX_QUEUED;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const listeners = new Set<() => void>();
  let state: ToastState = { current: null, queued: [] };
  let timer: Timer | null = null;
  let seq = 0;

  const set = (next: ToastState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  const stop = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const show = (toast: Toast | null, queued: readonly Toast[]) => {
    stop();
    set({ current: toast, queued });
    if (toast) {
      timer = setTimer(() => {
        timer = null;
        next();
      }, durationMs);
    }
  };
  const next = () => {
    const [head = null, ...rest] = state.queued;
    show(head, rest);
  };

  return {
    push(input) {
      const toast: Toast = {
        id: input.id ?? `toast-${++seq}`,
        text: input.text,
        tone: input.tone ?? "info",
        color: input.color ?? null,
        position: input.position ?? null,
      };
      // The same news twice in a row (e.g. a duplicate delivery) shows once.
      const last = state.queued[state.queued.length - 1] ?? state.current;
      if (last && last.text === toast.text && last.tone === toast.tone) return null;
      if (!state.current) {
        show(toast, state.queued);
      } else {
        const queued = [...state.queued, toast];
        set({ ...state, queued: queued.length > maxQueued ? queued.slice(queued.length - maxQueued) : queued });
      }
      return toast;
    },
    dismiss(id) {
      if (id !== undefined && state.current?.id !== id) {
        if (state.queued.some((t) => t.id === id)) set({ ...state, queued: state.queued.filter((t) => t.id !== id) });
        return;
      }
      if (state.current) next();
    },
    clear() {
      show(null, []);
    },
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      stop();
      listeners.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Media news

type MediaLike = { id: string; square_id: string; player_id: string; kind: "photo" | "video" };
type MediaToastContext = {
  players: readonly { id: string; display_name: string; color: number }[];
  squares: readonly { id: string; position: number; label: string }[];
  /** The viewer's player id: their own uploads never toast. */
  meId: string | null;
};

/**
 * "Jake added a photo to Skyline Chili" for every media row not in `seen`
 * that someone else added (upload order). Tapping one opens that square.
 */
export function mediaToasts(seen: ReadonlySet<string>, media: readonly MediaLike[], ctx: MediaToastContext): ToastInput[] {
  const out: ToastInput[] = [];
  for (const m of media) {
    if (seen.has(m.id) || m.player_id === ctx.meId) continue;
    const who = ctx.players.find((p) => p.id === m.player_id) ?? null;
    const square = ctx.squares.find((s) => s.id === m.square_id) ?? null;
    const what = m.kind === "video" ? "a video" : "a photo";
    const where = square ? ` to ${square.label.trim() || `square ${square.position + 1}`}` : "";
    out.push({
      text: `${who?.display_name ?? "Someone"} added ${what}${where}`,
      color: who?.color ?? null,
      position: square?.position ?? null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Taps that never reached the server

type DroppedLike = { action: { position: number }; reason: "game_over" | "overflow" };

/**
 * One short line per reason for taps the queue gave up on, e.g. "Couldn't
 * save Sing on stage — the game had already ended" (or "3 squares" when
 * several squares are affected). `labelFor` names a square by position.
 */
export function droppedNotices(dropped: readonly DroppedLike[], labelFor: (position: number) => string): string[] {
  const lines: string[] = [];
  const reasons: [DroppedLike["reason"], string][] = [
    ["game_over", "the game had already ended"],
    ["overflow", "too many taps were waiting offline"],
  ];
  for (const [reason, why] of reasons) {
    const positions = [...new Set(dropped.filter((d) => d.reason === reason).map((d) => d.action.position))];
    if (positions.length === 0) continue;
    const what = positions.length === 1 ? labelFor(positions[0]) : `${positions.length} squares`;
    lines.push(`Couldn't save ${what} — ${why}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Display

/**
 * Splits "Jake got Skyline Chili" into the player name it starts with and the rest, so the
 * toast can cap the name's width (a 24-character name must not push the square out of view).
 * `names` are the game's display names; the longest one that prefixes the text, followed by a
 * space, wins. Null when the text does not start with any of them (errors, "Someone …").
 */
export function splitLead(text: string, names: readonly string[]): { lead: string; rest: string } | null {
  let best: string | null = null;
  for (const name of names) {
    if (name.length === 0 || text.length <= name.length || text[name.length] !== " ") continue;
    if (!text.startsWith(name)) continue;
    if (best === null || name.length > best.length) best = name;
  }
  return best === null ? null : { lead: best, rest: text.slice(best.length) };
}
