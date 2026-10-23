import { connection } from "next/server";

/**
 * Daily cleanup cron (Vercel Cron). Placeholder until Phase 8.
 *
 * Phase 8 will: require `Authorization: Bearer ${CRON_SECRET}`, then use the
 * admin client from @/lib/supabase/admin to auto-end active games past
 * auto_end_at, delete storage objects for expired games, then delete the
 * expired game rows (cascade).
 */
export async function GET() {
  // Always run at request time; never prerender or cache this route.
  await connection();
  return Response.json({ error: "Not implemented" }, { status: 501 });
}
