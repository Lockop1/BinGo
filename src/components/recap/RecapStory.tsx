"use client";

import { AnimatePresence, motion, useReducedMotion, type PanInfo } from "motion/react";
import { Download, Pause, Volume2, VolumeX, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ColorChip } from "@/components/recap/ColorChip";
import { squareTitle, type RecapItem } from "@/components/recap/recapItems";
import { fetchBlob, saveFile } from "@/components/recap/save";
import type { GetSignedUrls, SignedUrlMap } from "@/lib/media/signedUrls";

export const PHOTO_MS = 5000;
/** Presses longer than this are holds (pause), not taps (navigate). */
const HOLD_MS = 250;
const SWIPE_PX = 60;

type Props = {
  items: readonly RecapItem[];
  names: readonly string[];
  getSignedUrls: GetSignedUrls;
  onClose: () => void;
  startIndex?: number;
};

type SaveState = "idle" | "saving" | "saved" | "failed";

/**
 * Full-screen story viewer over a dark "cinema" backdrop: one item at a time
 * in board order, segmented progress at the top, tap left/right (or swipe) to
 * move, hold to pause, photos advance after 5 s, videos loop muted with a
 * tap-to-unmute. Reduced motion: items crossfade instead of sliding.
 */
export function RecapStory(props: Props) {
  if (typeof document === "undefined") return null;
  return createPortal(<StoryViewer {...props} />, document.body);
}

