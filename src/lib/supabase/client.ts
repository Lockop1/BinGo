import { createBrowserClient } from "@supabase/ssr";
import { getSupabasePublicEnv } from "@/lib/env";
import type { Database } from "@/types/database";

/**
 * Supabase client for Client Components (runs in the browser).
 * Uses the anon key only; every read/write goes through RLS and RPCs.
 *
 * `@supabase/ssr` returns one shared instance per browser tab (its
 * `isSingleton` default), so calling this repeatedly is cheap and every caller
 * sees the same auth session.
 */
export function createClient() {
  const { url, anonKey } = getSupabasePublicEnv();
  return createBrowserClient<Database>(url, anonKey);
}

export type BrowserSupabaseClient = ReturnType<typeof createClient>;
