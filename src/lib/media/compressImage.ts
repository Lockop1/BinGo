import { MediaError } from "@/lib/media/errors";
import { IMAGE_TYPES, MB, baseMime, type PreparedMedia } from "@/lib/media/types";

/**
 * Client-side photo compression (CLAUDE.md > Media rules): every photo becomes
 * a JPEG with its long edge ≤ 1600 px, upright per its EXIF orientation.
 * Small photos are re-encoded too, so uploads are (almost) always JPEG.
 *
 * If the browser cannot decode the file (e.g. HEIC on Chrome), the original is
 * passed through when it is small enough and the bucket accepts its type;
 * otherwise a friendly `MediaError` is thrown.
 */

export type DecodedImage = {
  source: CanvasImageSource;
  width: number;
  height: number;
  /** Frees the bitmap / object URL once drawn. */
  close?: () => void;
};

export type ImageDecoder = (file: Blob) => Promise<DecodedImage>;
export type ImageEncoder = (image: DecodedImage, width: number, height: number, quality: number) => Promise<Blob>;

export type CompressOptions = {
  maxEdge?: number;
  quality?: number;
  /** Injectable for tests; defaults to createImageBitmap with an <img> fallback. */
  decode?: ImageDecoder;
  /** Injectable for tests; defaults to OffscreenCanvas with a <canvas> fallback. */
  encode?: ImageEncoder;
};

export const DEFAULT_MAX_EDGE = 1600;
export const DEFAULT_QUALITY = 0.82;
/** Largest original we upload untouched when it cannot be decoded here. */
export const PASSTHROUGH_MAX_BYTES = 10 * MB;

/** Output size that fits `maxEdge` on the long edge, keeping the aspect ratio. Never upscales. */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= maxEdge) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  const scale = maxEdge / long;
  return {
    width: Math.max(1, Math.min(maxEdge, Math.round(width * scale))),
    height: Math.max(1, Math.min(maxEdge, Math.round(height * scale))),
  };
}

async function decodeWithImg(file: Blob): Promise<DecodedImage> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    // Browsers apply EXIF orientation to <img> by default (image-orientation: from-image).
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Image failed to load"));
      img.src = url;
    });
    if (!img.naturalWidth || !img.naturalHeight) throw new Error("Image has no size");
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/** createImageBitmap honouring EXIF orientation; older engines reject the option, so fall back to <img>. */
export const defaultDecode: ImageDecoder = async (file) => {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Unsupported option or format: try the <img> path.
    }
  }
  return decodeWithImg(file);
};

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function paint(ctx: Ctx2D, image: DecodedImage, width: number, height: number) {
  // JPEG has no alpha: flatten transparent PNGs onto white rather than black.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image.source, 0, 0, width, height);
}

export const defaultEncode: ImageEncoder = async (image, width, height, quality) => {
  if (typeof OffscreenCanvas !== "undefined") {
    try {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        paint(ctx, image, width, height);
        return await canvas.convertToBlob({ type: "image/jpeg", quality });
      }
    } catch {
      // Some engines expose OffscreenCanvas without a usable 2D context: use a DOM canvas.
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D canvas context");
  paint(ctx, image, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new Error("Canvas produced no blob");
  return blob;
};

/** The original file, if the bucket can take it as-is. */
function passThrough(file: File, cause: unknown): PreparedMedia {
  const type = baseMime(file.type);
  const ext = IMAGE_TYPES[type];
  if (!ext) throw new MediaError("unsupported_type", undefined, cause);
  if (file.size > PASSTHROUGH_MAX_BYTES) throw new MediaError("image_too_big", undefined, cause);
  return { blob: file, contentType: type, ext, kind: "photo" };
}

export async function compressImage(file: File, opts: CompressOptions = {}): Promise<PreparedMedia> {
  const maxEdge = opts.maxEdge ?? DEFAULT_MAX_EDGE;
  const quality = opts.quality ?? DEFAULT_QUALITY;
  const decode = opts.decode ?? defaultDecode;
  const encode = opts.encode ?? defaultEncode;

  let image: DecodedImage;
  try {
    image = await decode(file);
  } catch (cause) {
    return passThrough(file, cause);
  }
  try {
    const size = fitWithin(image.width, image.height, maxEdge);
    const blob = await encode(image, size.width, size.height, quality);
    if (baseMime(blob.type) !== "image/jpeg" || blob.size === 0) throw new Error(`Encoder produced ${blob.type}`);
    return { blob, contentType: "image/jpeg", ext: "jpg", kind: "photo", width: size.width, height: size.height };
  } catch (cause) {
    return passThrough(file, cause);
  } finally {
    image.close?.();
  }
}
