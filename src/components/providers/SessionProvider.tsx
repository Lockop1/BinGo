"use client";

import type { Session } from "@supabase/supabase-js";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ensureSession } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/client";

export type SessionState =
  | { status: "checking"; session: null; userId: null }
  | { status: "ready"; session: Session; userId: string }
  | { status: "error"; session: null; userId: null; error: unknown };

type SessionContextValue = SessionState & { retry: () => void };

const SessionContext = createContext<SessionContextValue | null>(null);

const CHECKING: SessionState = { status: "checking", session: null, userId: null };

/**
 * Makes sure this phone has an anonymous Supabase session as soon as the app
 * opens. Never blocks rendering: screens that need the session wrap their
 * data-dependent parts in <SessionGate>.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>(CHECKING);
  const attempt = useRef(0);
  const statusRef = useRef<SessionState["status"]>("checking");

  useEffect(() => {
    statusRef.current = state.status;
  }, [state.status]);

  const connect = useCallback(() => {
    const id = ++attempt.current;
    return ensureSession().then(
      (session) => {
        if (id === attempt.current) setState({ status: "ready", session, userId: session.user.id });
      },
      (error: unknown) => {
        if (id === attempt.current) setState({ status: "error", session: null, userId: null, error });
      },
    );
  }, []);

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
        // Token refreshes and sign-ins keep the current identity up to date.
        setState((prev) =>
          prev.status === "ready" && prev.session.access_token === session.access_token
            ? prev
            : { status: "ready", session, userId: session.user.id },
        );
      } else if (event === "SIGNED_OUT") {
        // Cookies cleared elsewhere: quietly get a fresh anonymous identity.
        setState(CHECKING);
        void connect();
      }
    });

    // Coming back online after a failed sign-in retries on its own.
    const onOnline = () => {
      if (statusRef.current !== "error") return;
      setState(CHECKING);
      void connect();
    };
    window.addEventListener("online", onOnline);

    return () => {
      data.subscription.unsubscribe();
      window.removeEventListener("online", onOnline);
    };
  }, [connect]);

  return <SessionContext.Provider value={{ ...state, retry }}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside <SessionProvider>.");
  return value;
}
