import { registerMedia } from "@/lib/game/rpc";
import { ensureSession } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/client";
import { createUploadQueue, type UploadQueue } from "@/lib/media/uploadQueue";

let queue: UploadQueue | null = null;

/**
 * The app's one upload queue (browser only), wired to the real Supabase
 * client: Storage with the anonymous session, then the `register_media` RPC.
 * Shared by every square so uploads stay sequential across the board.
 */
export function getDefaultUploadQueue(): UploadQueue {
  queue ??= createUploadQueue({
    storage: async () => {
      await ensureSession();
      return createClient().storage;
    },
    registerMedia: (gameId, position, storagePath, kind) =>
      registerMedia({ game_id: gameId, position, storage_path: storagePath, kind }),
  });
  return queue;
}
