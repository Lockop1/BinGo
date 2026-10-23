/**
 * Pure helpers for registering the service worker (public/sw.js).
 * Kept free of browser globals so they can be unit-tested.
 */

export const SERVICE_WORKER_PATH = "/sw.js";
export const SERVICE_WORKER_SCOPE = "/";

/**
 * The worker runs in production builds, and in `next dev` only when
 * NEXT_PUBLIC_ENABLE_SW=1 (so it can be tested without getting in the way of HMR).
 */
export function isServiceWorkerEnabled(nodeEnv: string | undefined, enableFlag: string | undefined): boolean {
  return nodeEnv === "production" || enableFlag === "1";
}

/**
 * Script URL with the worker's config: the Supabase origin (always network-only,
 * belt and braces on top of the same-origin-only rule) and a dev flag
 * (in dev, /_next/static file names are not content-hashed, so the worker
 * uses network-first there instead of cache-first).
 */
export function serviceWorkerUrl(options: { supabaseUrl?: string | null; dev: boolean }): string {
  const params = new URLSearchParams();
  if (options.supabaseUrl) {
    try {
      params.set("supabase", new URL(options.supabaseUrl).origin);
    } catch {
      // Malformed env value: the same-origin rule still keeps Supabase out of every cache.
    }
  }
  if (options.dev) params.set("dev", "1");
  const query = params.toString();
  return query ? `${SERVICE_WORKER_PATH}?${query}` : SERVICE_WORKER_PATH;
}

/**
 * Same-origin URLs the page loaded before the worker controlled it (scripts,
 * styles, fonts, icons). The worker re-checks every URL against its policy.
 */
export function sameOriginUrls(urls: readonly string[], origin: string): string[] {
  const out = new Set<string>();
  for (const raw of urls) {
    try {
      const url = new URL(raw, origin);
      if (url.origin === origin) {
        url.hash = "";
        out.add(url.href);
      }
    } catch {
      // Not a URL; skip.
    }
  }
  return [...out];
}
