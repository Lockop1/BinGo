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
