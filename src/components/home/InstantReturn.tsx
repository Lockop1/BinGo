"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import {
  HOME_GUARD_SCRIPT,
  clearStayHome,
  decideOpen,
  isFreshOpen,
  isStayHome,
  readActiveGame,
  readLastEnded,
  type ActiveGameRecord,
  type OpenDecision,
} from "@/lib/game/activeGame";

/**
 * A soft navigation stuck on bad signal falls back to a document navigation
 * after this long: the service worker answers that one from its cache after
 * at most 3 s (sw-policy NAVIGATION_TIMEOUT_MS).
 */
const SOFT_NAVIGATION_FALLBACK_MS = 2_500;

// useSyncExternalStore wants a stable snapshot: same inputs, same object.
let cache: { key: string; decision: OpenDecision } | null = null;

function getDecision(): OpenDecision {
  const active = readActiveGame();
  const lastEnded = readLastEnded();
  const freshOpen = isFreshOpen();
  const stay = isStayHome();
  const key = JSON.stringify([active?.gameId, active?.status, active?.savedAt, lastEnded, freshOpen, stay]);
  if (cache?.key !== key) {
    cache = { key, decision: decideOpen({ active, lastEnded, freshOpen, stay, now: Date.now() }) };
  }
  return cache.decision;
}

/** The server (and the hydrating render) shows plain home. */
const SERVER_DECISION: OpenDecision = { kind: "home", back: null };
const getServerDecision = () => SERVER_DECISION;
// Read on render only: the decision is made once per visit to `/`.
const noSubscribe = () => () => {};
const isClient = () => false;
const isServer = () => true;

/**
 * `/` on an app open: jumps straight to the live board kept in
 * `bingo.activeGame`, or (once, within a day) to the recap of a game this
 * phone saw end; otherwise shows home.
 *
 * Client-side only: the service worker never caches a page reached through a
 * server redirect, and this must work offline (cached `/` → cached
 * `/game/<id>` → board from the snapshot). Offline, or when a soft navigation
 * hangs on bad signal, it falls back to a document navigation, which the
 * worker serves from its cache.
 *
 * A deliberate Home visit (Leave / Home links, `?stay=1`) or any in-app
 * navigation back to `/` stays home, with a quiet "Back to your game" row.
 */
export function InstantReturn({ children }: { children: ReactNode }) {
  const decision = useSyncExternalStore(noSubscribe, getDecision, getServerDecision);
  // True only for the server render and the hydrating render: the guard must
  // be in the server HTML, but React must never create it on the client.
  const hydrating = useSyncExternalStore(noSubscribe, isClient, isServer);
  const router = useRouter();
  const wrapper = useRef<HTMLDivElement>(null);

  // Before paint: home shows only once it is certain to stay.
  useLayoutEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    if (decision.kind === "home") el.style.removeProperty("visibility");
    else el.style.visibility = "hidden";
  }, [decision]);

  useEffect(() => {
    if (decision.kind !== "game") return;
    const href = `/game/${decision.gameId}`;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      window.location.replace(href);
      return;
    }
    router.replace(href);
    const fallback = window.setTimeout(() => window.location.replace(href), SOFT_NAVIGATION_FALLBACK_MS);
    return () => window.clearTimeout(fallback);
  }, [decision, router]);

  return (
    <div
      ref={wrapper}
      // The guard may have set an inline style before hydration.
      suppressHydrationWarning
      data-testid="home"
      data-decision={decision.kind}
      className="flex min-w-0 flex-1 flex-col"
    >
      {hydrating ? <script dangerouslySetInnerHTML={{ __html: HOME_GUARD_SCRIPT }} /> : null}
      {decision.kind === "home" ? (
        <>
          {decision.back ? <BackToGame record={decision.back} /> : null}
          {children}
        </>
      ) : null}
    </div>
  );
}

function BackToGame({ record }: { record: ActiveGameRecord }) {
  return (
    <Link
      href={`/game/${record.gameId}`}
      onClick={clearStayHome}
      data-testid="back-to-game"
      data-game-id={record.gameId}
      className="-ml-2 mb-1 flex min-h-11 w-fit max-w-full min-w-0 items-center gap-1.5 px-2 text-lg text-ink-soft"
    >
      <span className="shrink-0 underline decoration-ink-faint decoration-2 underline-offset-4">Back to your game</span>
      <span className="min-w-0 truncate">· {record.name}</span>
      <ArrowRight aria-hidden className="size-4 shrink-0" strokeWidth={2.25} />
    </Link>
  );
}
