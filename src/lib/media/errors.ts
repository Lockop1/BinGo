/**
 * Friendly, stable errors for picking / preparing media on the phone (before
 * anything is uploaded). Upload and `register_media` failures are reported by
 * the upload queue instead (see uploadQueue.ts).
 *
 * Named `MediaError` per the media pipeline spec; it shadows the DOM's
 * `MediaError` global only inside modules that import it.
 */
export const MEDIA_ERROR_CODES = [
  "unsupported_type",
  "image_unreadable",
  "image_too_big",
  "video_too_long",
  "video_too_big",
  "video_unreadable",
  "empty_file",
] as const;

export type MediaErrorCode = (typeof MEDIA_ERROR_CODES)[number];

export const MEDIA_ERROR_COPY: Record<MediaErrorCode, string> = {
  unsupported_type: "That file type isn't supported. Try a photo or a video.",
  image_unreadable: "We couldn't read that photo. Try taking it again.",
  image_too_big: "That photo is too big to upload (10 MB max).",
  video_too_long: "Videos need to be 15 seconds or shorter.",
  video_too_big: "That video is too big to upload (50 MB max).",
  video_unreadable: "We couldn't read that video. Try recording it again.",
  empty_file: "That file is empty. Try again.",
};

export class MediaError extends Error {
  readonly code: MediaErrorCode;
  override readonly cause: unknown;

  constructor(code: MediaErrorCode, message: string = MEDIA_ERROR_COPY[code], cause?: unknown) {
    super(message);
    this.name = "MediaError";
    this.code = code;
    this.cause = cause;
  }
}

export function isMediaError(error: unknown): error is MediaError {
  return error instanceof MediaError;
}

/** Copy for anything thrown while preparing a file. */
export function mediaErrorCopy(error: unknown): string {
  return isMediaError(error) ? error.message : MEDIA_ERROR_COPY.image_unreadable;
}
