"use client";

import { useEffect, useMemo, useState } from "react";
import { MediaActions } from "@/components/media/MediaActions";
import { PaperPage, PaperTitle } from "@/components/paper/PaperPage";
import { Recap } from "@/components/recap/Recap";
import { PencilButton } from "@/components/ui/PencilButton";
import type { Game, Media, Square } from "@/lib/game/types";
import { checkVideo } from "@/lib/media/checkVideo";
import { compressImage } from "@/lib/media/compressImage";
import { isMediaError } from "@/lib/media/errors";
import { prepareMedia } from "@/lib/media/prepare";
import type { SignedUrlMap } from "@/lib/media/signedUrls";
import { createUploadQueue, type StorageLike, type UploadOptions } from "@/lib/media/uploadQueue";
import {
  LAB_GAME,
  LAB_MEDIA_SPEC,
  LAB_PLAYERS,
  LAB_SQUARES,
  blobToDataUrl,
  labMedia,
  photoDataUrl,
  recordCanvasWebm,
} from "./fakeData";

type RunOptions = { fakeDurationSec?: number };
type LabResult = Record<string, unknown>;

declare global {
  interface Window {
    __mediaLab?: {
      run: (file: File, opts?: RunOptions) => Promise<LabResult>;
      prepareMedia: typeof prepareMedia;
      compressImage: typeof compressImage;
      checkVideo: typeof checkVideo;
    };
  }
}

async function describeOutput(file: File, opts: RunOptions): Promise<LabResult> {
  try {
    const prepared = await prepareMedia(
      file,
      opts.fakeDurationSec !== undefined ? { video: { probeDuration: async () => opts.fakeDurationSec! } } : {},
    );
    const result: LabResult = {
      ok: true,
      kind: prepared.kind,
      ext: prepared.ext,
      contentType: prepared.contentType,
      blobType: prepared.blob.type,
      size: prepared.blob.size,
      width: prepared.width ?? null,
      height: prepared.height ?? null,
      durationSec: prepared.durationSec ?? null,
      passthrough: prepared.blob === file,
    };
    if (prepared.kind === "photo") {
      // Decode the output again to prove its real pixel size.
      const bitmap = await createImageBitmap(prepared.blob);
      result.decodedWidth = bitmap.width;
      result.decodedHeight = bitmap.height;
      bitmap.close();
    }
    return result;
  } catch (error) {
    return isMediaError(error)
      ? { ok: false, code: error.code, message: error.message }
      : { ok: false, code: "unexpected", message: String(error) };
  }
}

// ---------------------------------------------------------------------------
// Fake upload backend for the MediaActions demo (no hosted Storage here).

type LabUpload = { path: string; options: UploadOptions; size: number };
const labNet = { offline: false, uploads: [] as LabUpload[], listeners: new Set<() => void>() };
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const labStorage: StorageLike = {
  from: () => ({
    async upload(path, blob, options) {
      await delay(250);
      if (labNet.offline) throw new TypeError("Failed to fetch");
      labNet.uploads = [...labNet.uploads, { path, options, size: blob.size }];
      labNet.listeners.forEach((l) => l());
      return { data: { path }, error: null };
    },
    async remove() {
      return { data: [], error: null };
    },
  }),
};

const labQueue = createUploadQueue({
  storage: labStorage,
  registerMedia: async (gameId, position, storagePath, kind): Promise<Media> => {
    await delay(100);
    if (labNet.offline) throw new TypeError("Failed to fetch");
    return {
      id: `lab-${storagePath}`,
      game_id: gameId,
      square_id: `sq-${position}`,
      player_id: "jake",
      storage_path: storagePath,
      kind,
      created_at: new Date().toISOString(),
    };
  },
  backoffMs: () => 100,
});

const LIVE_GAME: Game = {
  ...LAB_GAME,
  status: "active",
  auto_end_at: "2099-01-01T00:00:00.000Z",
  expires_at: "2099-02-01T00:00:00.000Z",
};

function useLabUploads() {
  const [uploads, setUploads] = useState<LabUpload[]>([]);
  useEffect(() => {
    const listener = () => setUploads(labNet.uploads);
    labNet.listeners.add(listener);
    return () => {
      labNet.listeners.delete(listener);
    };
  }, []);
  return uploads;
}

// ---------------------------------------------------------------------------

type Album = { media: Media[]; urls: SignedUrlMap };

