import { MediaError } from "@/lib/media/errors";
import { MB, VIDEO_TYPES, baseMime, type PreparedMedia } from "@/lib/media/types";

/**
 * Video checks after selection (CLAUDE.md > Media rules): ≤ 15 s and ≤ 50 MB,
 * in a format the `game-media` bucket accepts. Videos are uploaded as-is.
 */

export type VideoMetadata = { durationSec: number; width?: number; height?: number };
/** Reads a video's duration (seconds, or metadata). Injectable for tests. */
export type DurationProbe = (file: Blob) => Promise<number | VideoMetadata>;

export type CheckVideoOptions = {
  maxSeconds?: number;
  maxBytes?: number;
  probeDuration?: DurationProbe;
};

export const MAX_VIDEO_SECONDS = 15;
export const MAX_VIDEO_BYTES = 50 * MB;
/** A clip stopped at "0:15" often measures 15.0x s; don't reject it for container rounding. */
export const DURATION_TOLERANCE_SEC = 0.25;
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Duration from `<video preload="metadata">`. Some webm files (MediaRecorder
 * output) report `Infinity` until the engine scans to the end, so seek far
 * past the end once and wait for the real duration.
 */
export const defaultProbeDuration: DurationProbe = (file) =>
  new Promise<VideoMetadata>((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    let settled = false;
    let seeking = false;

    const cleanup = () => {
      window.clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onerror = null;
      video.ondurationchange = null;
      video.ontimeupdate = null;
      video.onseeked = null;
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    };
    const finish = (result: VideoMetadata | Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const tryResolve = () => {
      const d = video.duration;
      if (Number.isFinite(d) && d > 0) {
        finish({ durationSec: d, width: video.videoWidth || undefined, height: video.videoHeight || undefined });
        return true;
      }
      return false;
    };

    const timer = window.setTimeout(() => finish(new Error("Timed out reading video metadata")), PROBE_TIMEOUT_MS);
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.onerror = () => finish(new Error("Video failed to load"));
    video.onloadedmetadata = () => {
      if (tryResolve()) return;
      if (video.duration === Infinity && !seeking) {
        seeking = true;
        video.ondurationchange = tryResolve;
        video.ontimeupdate = tryResolve;
        video.onseeked = () => {
          if (!tryResolve()) finish(new Error("Video has no duration"));
        };
        video.currentTime = Number.MAX_SAFE_INTEGER;
        return;
      }
      finish(new Error("Video has no duration"));
    };
    video.src = url;
  });

export async function checkVideo(file: File, opts: CheckVideoOptions = {}): Promise<PreparedMedia> {
  const maxSeconds = opts.maxSeconds ?? MAX_VIDEO_SECONDS;
  const maxBytes = opts.maxBytes ?? MAX_VIDEO_BYTES;
  const probe = opts.probeDuration ?? defaultProbeDuration;

  const contentType = baseMime(file.type);
  const ext = VIDEO_TYPES[contentType];
  if (!ext) throw new MediaError("unsupported_type");
  if (file.size === 0) throw new MediaError("empty_file");
  if (file.size > maxBytes) throw new MediaError("video_too_big");

  let meta: VideoMetadata;
  try {
    const result = await probe(file);
    meta = typeof result === "number" ? { durationSec: result } : result;
  } catch (cause) {
    throw new MediaError("video_unreadable", undefined, cause);
  }
  if (!Number.isFinite(meta.durationSec) || meta.durationSec <= 0) throw new MediaError("video_unreadable");
  if (meta.durationSec > maxSeconds + DURATION_TOLERANCE_SEC) {
    throw new MediaError("video_too_long", `Videos need to be ${maxSeconds} seconds or shorter.`);
  }

  return {
    blob: file,
    contentType,
    ext,
    kind: "video",
    durationSec: meta.durationSec,
    width: meta.width,
    height: meta.height,
  };
}
