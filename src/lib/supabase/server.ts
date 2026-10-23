import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { getSupabasePublicEnv } from "@/lib/env";

/**
 * Supabase client for Server Components, Server Functions and Route Handlers.
 * Acts as the signed-in (anonymous) user via their auth cookies, so RLS applies.
 *
 * Create a new client per request; never share one across requests.
 */
export async function createClient() {
  const { url, anonKey } = getSupabasePublicEnv();
  // `cookies()` is async in Next.js 15+.
  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // Safe to ignore: src/proxy.ts refreshes the session on every request.
        }
      },
    },
  });
}