function StoryViewer({ items, names, getSignedUrls, onClose, startIndex = 0 }: Props) {
  const reduce = useReducedMotion();
  const [index, setIndex] = useState(() => Math.min(Math.max(0, startIndex), Math.max(0, items.length - 1)));
  const [direction, setDirection] = useState(1);
  const [urls, setUrls] = useState<SignedUrlMap>({});
  const [urlError, setUrlError] = useState(false);
  const [held, setHeld] = useState(false);
  const [muted, setMuted] = useState(true);
  const [ready, setReady] = useState<Record<string, boolean>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [save, setSave] = useState<{ id: string; state: SaveState } | null>(null);

  const closeButton = useRef<HTMLButtonElement>(null);
  const activeBar = useRef<HTMLSpanElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const press = useRef<{ at: number; dragged: boolean }>({ at: 0, dragged: false });
  const blobs = useRef(new Map<string, Blob>());
  const onCloseRef = useRef(onClose);
  // Read by the photo clock each frame, so holding never restarts the timer.
  const running = useRef({ loaded: false, held: false });

  const item = items[index];
  const path = item?.media.storage_path;
  const url = path ? urls[path] : undefined;
  const isVideo = item?.media.kind === "video";
  const loaded = path ? ready[path] === true : false;
  const paused = held;

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    running.current = { loaded, held };
  }, [loaded, held]);

  const go = useCallback(
    (delta: number) => {
      const next = index + delta;
      if (next < 0) return;
      if (next >= items.length) {
        onCloseRef.current();
        return;
      }
      setDirection(delta);
      setIndex(next);
    },
    [index, items.length],
  );

  // Sign every path up front, then again per item (the cache only re-signs near expiry).
  useEffect(() => {
    let live = true;
    const wanted = index === 0 ? items.map((i) => i.media.storage_path) : path ? [path] : [];
    getSignedUrls(wanted)
      .then((map) => {
        if (!live) return;
        setUrls((prev) => ({ ...prev, ...map }));
        setUrlError(false);
      })
      .catch(() => {
        if (live) setUrlError(true);
      });
    return () => {
      live = false;
    };
  }, [getSignedUrls, items, index, path]);

  // Prefetch the current photo so Save can open the share sheet straight away
  // (iOS needs the tap's activation; a slow fetch first would lose it). Videos are
  // fetched only when saved, to spare mobile data.
  useEffect(() => {
    if (!url || !path || isVideo || blobs.current.has(path)) return;
    const controller = new AbortController();
    fetchBlob(url, controller.signal)
      .then((blob) => blobs.current.set(path, blob))
      .catch(() => {});
    return () => controller.abort();
  }, [url, path, isVideo]);

  // Focus, scroll lock and keys.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus({ preventScroll: true });
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
      else if (event.key === "ArrowRight") go(1);
      else if (event.key === "ArrowLeft") go(-1);
      else return;
      event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [go]);

  // Photo clock: fills the active bar and advances after PHOTO_MS (not past the last item).
  useEffect(() => {
    const bar = activeBar.current;
    if (bar) bar.style.transform = "scaleX(0)";
    if (!item || isVideo) return;
    let elapsed = 0;
    let last = performance.now();
    let frame = 0;
    const tick = (t: number) => {
      const { loaded: shown, held: holding } = running.current;
      if (shown && !holding && document.visibilityState === "visible") elapsed += t - last;
      last = t;
      const fraction = Math.min(1, elapsed / PHOTO_MS);
      if (activeBar.current) activeBar.current.style.transform = `scaleX(${fraction})`;
      if (fraction >= 1) {
        if (index < items.length - 1) {
          setDirection(1);
          setIndex(index + 1);
        }
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [item, isVideo, index, items.length]);

  // Video: follow playback for the bar, pause while held, honour mute.
  useEffect(() => {
    const v = video.current;
    if (!v || !isVideo) return;
    v.muted = muted;
    if (held) v.pause();
    else void v.play().catch(() => {});
  }, [isVideo, muted, held, url]);

  const onTimeUpdate = () => {
    const v = video.current;
    if (v && activeBar.current && Number.isFinite(v.duration) && v.duration > 0) {
      activeBar.current.style.transform = `scaleX(${Math.min(1, v.currentTime / v.duration)})`;
    }
  };

  const onPointerDown = () => {
    press.current = { at: performance.now(), dragged: false };
    setHeld(true);
  };
  const release = () => setHeld(false);
  const onZone = (delta: number, detail: number) => {
    const { at, dragged } = press.current;
    press.current = { at: 0, dragged: false };
    // Keyboard activation (detail 0) always steps; a hold or a swipe already did its job.
    if (detail !== 0 && (dragged || (at > 0 && performance.now() - at > HOLD_MS))) return;
    go(delta);
  };
  const onDragEnd = (_: unknown, info: PanInfo) => {
    press.current.dragged = true;
    setHeld(false);
    if (info.offset.x < -SWIPE_PX || info.velocity.x < -500) go(1);
    else if (info.offset.x > SWIPE_PX || info.velocity.x > 500) go(-1);
  };

  const onSave = async () => {
    if (!item || !path || !url) return;
    const id = item.media.id;
    setSave({ id, state: "saving" });
    try {
      const blob = blobs.current.get(path) ?? (await fetchBlob(url));
      blobs.current.set(path, blob);
      const outcome = await saveFile(blob, names[index] ?? "bingo-night");
      setSave({ id, state: outcome === "dismissed" ? "idle" : "saved" });
    } catch {
      setSave({ id, state: "failed" });
    }
  };
  const saveState = save && item && save.id === item.media.id ? save.state : "idle";

  if (!item) return null;
  const who = item.state === "completed" ? item.completer : null;
  const by = item.uploader && item.uploader.id !== who?.id ? item.uploader : null;
  const what = item.media.kind === "video" ? "video" : "photo";
  const slide = reduce ? 0 : 48;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Recap story"
      data-testid="recap-story"
      data-index={index}
      data-position={item.square.position}
      data-kind={item.media.kind}
      data-paused={paused}
      className="fixed inset-0 z-[70] flex flex-col overflow-hidden bg-[#0b0d10] text-[#f4f1ea] select-none"
    >
      {/* Progress segments */}
      <div className="flex shrink-0 gap-[3px] px-3 pt-[max(0.75rem,env(safe-area-inset-top))]" aria-hidden>
        {items.map((it, i) => (
          <span key={it.media.id} className="h-[3px] min-w-0 flex-1 overflow-hidden rounded-full bg-white/30" data-testid="story-segment">
            <span
              ref={i === index ? activeBar : undefined}
              className="block h-full origin-left bg-white"
              style={{ transform: i < index ? "scaleX(1)" : "scaleX(0)" }}
            />
          </span>
        ))}
      </div>

      <div className="flex min-h-11 shrink-0 items-center justify-between gap-2 pl-4 pr-1">
        <p className="min-w-0 truncate text-base leading-6 text-white/70 tabular-nums" data-testid="story-position">
          {index + 1} of {items.length}
        </p>
        <button
          ref={closeButton}
          type="button"
          onClick={onClose}
          aria-label="Close recap"
          data-testid="story-close"
          className="inline-flex size-11 shrink-0 items-center justify-center focus-visible:outline-2 focus-visible:outline-white"
        >
          <X aria-hidden className="size-7" strokeWidth={2.25} />
        </button>
      </div>

      {/* Stage: drag to swipe, hold to pause, tap zones to step */}
      <motion.div
        className="relative min-h-0 flex-1 touch-pan-y"
        drag="x"
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={reduce ? 0.15 : 0.5}
        dragSnapToOrigin
        onDragStart={() => {
          press.current.dragged = true;
        }}
        onDragEnd={onDragEnd}
        onPointerDown={onPointerDown}
        onPointerUp={release}
        onPointerCancel={release}
        onPointerLeave={release}
      >
        <AnimatePresence initial={false} custom={direction}>
          <motion.div
            key={item.media.id}
            className="absolute inset-0 flex items-center justify-center"
            custom={direction}
            initial={{ opacity: 0, x: direction * slide }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -direction * slide }}
            transition={{ duration: reduce ? 0.25 : 0.22, ease: "easeOut" }}
            data-testid="story-item"
            data-position={item.square.position}
            data-kind={item.media.kind}
          >
            {failed[path] || (urlError && !url) ? (
              <p className="px-6 text-center text-lg text-white/70">Couldn&apos;t load this one.</p>
            ) : !url ? (
              <p className="text-lg text-white/60">Loading…</p>
            ) : isVideo ? (
              <video
                ref={video}
                src={url}
                className="h-full w-full object-contain"
                playsInline
                muted={muted}
                autoPlay
                loop
                preload="auto"
                onLoadedData={() => setReady((r) => ({ ...r, [path]: true }))}
                onTimeUpdate={onTimeUpdate}
                onError={() => setFailed((f) => ({ ...f, [path]: true }))}
                data-testid="story-video"
              />
            ) : (
              // Signed (or data:) URLs from a private bucket; next/image's optimizer can't fetch them.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={url}
                alt={`${squareTitle(item.square)}${who ? `, completed by ${who.display_name}` : ""}`}
                className="h-full w-full object-contain"
                draggable={false}
                onLoad={() => setReady((r) => ({ ...r, [path]: true }))}
                onError={() => setFailed((f) => ({ ...f, [path]: true }))}
                data-testid="story-photo"
              />
            )}
          </motion.div>
        </AnimatePresence>

        <button
          type="button"
          aria-label="Previous"
          data-testid="story-prev"
          onClick={(event) => onZone(-1, event.detail)}
          className="absolute inset-y-0 left-0 w-1/3 focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-white"
        />
        <button
          type="button"
          aria-label="Next"
          data-testid="story-next"
          onClick={(event) => onZone(1, event.detail)}
          className="absolute inset-y-0 right-0 w-2/3 focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-white"
        />
        {paused ? (
          <span className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-black/60 p-2" aria-hidden>
            <Pause className="size-5" strokeWidth={2.5} />
          </span>
        ) : null}
      </motion.div>

      {/* Caption + actions */}
      <div className="flex shrink-0 flex-col gap-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        <p className="font-scoreboard text-[34px] leading-[38px] tracking-wide break-words" data-testid="story-label">
          {squareTitle(item.square)}
        </p>
        <div className="flex min-w-0 items-center gap-2">
          <p className="flex min-w-0 flex-1 items-center gap-2 text-lg leading-7" data-testid="story-player">
            {item.state === "open" ? (
              // Undone after this was added: no completer to credit, so credit the photo.
              <>
                {by ? <ColorChip color={by.color} theme="dark" /> : null}
                <span className="min-w-0 truncate" data-testid="story-uploader">
                  {by ? `${what === "video" ? "Video" : "Photo"} by ${by.display_name}` : `A ${what}`}
                </span>
                <span className="shrink-0 text-base text-white/60" data-testid="story-open">
                  · not crossed off
                </span>
              </>
            ) : (
              <>
                {who ? (
                  <>
                    <ColorChip color={who.color} theme="dark" />
                    <span className="truncate" data-testid="story-completer">
                      {who.display_name}
                    </span>
                  </>
                ) : (
                  <span className="text-white/70">{item.state === "free" ? "On the house" : "Someone"}</span>
                )}
                {by ? (
                  <span className="min-w-0 truncate text-base text-white/60" data-testid="story-uploader">
                    · {what} by {by.display_name}
                  </span>
                ) : null}
              </>
            )}
          </p>
          {isVideo ? (
            <button
              type="button"
              onClick={() => setMuted((m) => !m)}
              aria-pressed={!muted}
              aria-label={muted ? "Unmute" : "Mute"}
              data-testid="story-unmute"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-full border-2 border-white/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              {muted ? <VolumeX aria-hidden className="size-5" strokeWidth={2.25} /> : <Volume2 aria-hidden className="size-5" strokeWidth={2.25} />}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={!url || saveState === "saving"}
            data-testid="story-save"
            className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border-2 border-white/80 px-4 text-lg leading-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            <Download aria-hidden className="size-5" strokeWidth={2.25} />
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : "Save"}
          </button>
        </div>
        <p aria-live="polite" className="min-h-5 text-sm leading-5 text-white/70" data-testid="story-save-status">
          {saveState === "failed" ? "Couldn't save this one. Try again." : null}
        </p>
      </div>
    </div>
  );
}