export function MediaLab() {
  const [result, setResult] = useState<LabResult | null>(null);
  const [album, setAlbum] = useState<Album | null>(null);
  const [empty, setEmpty] = useState(false);
  const [offline, setOffline] = useState(false);
  const uploads = useLabUploads();

  useEffect(() => {
    window.__mediaLab = {
      run: async (file, opts = {}) => {
        setResult(null);
        const out = await describeOutput(file, opts);
        setResult(out);
        return out;
      },
      prepareMedia,
      compressImage,
      checkVideo,
    };
    return () => {
      delete window.__mediaLab;
    };
  }, []);

  // Build the fake album: canvas photos as data: URLs and one MediaRecorder clip.
  useEffect(() => {
    let live = true;
    (async () => {
      const video = await recordCanvasWebm(1200, "Karaoke").catch(() => null);
      const media = labMedia(video !== null);
      const urls: SignedUrlMap = {};
      for (const m of media) {
        const spec = LAB_MEDIA_SPEC.find((s) => s.id === m.id)!;
        const square = LAB_SQUARES[spec.position];
        urls[m.storage_path] =
          m.kind === "video" && video ? await blobToDataUrl(video) : photoDataUrl(`${square.label} · ${spec.at}`, spec.color);
      }
      if (live) setAlbum({ media, urls });
    })();
    return () => {
      live = false;
    };
  }, []);

  const getSignedUrls = useMemo(
    () => async (paths: string[]) => {
      const out: SignedUrlMap = {};
      for (const p of paths) if (album?.urls[p]) out[p] = album.urls[p];
      return out;
    },
    [album],
  );

  const liveSquares = useMemo<Square[]>(() => LAB_SQUARES, []);
  const openSquare = liveSquares[5];
  const doneSquare = liveSquares[7];

  return (
    <PaperPage>
      <PaperTitle>Media lab</PaperTitle>
      <p className="text-lg leading-7 text-ink-soft">Dev only. Real browser processing, fake backend.</p>

      <section className="mt-7 flex min-w-0 flex-col gap-2" aria-label="Prepare">
        <h2 className="text-2xl leading-7">1. Prepare a file</h2>
        <input
          type="file"
          data-testid="lab-file"
          className="min-h-11 w-full min-w-0 text-base"
          onChange={async (e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (file) await window.__mediaLab?.run(file);
          }}
        />
        <pre
          data-testid="lab-result"
          data-ready={result ? "true" : "false"}
          className="min-h-14 w-full min-w-0 overflow-x-auto whitespace-pre-wrap break-all text-sm leading-5"
        >
          {result ? JSON.stringify(result, null, 2) : "No file yet."}
        </pre>
      </section>

      <section className="mt-7 flex min-w-0 flex-col gap-3" aria-label="Media actions">
        <h2 className="text-2xl leading-7">2. Square sheet media row</h2>
        <PencilButton
          variant="quiet"
          data-testid="lab-offline"
          data-offline={offline}
          onClick={() => {
            labNet.offline = !labNet.offline;
            setOffline(labNet.offline);
          }}
        >
          {offline ? "Network: offline (tap to go online)" : "Network: online (tap to go offline)"}
        </PencilButton>
        <div data-testid="lab-actions-done" className="flex min-w-0 flex-col gap-1">
          <p className="text-xl leading-7">{doneSquare.label}</p>
          <MediaActions game={LIVE_GAME} square={doneSquare} me={LAB_PLAYERS[0]} players={LAB_PLAYERS} queue={labQueue} />
        </div>
        <div data-testid="lab-actions-open" className="flex min-w-0 flex-col gap-1">
          <p className="text-xl leading-7">{openSquare.label}</p>
          <MediaActions game={LIVE_GAME} square={openSquare} me={LAB_PLAYERS[0]} players={LAB_PLAYERS} queue={labQueue} />
        </div>
        <ul data-testid="lab-uploads" className="flex min-w-0 flex-col text-sm leading-5">
          {uploads.map((u) => (
            <li key={u.path} data-testid="lab-upload" data-path={u.path} data-options={JSON.stringify(u.options)} className="break-all">
              {u.path}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-7 flex min-w-0 flex-col gap-3" aria-label="Recap">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <h2 className="text-2xl leading-7">3. Recap</h2>
          <PencilButton variant="quiet" data-testid="lab-recap-empty" onClick={() => setEmpty((v) => !v)}>
            {empty ? "Show with media" : "Show without media"}
          </PencilButton>
        </div>
        {album ? (
          <div data-testid="lab-recap" data-video={album.media.some((m) => m.kind === "video")}>
            <Recap
              game={LAB_GAME}
              players={LAB_PLAYERS}
              squares={LAB_SQUARES}
              media={empty ? [] : album.media}
              getSignedUrls={getSignedUrls}
            />
          </div>
        ) : (
          <p data-testid="lab-recap-loading" className="text-lg leading-7 text-ink-soft">
            Making a fake album…
          </p>
        )}
      </section>
    </PaperPage>
  );
}
