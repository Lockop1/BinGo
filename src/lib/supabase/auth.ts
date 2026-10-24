import {
  isAuthApiError,
  isAuthRetryableFetchError,
  isAuthSessionMissingError,
  type AuthChangeEvent,
  type Session,
} from "@supabase/supabase-js";
import { parseCookieHeader, stringFromBase64URL } from "@supabase/ssr";
import { getSupabasePublicEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";

/**
 * Silent anonymous identity (browser only).
 *
 * There are no accounts: the first time a phone opens the app it signs in
 * anonymously and keeps that session (cookies, refreshed by src/proxy.ts) as
 * its identity. "Your games" and every player row are keyed by that user id,
 * so replacing it loses the phone's games. The rules:
 *
 * (a) Nothing stored at all → sign in anonymously (a fresh phone).
 * (b) A session is stored but cannot be refreshed right now (offline, fetch
 *     failure, 5xx, rate limit, a captive portal's HTML page, anything not
 *     listed under (c)) → keep it and throw `SessionReconnectError`; the
 *     caller retries (SessionProvider: backoff + `online`).
 * (c) The server says the refresh token is dead (`refresh_token_not_found`,
 *     `refresh_token_already_used`, `invalid_grant`, "Invalid Refresh Token",
 *     "Refresh token is not valid", session/user gone) → a new anonymous sign-in is the only option (logged
 *     once).
 *
 * How auth-js behaves underneath (supabase-js 2.118): `getSession()` refreshes
 * an expiring access token. On `AuthRetryableFetchError` (network failure,
 * 5xx) it keeps the stored session and returns `{ session: null, error }`. On
 * any other refresh error with the access token already expired it deletes
 * the stored session and emits `SIGNED_OUT`, even for a 429 or an unparsable
 * error page. So the keeper remembers the last stored refresh token (read from
 * @supabase/ssr's `sb-<ref>-auth-token[.N]` cookies, and from auth events) and,
 * when storage turns up empty although this tab held a session, asks for the
 * same identity back with `refreshSession({ refresh_token })` before ever
 * signing in anew. auth-js caches a failed refresh for the same token for
 * ~60 s, so retries inside that window are free and return the same error.
 */

/** The slice of `supabase.auth` the keeper uses (a fake in tests). */
export type AuthLike = {
  getSession(): PromiseLike<{ data: { session: Session | null }; error: unknown }>;
  refreshSession(current: { refresh_token: string }): PromiseLike<{ data: { session: Session | null }; error: unknown }>;
  signInAnonymously(): PromiseLike<{ data: { session: Session | null }; error: unknown }>;
  onAuthStateChange(callback: (event: AuthChangeEvent, session: Session | null) => void): unknown;
};

/** What the keeper needs from a stored session to bring the same identity back. */
export type StoredSession = { refreshToken: string; userId: string };

/**
 * The phone still has its identity but could not refresh it right now (case
 * b). Retry later; never sign in anew because of this.
 */
export class SessionReconnectError extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super("Couldn't refresh the stored session; it is kept and will be retried.");
    this.name = "SessionReconnectError";
    this.cause = cause;
  }
}

export function isSessionReconnectError(error: unknown): error is SessionReconnectError {
  return error instanceof SessionReconnectError;
}

const DEAD_TOKEN_CODES = new Set([
  "refresh_token_not_found",
  "refresh_token_already_used",
  "session_not_found",
  "session_expired",
  "user_not_found",
  "invalid_grant",
]);
// Legacy `{ error: "invalid_grant", error_description: "Invalid Refresh Token: …" }` bodies carry no
// code; a malformed token gets `validation_failed` "Refresh token is not valid". Both are 400s.
const DEAD_TOKEN_MESSAGE = /invalid refresh token|refresh token not found|refresh token is not valid|invalid_grant|already used/i;

/**
 * `definitive` only when the server has said the refresh token can never work
 * again (case c). Everything else, including errors we do not recognise, is
 * `transient`: keeping a dead identity a little longer costs a retry, while
 * dropping a live one loses the phone's games.
 */
export function classifyRefreshError(error: unknown): "transient" | "definitive" {
  if (isAuthRetryableFetchError(error)) return "transient";
  // auth-js maps a server `session_not_found` to this class.
  if (isAuthSessionMissingError(error)) return "definitive";
  if (isAuthApiError(error)) {
    if (error.code && DEAD_TOKEN_CODES.has(error.code)) return "definitive";
    const clientError = error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
    if (clientError && DEAD_TOKEN_MESSAGE.test(error.message)) return "definitive";
  }
  return "transient";
}

/** SessionProvider's automatic retry schedule after a failed attempt: 1 s, 2 s, 4 s, 8 s, then every 15 s. */
export function retryDelayMs(failures: number): number {
  return Math.min(15_000, 1_000 * 2 ** Math.max(0, failures));
}

