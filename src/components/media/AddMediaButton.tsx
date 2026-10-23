"use client";

import { Camera, Check, Images, RotateCw, X } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";
import { PencilButton } from "@/components/ui/PencilButton";
import { mediaErrorCopy } from "@/lib/media/errors";
import { prepareMedia } from "@/lib/media/prepare";
import type { UploadItem, UploadQueue } from "@/lib/media/uploadQueue";
import { useUploadQueue } from "@/lib/media/useUploadQueue";

type Props = {
  gameId: string;
  position: number;
  playerId: string;
  /** Defaults to the app-wide queue; the dev lab injects a fake one. */
  queue?: UploadQueue;
  /** Injectable for tests. */
  prepare?: typeof prepareMedia;
};

const ACCEPT = "image/*,video/*";
const INPUT_CLASS = "sr-only";

/**
 * Camera-first "Add photo/video" for one square. Picking a file compresses /
 * checks it, then hands it to the background upload queue; status shows inline
 * under the button and nothing here ever blocks the board (no modal, no
 * spinner overlay). A second, quieter control picks from the library for
 * shots taken earlier with the phone's own camera app.
 */
export function AddMediaButton({ gameId, position, playerId, queue, prepare = prepareMedia }: Props) {
  const { items, enqueue, retry, dismiss } = useUploadQueue(queue);
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);
  const [preparing, setPreparing] = useState(0);
  const [rejection, setRejection] = useState<string | null>(null);

  const mine = items.filter((i) => i.gameId === gameId && i.position === position && i.playerId === playerId);

  const onChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    // Reset so picking the same file again still fires `change`.
    input.value = "";
    if (files.length === 0) return;
    setRejection(null);
    for (const file of files) {
      setPreparing((n) => n + 1);
      try {
        const prepared = await prepare(file);
        enqueue({ gameId, position, prepared, playerId });
      } catch (error) {
        setRejection(mediaErrorCopy(error));
      } finally {
        setPreparing((n) => n - 1);
      }
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="add-media-block">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <PencilButton variant="secondary" onClick={() => camera.current?.click()} data-testid="add-media">
          <Camera aria-hidden className="size-5" strokeWidth={2.25} />
          Add photo/video
        </PencilButton>
        <button
          type="button"
          onClick={() => library.current?.click()}
          data-testid="add-media-library"
          className="inline-flex min-h-11 items-center gap-1.5 px-2 text-lg text-ink-soft underline decoration-ink-faint decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-ink"
        >
          <Images aria-hidden className="size-5" strokeWidth={2} />
          From library
        </button>
        <input
          ref={camera}
          type="file"
          accept={ACCEPT}
          capture="environment"
          className={INPUT_CLASS}
          tabIndex={-1}
          aria-hidden
          onChange={(e) => void onChange(e)}
          data-testid="add-media-input"
        />
        <input
          ref={library}
          type="file"
          accept={ACCEPT}
          multiple
          className={INPUT_CLASS}
          tabIndex={-1}
          aria-hidden
          onChange={(e) => void onChange(e)}
          data-testid="add-media-library-input"
        />
      </div>
      <ul aria-live="polite" className="flex min-w-0 flex-col" data-testid="media-status-list">
        {preparing > 0 ? (
          <li className="min-h-7 text-lg leading-7 text-ink-soft" data-testid="media-preparing">
            Getting it ready…
          </li>
        ) : null}
        {rejection ? (
          <li className="flex min-h-7 min-w-0 items-start gap-1 text-lg leading-7 text-danger" data-testid="media-rejection">
            <span className="min-w-0 break-words">{rejection}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setRejection(null)}
              className="-my-2 inline-flex size-11 shrink-0 items-center justify-center text-ink-soft"
            >
              <X aria-hidden className="size-4" strokeWidth={2.5} />
            </button>
          </li>
        ) : null}
        {mine.map((item) => (
          <StatusLine key={item.id} item={item} onRetry={() => retry(item.id)} onDismiss={() => dismiss(item.id)} />
        ))}
      </ul>
    </div>
  );
}

function StatusLine({ item, onRetry, onDismiss }: { item: UploadItem; onRetry: () => void; onDismiss: () => void }) {
  const what = item.kind === "video" ? "Video" : "Photo";
  const common = "flex min-h-7 min-w-0 items-center gap-1.5 text-lg leading-7";
  if (item.state === "done") {
    return (
      <li className={common} data-testid="media-status" data-state={item.state}>
        <Check aria-hidden className="size-4 shrink-0" strokeWidth={3} />
        {what} added
      </li>
    );
  }
  if (item.state === "failed" && item.retryable) {
    return (
      <li className={common} data-testid="media-status" data-state={item.state}>
        <button
          type="button"
          onClick={onRetry}
          data-testid="media-retry"
          className="-my-2 inline-flex min-h-11 min-w-0 items-center gap-1.5 text-left text-danger underline decoration-2 underline-offset-4"
        >
          <RotateCw aria-hidden className="size-4 shrink-0" strokeWidth={2.5} />
          Upload failed — tap to retry
        </button>
      </li>
    );
  }
  if (item.state === "failed") {
    return (
      <li className={`${common} text-danger`} data-testid="media-status" data-state={item.state}>
        <span className="min-w-0 break-words">{item.error}</span>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="-my-2 inline-flex size-11 shrink-0 items-center justify-center text-ink-soft"
        >
          <X aria-hidden className="size-4" strokeWidth={2.5} />
        </button>
      </li>
    );
  }
  return (
    <li className={`${common} text-ink-soft`} data-testid="media-status" data-state={item.state}>
      {what} uploading…
    </li>
  );
}
