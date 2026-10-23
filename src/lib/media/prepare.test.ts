import { describe, expect, it, vi } from "vitest";
import { checkVideo } from "@/lib/media/checkVideo";
import { compressImage, fitWithin, type DecodedImage } from "@/lib/media/compressImage";
import { MEDIA_ERROR_COPY, MediaError } from "@/lib/media/errors";
import { prepareMedia } from "@/lib/media/prepare";
import { MB, type PreparedMedia } from "@/lib/media/types";

const file = (bytes: number, name: string, type: string) => new File([new Uint8Array(bytes)], name, { type });
const prepared = (kind: "photo" | "video"): PreparedMedia => ({
  blob: new Blob(["x"]),
  contentType: kind === "photo" ? "image/jpeg" : "video/mp4",
  ext: kind === "photo" ? "jpg" : "mp4",
  kind,
});

async function rejection(promise: Promise<unknown>): Promise<MediaError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MediaError);
    return error as MediaError;
  }
  throw new Error("expected a rejection");
}

describe("prepareMedia dispatch", () => {
  it("sends images to compressImage and videos to checkVideo", async () => {
    const compress = vi.fn(async () => prepared("photo"));
    const check = vi.fn(async () => prepared("video"));
    await expect(prepareMedia(file(10, "a.png", "image/png"), { compress, check })).resolves.toMatchObject({ kind: "photo" });
    await expect(prepareMedia(file(10, "b.mov", "video/quicktime"), { compress, check })).resolves.toMatchObject({ kind: "video" });
    expect(compress).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("rejects anything else as unsupported_type", async () => {
    const compress = vi.fn();
    const check = vi.fn();
    const error = await rejection(prepareMedia(file(10, "notes.txt", "text/plain"), { compress, check }));
    expect(error.code).toBe("unsupported_type");
    expect(error.message).toBe(MEDIA_ERROR_COPY.unsupported_type);
    expect(compress).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it("infers the type from the extension when the picker gives none", async () => {
    const compress = vi.fn(async (f: File) => ({ ...prepared("photo"), contentType: f.type }));
    const result = await prepareMedia(file(10, "IMG_0001.JPG", ""), { compress });
    expect(result.contentType).toBe("image/jpeg");
    expect((await rejection(prepareMedia(file(10, "mystery", "")))).code).toBe("unsupported_type");
  });

  it("rejects empty files", async () => {
    expect((await rejection(prepareMedia(file(0, "a.jpg", "image/jpeg")))).code).toBe("empty_file");
  });
});

describe("checkVideo", () => {
  const probe = (seconds: number) => async () => seconds;

  it("rejects videos over 15 s with friendly copy", async () => {
    const error = await rejection(checkVideo(file(100, "long.mp4", "video/mp4"), { probeDuration: probe(20) }));
    expect(error.code).toBe("video_too_long");
    expect(error.message).toBe("Videos need to be 15 seconds or shorter.");
  });

  it("accepts ≤ 15 s and maps MIME → ext", async () => {
    const cases: [string, string][] = [
      ["video/mp4", "mp4"],
      ["video/quicktime", "mov"],
      ["video/webm;codecs=vp9", "webm"],
    ];
    for (const [type, ext] of cases) {
      const result = await checkVideo(file(100, "clip", type), { probeDuration: probe(15) });
      expect(result).toMatchObject({ kind: "video", ext, contentType: type.split(";")[0], durationSec: 15 });
    }
  });

  it("rejects too-big, unsupported and unreadable videos", async () => {
    expect((await rejection(checkVideo(file(51 * MB, "big.mp4", "video/mp4"), { probeDuration: probe(3) }))).code).toBe(
      "video_too_big",
    );
    expect((await rejection(checkVideo(file(10, "a.mkv", "video/x-matroska"), { probeDuration: probe(3) }))).code).toBe(
      "unsupported_type",
    );
    const broken = async () => {
      throw new Error("decode");
    };
    expect((await rejection(checkVideo(file(10, "a.webm", "video/webm"), { probeDuration: broken }))).code).toBe(
      "video_unreadable",
    );
    expect((await rejection(checkVideo(file(10, "a.webm", "video/webm"), { probeDuration: probe(Infinity) }))).code).toBe(
      "video_unreadable",
    );
  });
});

describe("compressImage (injected decode/encode)", () => {
  const decoded = (width: number, height: number): DecodedImage => ({ source: {} as CanvasImageSource, width, height, close: vi.fn() });

  it("fits the long edge to 1600 and never upscales", () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(10000, 10, 1600)).toEqual({ width: 1600, height: 2 });
  });

  it("re-encodes to JPEG at the fitted size and frees the decoded image", async () => {
    const image = decoded(4000, 3000);
    const encode = vi.fn(async () => new Blob(["jpeg"], { type: "image/jpeg" }));
    const result = await compressImage(file(10, "big.png", "image/png"), { decode: async () => image, encode });
    expect(encode).toHaveBeenCalledWith(image, 1600, 1200, 0.82);
    expect(result).toMatchObject({ contentType: "image/jpeg", ext: "jpg", kind: "photo", width: 1600, height: 1200 });
    expect(image.close).toHaveBeenCalled();
  });

  it("passes an undecodable but allowed original through (≤ 10 MB)", async () => {
    const heic = file(2 * MB, "IMG.HEIC", "image/heic");
    const result = await compressImage(heic, { decode: () => Promise.reject(new Error("no heic")) });
    expect(result).toMatchObject({ blob: heic, contentType: "image/heic", ext: "heic", kind: "photo" });
  });

  it("throws friendly errors when the original cannot be passed through", async () => {
    const fail = () => Promise.reject(new Error("nope"));
    expect((await rejection(compressImage(file(11 * MB, "a.heic", "image/heic"), { decode: fail }))).code).toBe("image_too_big");
    expect((await rejection(compressImage(file(10, "a.heif", "image/heif"), { decode: fail }))).code).toBe("unsupported_type");
  });

  it("falls back to pass-through when the encoder does not produce JPEG", async () => {
    const png = file(10, "a.png", "image/png");
    const result = await compressImage(png, {
      decode: async () => decoded(100, 100),
      encode: async () => new Blob(["png"], { type: "image/png" }),
    });
    expect(result).toMatchObject({ blob: png, ext: "png" });
  });
});
