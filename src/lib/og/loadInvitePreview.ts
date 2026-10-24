import "server-only";
import { normalizeJoinCode } from "@/lib/game/links";
import { peekGamePublic } from "@/lib/game/publicRpc";
import { asInvitePreview, isPlausibleJoinCode, type InvitePreview } from "./preview";

/** Link unfurlers give up after a few seconds; a slow backend gets the generic preview instead. */
const LOOKUP_TIMEOUT_MS = 2500;

export type LoadedInvite = {
  /** The join code normalized like the DB does (upper-case, alphanumerics only). */
  code: string;
  /** The game's public preview, or null (bad code, unknown game, error or timeout). */
  preview: InvitePreview | null;
};

/**
 * Looks up the public preview for an invite link's code via `peek_game_public` (anon key,
 * no session, no cookies). Never throws: anything unexpected yields `preview: null`, which
 * renders the generic "Join the game" copy and card.
 */
export async function loadInvitePreview(rawCode: string): Promise<LoadedInvite> {
  const code = normalizeJoinCode(rawCode);
  if (!isPlausibleJoinCode(code)) return { code, preview: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS);
    });
    const result: unknown = await Promise.race([peekGamePublic(code), timeout]);
    return { code, preview: asInvitePreview(result) };
  } catch {
    return { code, preview: null };
  } finally {
    clearTimeout(timer);
  }
}
