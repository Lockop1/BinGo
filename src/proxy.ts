import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

// Next.js 16 renamed `middleware` to `proxy`. This runs before every matched
// request and keeps the anonymous Supabase session fresh.
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Skip Next internals, the cron route (no user session) and static files.
    "/((?!_next/static|_next/image|api/cron|favicon.ico|manifest.webmanifest|sw.js|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|js|css|map|txt|woff2?)$).*)",
  ],
};
