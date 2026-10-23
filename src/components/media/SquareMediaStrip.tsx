"use client";

import { ImageOff, Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Media } from "@/lib/game/types";
import { getSignedUrls as defaultGetSignedUrls, type GetSignedUrls, type SignedUrlMap } from "@/lib/media/signedUrls";

type Props = {
  /** This square's media, in upload order. */
  media: readonly Media[];
  /** Opens the album's story viewer at this item. */
  onOpen: (mediaId: string) => void;
  /** Defaults to real signed URLs from `game-media`. */
  getSignedUrls?: GetSignedUrls;
};

/** "Photos · 2", "Videos · 1" or "Photos & videos · 3". */
export function stripHeading(media: readonly Pick<Media, "kind">[]): string {
  const videos = media.filter((m) => m.kind === "video").length;
  const what = videos === 0 ? "Photos" : videos === media.length ? "Videos" : "Photos & videos";
  return `${what} · ${media.length}`;
}

/**
 * A square's photos and videos as a small row of thumbnails in its sheet.
 * Signed URLs are requested when this mounts, i.e. when the sheet opens
 * (never for the grid); the cache in lib/media/signedUrls keeps reopening
 * cheap. Each thumbnail opens the album story at that item.
 */
export function SquareMediaStrip({ media, onOpen, getSignedUrls = defaultGetSignedUrls }: Props) {
  const [urls, setUrls] = useState<SignedUrlMap>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [signError, setSignError] = useState(false);
  const key = useMemo(() => media.map((m) => m.storage_path).join("\n"), [media]);

  useEffect(() => {
    if (!key) return;
    let live = true;
    getSignedUrls(key.split("\n"))
      .then((map) => {
        if (!live) return;
        setUrls((prev) => ({ ...prev, ...map }));
        setSignError(false);
      })
      .catch(() => {
        if (live) setSignError(true);
      });
    return () => {
      live = false;
    };
  }, [key, getSignedUrls]);

  if (media.length === 0) return null;

  return (
    <section className="flex min-w-0 flex-col gap-1" aria-label="Photos and videos" data-testid="square-media">
      <h3 className="text-lg leading-7 text-ink-soft" data-testid="square-media-heading">
        {stripHeading(media)}
      </h3>
      <ul className="flex min-w-0 flex-wrap gap-2">
        {media.map((m, i) => {
          const url = urls[m.storage_path];
          const broken = failed[m.storage_path] || (signError && !url);
          const what = m.kind === "video" ? "video" : "photo";
          return (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => onOpen(m.id)}
                aria-label={`Open ${what} ${i + 1} of ${media.length} in the album`}
                data-testid="square-media-thumb"
                data-kind={m.kind}
                className="pencil-border relative flex size-16 items-center justify-center overflow-hidden bg-paper text-ink-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                {broken ? (
                  <ImageOff aria-hidden className="size-5" strokeWidth={2} />
                ) : !url ? null : m.kind === "video" ? (
                  <video
                    src={`${url}#t=0.1`}
                    className="pointer-events-none size-full object-cover"
                    muted
                    playsInline
                    preload="metadata"
                    onError={() => setFailed((f) => ({ ...f, [m.storage_path]: true }))}
                  />
                ) : (
                  // Signed URLs from a private bucket; next/image's optimizer can't fetch them.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={url}
                    alt=""
                    className="pointer-events-none size-full object-cover"
                    draggable={false}
                    loading="lazy"
                    onError={() => setFailed((f) => ({ ...f, [m.storage_path]: true }))}
                  />
                )}
                {m.kind === "video" && !broken ? (
                  <span aria-hidden className="absolute inset-0 flex items-center justify-center">
                    <span className="rounded-full bg-black/55 p-1 text-white">
                      <Play className="size-4" strokeWidth={2.5} />
                    </span>
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
