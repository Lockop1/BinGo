/**
 * Public (browser-safe) environment variables.
 *
 * Nothing here throws at import time, so `next build` passes without a
 * `.env.local`. The client factories call `getSupabasePublicEnv()` when a
 * client is actually created, which is where a missing value fails loudly.
 *
 * Each variable is read with a literal `process.env.NEXT_PUBLIC_*` access so
 * Next.js can inline it into the browser bundle.
 */

export type SupabasePublicEnv = {
  url: string;
  anonKey: string;
};

/** Returns the Supabase public env, or `null` if either value is missing. */
export function readSupabasePublicEnv(): SupabasePublicEnv | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

/** Returns the Supabase public env, throwing a setup hint if anything is missing. */
export function getSupabasePublicEnv(): SupabasePublicEnv {
  const env = readSupabasePublicEnv();
  if (env) return env;

  const missing = [
    !process.env.NEXT_PUBLIC_SUPABASE_URL && "NEXT_PUBLIC_SUPABASE_URL",
    !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  ].filter(Boolean);

  throw new Error(
    `Missing Supabase environment variable(s): ${missing.join(", ")}.\n` +
      "Copy .env.example to .env.local and fill in the values from your Supabase " +
      "project (Project Settings > API), then restart `npm run dev`. " +
      "See README.md > Local setup.",
  );
}
