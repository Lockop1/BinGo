import { createHash, timingSafeEqual } from "node:crypto";
import { connection } from "next/server";
import { runCleanup } from "@/lib/cleanup/runCleanup";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Daily cleanup cron (Vercel Cron, see vercel.json). Vercel sends
 * `GET` with `Authorization: Bearer ${CRON_SECRET}`.
 *
 * Auto-ends overdue active games, deletes storage objects of expired games,
 * then deletes the expired game rows (cascade). Logic lives in
 * @/lib/cleanup/runCleanup; this file is the only place the service-role
 * client may be created (ESLint enforces it).
 *
 * Responses: 500 if CRON_SECRET is unset (fail closed), 401 on a missing or
 * wrong bearer, 200 with the report otherwise (even if per-game errors were
 * recorded, so the run shows as succeeded and the body tells the story),
 * 500 only if the run itself threw.
 */

// Route segment config. With `cacheComponents: true` (next.config.ts), Next 16
// rejects `dynamic` and `runtime` at build time ("not compatible with
// nextConfig.cacheComponents"). Their effects hold anyway: `await connection()`
// below makes every request dynamic (never prerendered or cached), and Cache
// Components always uses the Node.js runtime (node:crypto works).
export const maxDuration = 60;

/** Constant-time comparison; hashing first gives equal-length buffers and hides the length. */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export async function GET(request: Request) {
  // Always run at request time; never prerender or cache this route.
  await connection();

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cron/cleanup] CRON_SECRET is not set; refusing to run.");
    return Response.json(
      { error: "CRON_SECRET is not configured on the server; cleanup is disabled." },
      { status: 500 },
    );
  }

  const header = request.headers.get("authorization") ?? "";
  if (!safeEqual(header, `Bearer ${secret}`)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const report = await runCleanup(createAdminClient());
    console.info(
      `[cron/cleanup] ended=${report.endedGames} expired=${report.expiredGames} ` +
        `deletedGames=${report.deletedGames} deletedObjects=${report.deletedObjects} ` +
        `errors=${report.errors.length} durationMs=${report.durationMs}` +
        (report.errors.length ? ` firstError=${JSON.stringify(report.errors[0])}` : ""),
    );
    return Response.json(report, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[cron/cleanup] run failed: ${message}`);
    return Response.json({ error: "Cleanup run failed", message }, { status: 500 });
  }
}
