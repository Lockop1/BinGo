import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabasePublicEnv } from "@/lib/env";
import { GameError, toGameError } from "@/lib/game/errors";
import type { GamePreview } from "@/lib/game/types";
import type { Database } from "@/types/database";

/**
 * Session-less RPCs, for server code (route handlers, server components,
 * Open Graph images) and anything else that has no signed-in user, such as a
 * link-preview crawler's request. Uses a plain `@supabase/supabase-js` client
 * with the anon key and no auth at all (no session, cookies, storage or token
 * refresh), so every call runs as the `anon` role.
 *
 * `peek_game_public` is the only function `anon` may execute (CLAUDE.md >
 * Database API). Everything else needs a session: use `rpc.ts`.
 */

let anonClient: SupabaseClient<Database> | null = null;

/** One shared client: it holds no user state, so it is safe to reuse across requests. */
function getAnonClient(): SupabaseClient<Database> {
  if (anonClient) return anonClient;
  const { url, anonKey } = getSupabasePublicEnv();
  anonClient = createClient<Database>(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return anonClient;
}

/**
 * A game's public preview by join code (any case, separators ignored): name,
 * effective status, player count, free_center. Throws a `GameError`:
 * `game_not_found` for an unknown or expired code, `unknown` for anything else
 * (network, missing env).
 */
export async function peekGamePublic(code: string): Promise<GamePreview> {
  const call = () => getAnonClient().rpc("peek_game_public", { code });
  let result: Awaited<ReturnType<typeof call>>;
  try {
    result = await call();
  } catch (cause) {
    throw toGameError(cause);
  }
  if (result.error) throw toGameError(result.error);
  const row = result.data;
  if (!row || row.name === null || row.status === null) {
    throw new GameError("game_not_found", new Error("Empty game_preview"));
  }
  return {
    name: row.name,
    status: row.status,
    player_count: row.player_count ?? 0,
    free_center: row.free_center ?? true,
  };
}
