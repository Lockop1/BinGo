"use client";

import type { Session } from "@supabase/supabase-js";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ensureSession, isSessionReconnectError, retryDelayMs } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/client";

export type SessionState =
  | { status: "checking"; session: null; userId: null }
  | { status: "ready"; session: Session; userId: string }
  | {
      status: "error";
      session: null;
      userId: null;
      error: unknown;
      /**
       * True when the phone still has its stored identity and only the
       * refresh failed (bad signal, server trouble): nothing is lost, and the
       * provider keeps retrying on its own. False when a fresh phone could
       * not sign in at all.
       */
      reconnecting: boolean;
    };

type SessionContextValue = SessionState & { retry: () => void };

const SessionContext = createContext<SessionContextValue | null>(null);

const CHECKING: SessionState = { status: "checking", session: null, userId: null };

/**
 * Makes sure this phone has an anonymous Supabase session as soon as the app
 * opens. Never blocks rendering: screens that need the session wrap their
 * data-dependent parts in <SessionGate>.
 *
 * A failed attempt is retried on its own (backoff from `retryDelayMs`, and at
 * once on `online`) without flipping back to "checking", so the error copy
 * stays put; `retry()` is the manual "Try again". A stored identity is never
 * swapped for a new one because of a failed refresh (see lib/supabase/auth.ts).
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>(CHECKING);
  const attempt = useRef(0);
  const failures = useRef(0);
  const retryTimer = useRef<number | null>(null);
  const statusRef = useRef<SessionState["status"]>("checking");

  useEffect(() => {
    statusRef.current = state.status;
  }, [state.status]);

  const clearRetryTimer = useCallback(() => {
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    retryTimer.current = null;
  }, []);

  const connect = useCallback(
    function run(): Promise<void> {
      const id = ++attempt.current;
      clearRetryTimer();
      return ensureSession().then(
        (session) => {
          if (id !== attempt.current) return;
          failures.current = 0;
          setState({ status: "ready", session, userId: session.user.id });
        },
        (error: unknown) => {
          if (id !== attempt.current) return;
          setState({ status: "error", session: null, userId: null, error, reconnecting: isSessionReconnectError(error) });
          retryTimer.current = window.setTimeout(() => {
            retryTimer.current = null;
            // Offline for sure: wait for `online` instead of failing again.
            if (navigator.onLine === false) return;
            void run();
          }, retryDelayMs(failures.current++));
        },
      );
    },
    [clearRetryTimer],
  );

  const retry = useCallback(() => {
    setState(CHECKING);
    void connect();
  }, [connect]);

  useEffect(() => {
    // Initial check; setState happens after the await, never synchronously here.
    void connect();

    const supabase = createClient();
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (session) {
        // Token refreshes and sign-ins keep the current identity up to date;
        // a refresh that succeeds in the background also ends a reconnect.
        attempt.current++;
        clearRetryTimer();
        failures.current = 0;
        setState((prev) =>
          prev.status === "ready" && prev.session.access_token === session.access_token
            ? prev
            : { status: "ready", session, userId: session.user.id },
        );
      } else if (event === "SIGNED_OUT") {
        // Stored session deleted (a failed refresh, or cookies cleared). ensureSession
        // asks for the same identity back first and signs in anew only if it is dead.
        setState(CHECKING);
        void connect();
      }
    });

    // Coming back online after a failed attempt retries at once.
    const onOnline = () => {
      if (statusRef.current !== "error") return;
      void connect();
    };
    window.addEventListener("online", onOnline);

    return () => {
      data.subscription.unsubscribe();
      window.removeEventListener("online", onOnline);
      clearRetryTimer();
    };
  }, [connect, clearRetryTimer]);

  return <SessionContext.Provider value={{ ...state, retry }}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside <SessionProvider>.");
  return value;
}