/** supabase-js's default storage key for a project URL (client.ts sets no custom cookie name). */
export function authStorageKey(supabaseUrl: string): string {
  return `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
}

/**
 * Reads the session @supabase/ssr's browser client stores in cookies: one
 * cookie named `key`, or chunks `key.0`, `key.1`, … joined in order; the value
 * is `base64-` + base64url(JSON) (or plain JSON). Returns null when nothing
 * usable is stored. Never throws.
 */
export function readStoredSession(cookieHeader: string, key: string): StoredSession | null {
  try {
    const cookies = new Map(parseCookieHeader(cookieHeader).map((c) => [c.name, c.value]));
    let raw = cookies.get(key) ?? null;
    if (raw === null) {
      const chunks: string[] = [];
      for (let i = 0; cookies.has(`${key}.${i}`); i++) chunks.push(cookies.get(`${key}.${i}`)!);
      raw = chunks.length ? chunks.join("") : null;
    }
    if (!raw) return null;
    const json = raw.startsWith("base64-") ? stringFromBase64URL(raw.slice("base64-".length)) : raw;
    const parsed = JSON.parse(json) as { refresh_token?: unknown; user?: { id?: unknown } } | null;
    const refreshToken = parsed?.refresh_token;
    const userId = parsed?.user?.id;
    if (typeof refreshToken !== "string" || !refreshToken || typeof userId !== "string" || !userId) return null;
    return { refreshToken, userId };
  } catch {
    return null;
  }
}

export type SessionKeeper = {
  /**
   * Returns the current session, signing in anonymously only in cases (a) and
   * (c). Concurrent callers share one in-flight attempt, so a page that mounts
   * several components never creates more than one anonymous user.
   *
   * Throws `SessionReconnectError` in case (b), or the sign-in error when a
   * fresh sign-in fails (e.g. offline); callers decide how to surface retry.
   */
  ensureSession(): Promise<Session>;
};

export type SessionKeeperDeps = {
  /** The auth client, created on first use (after the first `readStored`). */
  auth: () => AuthLike;
  /** The session currently in storage, or null. Called at the start of every attempt. */
  readStored: () => StoredSession | null;
  /** Called once, the first time an identity has to be replaced (case c). */
  onReplace?: (cause: unknown) => void;
};

type Outcome = { session: Session | null; error: unknown };

async function settle(run: () => PromiseLike<{ data: { session: Session | null }; error: unknown }>): Promise<Outcome> {
  try {
    const { data, error } = await run();
    return { session: data.session, error: data.session ? null : error };
  } catch (error) {
    return { session: null, error };
  }
}

export function createSessionKeeper(deps: SessionKeeperDeps): SessionKeeper {
  let inflight: Promise<Session> | null = null;
  let client: AuthLike | null = null;
  /** The identity this tab last saw in storage or in an auth event. Cleared only on replacement. */
  let lastKnown: StoredSession | null = null;
  let replacedOnce = false;

  const remember = (session: Session) => {
    lastKnown = { refreshToken: session.refresh_token, userId: session.user.id };
  };

  const auth = (): AuthLike => {
    if (client) return client;
    client = deps.auth();
    // Token rotations (here or broadcast from another tab) keep lastKnown current.
    // Only record here: auth-js forbids awaiting other auth calls inside this callback.
    client.onAuthStateChange((_event, session) => {
      if (session) remember(session);
    });
    return client;
  };

  const signInFresh = async (auth: AuthLike, deadCause: unknown): Promise<Session> => {
    if (deadCause !== null) {
      if (!replacedOnce) {
        replacedOnce = true;
        deps.onReplace?.(deadCause);
      }
      lastKnown = null;
    }
    const { data, error } = await auth.signInAnonymously();
    if (error) throw error;
    if (!data.session) throw new Error("Anonymous sign-in returned no session.");
    remember(data.session);
    return data.session;
  };

  const attempt = async (): Promise<Session> => {
    // Storage is the freshest source (another tab may have rotated the token).
    const stored = deps.readStored();
    if (stored) lastKnown = stored;
    const client = auth();

    const loaded = await settle(() => client.getSession());
    if (loaded.session) {
      remember(loaded.session);
      return loaded.session;
    }

    const held = lastKnown;
    if (!held) {
      // (a) Nothing stored and nothing seen in this tab: a fresh phone.
      if (loaded.error) throw loaded.error;
      return signInFresh(client, null);
    }

    let error = loaded.error;
    if (!error) {
      // Storage is empty although this tab held a session: auth-js (or the
      // server proxy) deleted it after a failed refresh. Ask for the same
      // identity back before giving it up.
      const restored = await settle(() => client.refreshSession({ refresh_token: held.refreshToken }));
      if (restored.session) {
        remember(restored.session);
        return restored.session;
      }
      error = restored.error ?? new Error("Refresh returned no session.");
    }

    // (c) The refresh token is dead: a new identity is the only option.
    if (classifyRefreshError(error) === "definitive") return signInFresh(client, error);
    // (b) Keep the identity and let the caller retry.
    throw new SessionReconnectError(error);
  };

  return {
    ensureSession() {
      inflight ??= attempt().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}

// The cookies as they were when this module loaded, before the auth client
// existed: if its startup refresh deletes a stored session for a non-final
// reason, the first attempt can still recover the refresh token from here.
let bootCookies: string | null = typeof document === "undefined" ? null : document.cookie;

let defaultKeeper: SessionKeeper | null = null;

/** The app's session keeper, wired to the browser client and its cookies. See `SessionKeeper.ensureSession`. */
export function ensureSession(): Promise<Session> {
  defaultKeeper ??= createSessionKeeper({
    auth: () => createClient().auth,
    readStored: () => {
      const key = authStorageKey(getSupabasePublicEnv().url);
      const boot = bootCookies;
      bootCookies = null;
      return readStoredSession(document.cookie, key) ?? (boot ? readStoredSession(boot, key) : null);
    },
    onReplace: (cause) => {
      console.warn("[auth] The stored session can no longer be refreshed; starting a new anonymous identity.", cause);
    },
  });
  return defaultKeeper.ensureSession();
}

/**
 * The signed-in user's id, or `null` if there is no session (or the auth
 * client errors). Never throws and never signs in.
 */
export async function getUserId(): Promise<string | null> {
  try {
    const { data, error } = await createClient().auth.getSession();
    if (error) return null;
    return data.session?.user.id ?? null;
  } catch {
    return null;
  }
}
