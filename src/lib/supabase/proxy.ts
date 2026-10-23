import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { readSupabasePublicEnv } from "@/lib/env";

let warnedMissingEnv = false;

/**
 * Refreshes the Supabase auth session for the incoming request and writes any
 * updated auth cookies (plus no-cache headers) onto the response.
 * Called from src/proxy.ts.
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

  const supabase = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
        // Cache-Control etc. so a CDN never serves one user's session cookie to another.
        Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value));
      },
    },
  });

  // Do not run code between createServerClient and getUser(): getUser()
  // revalidates the token with Supabase Auth and triggers the refresh above.
  await supabase.auth.getUser();

  return response;
}
