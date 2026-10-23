import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getSupabasePublicEnv } from "@/lib/env";

/**
 * Service-role Supabase client. BYPASSES RLS.
 *
 * FOR THE CLEANUP CRON ROUTE ONLY (src/app/api/cron/cleanup/route.ts).
 * Never import this from client code, components, pages, or any other route.
 * `server-only` makes a client-bundle import fail the build, and an ESLint
 * `no-restricted-imports` rule blocks imports from anywhere else in src/.
 *
 * SUPABASE_SERVICE_ROLE_KEY must never be prefixed NEXT_PUBLIC_.
 */
export function createAdminClient() {
  const { url } = getSupabasePublicEnv();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error(
      "Missing SUPABASE_SERVICE_ROLE_KEY. Set it (server-only, no NEXT_PUBLIC_ prefix) in " +
        ".env.local for local runs or in the Vercel project env for the cron route.",
    );
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
