import { ensureSession } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/client";
import { MEDIA_BUCKET } from "@/lib/media/uploadQueue";

/**
 * Short-lived signed URLs for the private `game-media` bucket (the only way
 * media is ever shown; Storage RLS lets only game members sign). Requests go
 * out in batches of ≤ 50 paths; results are cached in memory per path and
 * re-signed once less than 5 minutes of validity remain.
 */

type SignedUrlRow = { path: string | null; signedUrl: string | null; error: string | null };
export type SignedUrlBucketLike = {
  createSignedUrls(paths: string[], expiresIn: number): PromiseLike<{ data: SignedUrlRow[] | null; error: unknown }>;
};
export type SignedUrlStorageLike = { from(bucket: string): SignedUrlBucketLike };

/** path → signed URL. Paths Storage refused (missing object, not a member) are left out. */
export type SignedUrlMap = Record<string, string>;
export type GetSignedUrls = (paths: string[], expiresIn?: number) => Promise<SignedUrlMap>;

export type SignedUrlCacheDeps = {
  storage: SignedUrlStorageLike | (() => SignedUrlStorageLike | Promise<SignedUrlStorageLike>);
  now?: () => number;
  batchSize?: number;
  refreshMarginMs?: number;
};

export const SIGNED_URL_TTL_SEC = 3600;
export const SIGNED_URL_BATCH = 50;
export const SIGNED_URL_REFRESH_MARGIN_MS = 5 * 60_000;

export class SignedUrlError extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super("Couldn't load the album. Check your connection and try again.");
    this.name = "SignedUrlError";
    this.cause = cause;
  }
}

export function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function createSignedUrlCache(deps: SignedUrlCacheDeps) {
  const now = deps.now ?? Date.now;
  const batchSize = Math.max(1, Math.min(deps.batchSize ?? SIGNED_URL_BATCH, SIGNED_URL_BATCH));
  const margin = deps.refreshMarginMs ?? SIGNED_URL_REFRESH_MARGIN_MS;
  const cache = new Map<string, { url: string; expiresAt: number }>();

  const getStorage = async () => (typeof deps.storage === "function" ? await deps.storage() : deps.storage);
  const fresh = (path: string) => {
    const entry = cache.get(path);
    return entry && entry.expiresAt - now() > margin ? entry.url : null;
  };

  const getSignedUrls: GetSignedUrls = async (paths, expiresIn = SIGNED_URL_TTL_SEC) => {
    const unique = [...new Set(paths.filter(Boolean))];
    const missing = unique.filter((path) => fresh(path) === null);
    if (missing.length > 0) {
      let storage: SignedUrlStorageLike;
      try {
        storage = await getStorage();
      } catch (cause) {
        throw new SignedUrlError(cause);
      }
      await Promise.all(
        chunk(missing, batchSize).map(async (batch) => {
          const requestedAt = now();
          let result: { data: SignedUrlRow[] | null; error: unknown };
          try {
            result = await storage.from(MEDIA_BUCKET).createSignedUrls(batch, expiresIn);
          } catch (cause) {
            throw new SignedUrlError(cause);
          }
          if (result.error || !result.data) throw new SignedUrlError(result.error);
          for (const row of result.data) {
            if (row.path && row.signedUrl && !row.error) {
              cache.set(row.path, { url: row.signedUrl, expiresAt: requestedAt + expiresIn * 1000 });
            }
          }
        }),
      );
    }
    const out: SignedUrlMap = {};
    for (const path of unique) {
      const entry = cache.get(path);
      if (entry) out[path] = entry.url;
    }
    return out;
  };

  return { getSignedUrls, clear: () => cache.clear() };
}

let defaultCache: ReturnType<typeof createSignedUrlCache> | null = null;

/** Signed URLs via the browser client (anonymous session ensured first). */
export const getSignedUrls: GetSignedUrls = (paths, expiresIn) => {
  defaultCache ??= createSignedUrlCache({
    storage: async () => {
      await ensureSession();
      return createClient().storage;
    },
  });
  return defaultCache.getSignedUrls(paths, expiresIn);
};
