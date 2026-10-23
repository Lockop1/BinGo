import type { Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

/**
 * Silent anonymous identity (browser only).
 *
 * There are no accounts: the first time a phone opens the app it signs in
 * anonymously and keeps that session (cookies, refreshed by src/proxy.ts) as
 * its identity. "Your games" is keyed by that user id.
 */

let inflight: Promise<Session> | null = null;

/**
 * Returns the current session, signing in anonymously once if there is none.
 * Concurrent callers share one in-flight promise, so a page that mounts several
 * components never creates more than one anonymous user.
 *
 * Throws if sign-in fails (e.g. offline); callers decide how to surface retry.
 */
export function ensureSession(): Promise<Session> {
  if (inflight) return inflight;
  inflight = (async () => {
    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    if (data.session) return data.session;

    const { data: signIn, error } = await supabase.auth.signInAnonymously();
    if (error) throw error;
    if (!signIn.session) throw new Error("Anonymous sign-in returned no session.");
    return signIn.session;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
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
