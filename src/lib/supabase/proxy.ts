import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { readSupabasePublicEnv } from "@/lib/env";
import { classifyRefreshError } from "@/lib/supabase/refreshErrors";

let warnedMissingEnv = false;

export type CookieWrite = { name: string; value: string; options: CookieOptions };

/** @supabase/ssr's session cookie (`sb-<ref>-auth-token`, or one of its `.N` chunks); not the PKCE verifier. */
const AUTH_COOKIE = /^sb-.+-auth-token(?:\.\d+)?$/;

function isDeletion(write: CookieWrite, now: number): boolean {
  const { maxAge, expires } = write.options;
  if (write.value === "" || maxAge === 0 || (typeof maxAge === "number" && maxAge < 0)) return true;
  return expires instanceof Date && expires.getTime() <= now;
}

/**
 * The cookie writes to put on the response after `getUser()`.
 *
 * auth-js deletes the stored session after any refresh error it does not
 * consider retryable once the access token has expired, including a 429 or an
 * unparsable error page; written to the response, that would cost the phone
 * its anonymous identity (and its games). So when `getUser()` failed for a
 * reason that is not definitive (`classifyRefreshError`) and the writes only
 * delete the session cookie, those deletions are dropped and the phone keeps
 * its cookie for the next try. Anything that writes a new session value (a
 * successful refresh, including the removal of chunks it no longer uses) and
 * every definitive failure goes through unchanged, as does any non-session
 * cookie.
 */
export function cookieWritesToApply(writes: readonly CookieWrite[], error: unknown, now = Date.now()): CookieWrite[] {
  if (!error || classifyRefreshError(error) === "definitive") return [...writes];
  const session = writes.filter((w) => AUTH_COOKIE.test(w.name));
  const rewritesSession = session.some((w) => !isDeletion(w, now));
  if (rewritesSession) return [...writes];
  return writes.filter((w) => !(AUTH_COOKIE.test(w.name) && isDeletion(w, now)));
}

/**
 * Refreshes the Supabase auth session for the incoming request and writes any
 * updated auth cookies (plus no-cache headers) onto the response.
 * Called from src/proxy.ts.
 *
 * Cookie writes are buffered while `getUser()` runs and applied afterwards
 * through `cookieWritesToApply`, so a passing failure (bad signal between
 * server and Auth, 5xx, rate limit) never clears the phone's session cookie.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const env = readSupabasePublicEnv();
  if (!env) {
    // Let the app render without a .env.local; client factories throw a
    // clear setup error as soon as Supabase is actually used.
    if (!warnedMissingEnv) {
      warnedMissingEnv = true;
      console.warn(
        "[proxy] Supabase env vars missing; skipping session refresh. See README.md > Local setup.",
      );
    }
    return response;
  }

  const buffered: CookieWrite[] = [];
  const headersToSet: Record<string, string> = {};
  const supabase = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        buffered.push(...cookiesToSet);
        // Cache-Control etc. so a CDN never serves one user's session cookie to another.
        Object.assign(headersToSet, headers);
      },
    },
  });

  // Do not run code between createServerClient and getUser(): getUser()
  // revalidates the token with Supabase Auth and triggers the refresh above.
  const { error } = await supabase.auth.getUser();

  const writes = cookieWritesToApply(buffered, error);
  if (writes.length > 0) {
    writes.forEach(({ name, value }) => request.cookies.set(name, value));
    response = NextResponse.next({ request });
    writes.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
  }
  // Even when every write was dropped: the response was about to carry cookies.
  Object.entries(headersToSet).forEach(([key, value]) => response.headers.set(key, value));

  return response;
}
