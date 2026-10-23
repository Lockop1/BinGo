"use client";

import { RotateCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  SERVICE_WORKER_PATH,
  SERVICE_WORKER_SCOPE,
  isServiceWorkerEnabled,
  sameOriginUrls,
  serviceWorkerUrl,
} from "@/lib/pwa/registration";

/**
 * Registers the app-shell service worker (public/sw.js) after the page has
 * loaded. Renders nothing, except a small "Update available" line when a new
 * worker takes over a page that was already controlled by an older one.
 * Does nothing where service workers are unsupported.
 */
export function ServiceWorkerRegistration() {
  const [updateReady, setUpdateReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const container = navigator.serviceWorker;
    const dev = process.env.NODE_ENV !== "production";

    if (!isServiceWorkerEnabled(process.env.NODE_ENV, process.env.NEXT_PUBLIC_ENABLE_SW)) {
      // Dev without the flag: drop a worker left over from an earlier NEXT_PUBLIC_ENABLE_SW=1 run.
      void unregisterOurWorkers(container);
      return;
    }

    let cancelled = false;
    const hadController = Boolean(container.controller);

    const onControllerChange = () => {
      // First install also fires controllerchange (clients.claim); only a replacement is an update.
      if (hadController && !cancelled) setUpdateReady(true);
    };
    container.addEventListener("controllerchange", onControllerChange);

    const register = async () => {
      try {
        const registration = await container.register(
          serviceWorkerUrl({ supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL, dev }),
          { scope: SERVICE_WORKER_SCOPE, updateViaCache: "none" },
        );
        if (cancelled) return;
        if (registration.waiting && container.controller) setUpdateReady(true);
        registration.addEventListener("updatefound", () => {
          const incoming = registration.installing;
          incoming?.addEventListener("statechange", () => {
            if (incoming.state === "installed" && container.controller && !cancelled) setUpdateReady(true);
          });
        });
        const ready = await container.ready;
        if (!cancelled) warmShell(ready.active);
      } catch {
        // Registration failures (private mode, blocked storage) only cost the offline shell.
      }
    };

    const onLoad = () => void register();
    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad, { once: true });

    return () => {
      cancelled = true;
      window.removeEventListener("load", onLoad);
      container.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  if (!updateReady || dismissed) return null;

  return (
    <div
      role="status"
      data-testid="sw-update"
      className="fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-[max(8px,env(safe-area-inset-top))]"
    >
      <div className="index-card flex items-center gap-1 pl-3 text-lg text-ink">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="flex min-h-11 items-center gap-2 px-1 underline decoration-ink-faint underline-offset-4"
        >
          <RotateCw aria-hidden className="size-4" strokeWidth={2.5} />
          Update available — reload
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
          className="flex size-11 items-center justify-center text-ink-soft"
        >
          <X aria-hidden className="size-4" strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}

/** Tells the worker what this page loaded before it was controlled, so it is cached too. */
function warmShell(worker: ServiceWorker | null) {
  if (!worker) return;
  const origin = window.location.origin;
  const loaded = performance.getEntriesByType("resource").map((entry) => entry.name);
  const referenced = Array.from(
    document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>("script[src], link[href]"),
    (el) => ("src" in el ? el.src : el.href),
  );
  worker.postMessage({
    type: "WARM",
    pages: [window.location.href],
    assets: sameOriginUrls([...loaded, ...referenced], origin),
  });
}

async function unregisterOurWorkers(container: ServiceWorkerContainer) {
  try {
    const registrations = await container.getRegistrations();
    await Promise.all(
      registrations
        .filter((registration) => {
          const worker = registration.active ?? registration.waiting ?? registration.installing;
          return worker ? new URL(worker.scriptURL).pathname === SERVICE_WORKER_PATH : false;
        })
        .map((registration) => registration.unregister()),
    );
  } catch {
    // Nothing to clean up.
  }
}
