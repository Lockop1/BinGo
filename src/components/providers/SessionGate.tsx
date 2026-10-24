"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useSession } from "@/components/providers/SessionProvider";
import { PencilButton } from "@/components/ui/PencilButton";

/** How long to show nothing at all before the quiet "Connecting…" line. */
const QUIET_MS = 300;

/**
 * Renders `children` only once an anonymous session exists. For the first
 * ~300ms it renders nothing (most loads finish here), then a quiet
 * "Connecting…" line; if sign-in fails (e.g. offline) it offers a retry. When
 * the phone still has its identity and only the refresh failed, the copy says
 * so (nothing is lost) while SessionProvider keeps retrying on its own.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const session = useSession();

  if (session.status === "ready") return <>{children}</>;
  if (session.status === "error") {
    return (
      <div role="alert" className="flex flex-col items-start gap-3 py-2" data-testid="session-error">
        <p className="text-lg text-ink-soft">
          {session.reconnecting
            ? "Couldn’t reconnect — your game is still here. Retrying…"
            : "Couldn’t connect. Check your signal and try again."}
        </p>
        <PencilButton variant="secondary" onClick={session.retry}>
          Try again
        </PencilButton>
      </div>
    );
  }
  return <Connecting />;
}

function Connecting() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), QUIET_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <p aria-live="polite" className="min-h-7 py-2 text-lg text-ink-soft">
      {visible ? "Connecting…" : null}
    </p>
  );
}
