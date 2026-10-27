import { createClient } from "@/lib/supabase/client";

/**
 * The game id if this user is a player in the game with this code, else null. Filters on
 * `players.user_id` explicitly (inner join), so a membership is never inferred from merely
 * being able to read the game row; RLS still limits what is readable on top of this.
 * Never rejects (any error reads as "not a member").
 */
export async function findMembership(code: string, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const { data, error } = await createClient()
    .from("games")
    .select("id, players!inner(user_id)")
    .eq("join_code", code)
    .eq("players.user_id", userId)
    .maybeSingle();
  if (error) return null;
  return data?.id ?? null;
}
