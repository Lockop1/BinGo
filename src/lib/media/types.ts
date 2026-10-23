import type { MediaKind } from "@/lib/game/types";

/** File extensions the `game-media` bucket accepts (its MIME allow-list). */
export type MediaExt = "jpg" | "png" | "webp" | "heic" | "mp4" | "mov" | "webm";

/** A file that passed the client-side checks and is ready for the upload queue. */
export type PreparedMedia = {
  blob: Blob;
  contentType: string;
  ext: MediaExt;
  kind: MediaKind;
  width?: number;
  height?: number;
  durationSec?: number;
};

export const MB = 1024 * 1024;

/** Image MIME types the bucket accepts, with the extension used in the object name. */
export const IMAGE_TYPES: Readonly<Record<string, MediaExt>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};

/** Video MIME types the bucket accepts (`video/quicktime` = iPhone .mov). */
export const VIDEO_TYPES: Readonly<Record<string, MediaExt>> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

/** MIME base type without parameters, lower-cased: "video/webm;codecs=vp8" → "video/webm". */
export function baseMime(type: string): string {
  return type.split(";")[0].trim().toLowerCase();
}

const EXT_TO_MIME: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

/** MIME type from a file name, for pickers that hand over files with an empty `type`. */
export function mimeFromName(name: string): string | null {
  const ext = name.split(".").pop()?.toLowerCase();
  return ext ? (EXT_TO_MIME[ext] ?? null) : null;
}
