/**
 * A lightweight estimate of how far this phone's clock is from the server's,
 * for the shared start countdown (every phone counts down to the one
 * `countdown_ends_at` the server stamped).
 *
 * Phones keep network time, so the offset is normally a few milliseconds and
 * nothing is corrected: every phone simply counts down on its own clock, and
 * two phones show the board within their clock difference of each other.
 * When a phone's clock is clearly off (more than `SKEW_MIN_MS` beyond the
 * measurement's own uncertainty), the countdown uses the estimate instead.
 *
 * Samples come from RPC results that carry a server timestamp written during
 * the call itself (rpc.ts: `start_game`'s `started_at`, the `updated_at` of an
 * `update_square` / `set_deadline` / `extend_deadline` result, an applied
 * square result): the server wrote it somewhere between the request leaving
 * and the answer arriving, so `stamp - (sent + received) / 2` is the offset,
 * give or take half the round trip. The sample with the shortest round trip
 * wins (a newer one replaces it after `SAMPLE_MAX_AGE_MS`).
 *
 * Caveat: a phone that never made such a call (e.g. joined, tapped Ready and
 * edited nothing) has no sample and counts on its own clock. The server stays
 * the authority either way: a completion sent before the server's countdown
 * has ended gets `countdown_in_progress` and is retried (pendingActions.ts).
 */

/** Corrections smaller than this (beyond half the round trip) are noise, not skew. */
export const SKEW_MIN_MS = 300;
/** A sample older than this is replaced by any new one. */
export const SAMPLE_MAX_AGE_MS = 10 * 60_000;

export type ClockSample = {
  /** server time - local time, estimated at the round trip's midpoint. */
  offsetMs: number;
  /** The round trip it was measured over (its uncertainty is half of it). */
  rttMs: number;
  /** Local time of the answer. */
  at: number;
};

/** One measurement from a server stamp written during a call sent at `sentAt` and answered at `receivedAt` (local ms). */
export function measureSample(serverIso: string, sentAt: number, receivedAt: number): ClockSample | null {
  const server = Date.parse(serverIso);
  if (Number.isNaN(server) || !(receivedAt >= sentAt)) return null;
  return { offsetMs: Math.round(server - (sentAt + receivedAt) / 2), rttMs: receivedAt - sentAt, at: receivedAt };
}

/** Keeps the more precise sample (shorter round trip), unless the held one has gone stale. */
export function pickSample(held: ClockSample | null, next: ClockSample): ClockSample {
  if (!held || next.at - held.at > SAMPLE_MAX_AGE_MS || next.rttMs <= held.rttMs) return next;
  return held;
}

/** The correction to apply: the sample's offset when the skew is clearly real, else 0. */
export function effectiveOffsetMs(sample: ClockSample | null): number {
  if (!sample) return 0;
  return Math.abs(sample.offsetMs) - sample.rttMs / 2 > SKEW_MIN_MS ? sample.offsetMs : 0;
}

// ---------------------------------------------------------------------------
// The phone's estimate (module state, per tab), as an external store for React.

let best: ClockSample | null = null;
let offset = 0;
const listeners = new Set<() => void>();

/** Records a server stamp written during a call (see the header). Ignores anything unparseable. */
export function noteServerTime(serverIso: string | null | undefined, sentAt: number, receivedAt: number): void {
  if (!serverIso) return;
  const sample = measureSample(serverIso, sentAt, receivedAt);
  if (!sample) return;
  best = pickSample(best, sample);
  const next = effectiveOffsetMs(best);
  if (next === offset) return;
  offset = next;
  listeners.forEach((listener) => listener());
}

/** server time ≈ local time + this (0 unless this phone's clock is clearly off). */
export function serverOffsetMs(): number {
  return offset;
}

/** The server's clock as best known here (epoch ms). */
export function serverNow(): number {
  return Date.now() + offset;
}

export function subscribeServerClock(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests only. */
export function __resetServerClockForTests(): void {
  best = null;
  offset = 0;
  listeners.clear();
}
