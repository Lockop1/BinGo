import { checkVideo, type CheckVideoOptions } from "@/lib/media/checkVideo";
import { compressImage, type CompressOptions } from "@/lib/media/compressImage";
import { MediaError } from "@/lib/media/errors";
import { baseMime, mimeFromName, type PreparedMedia } from "@/lib/media/types";

export type PrepareOptions = {
  image?: CompressOptions;
  video?: CheckVideoOptions;
  /** Injectable for tests. */
  compress?: typeof compressImage;
  check?: typeof checkVideo;
};

/** Some pickers hand over files with an empty `type`; trust a known extension then. */
function withType(file: File): File {
  if (file.type) return file;
  const inferred = mimeFromName(file.name);
  return inferred ? new File([file], file.name, { type: inferred, lastModified: file.lastModified }) : file;
}

/**
 * Turns a picked file into something the upload queue can send: photos are
 * compressed to JPEG, videos are checked for length/size. Throws `MediaError`
 * with friendly copy for anything we won't upload.
 */
export async function prepareMedia(input: File, opts: PrepareOptions = {}): Promise<PreparedMedia> {
  const file = withType(input);
  if (file.size === 0) throw new MediaError("empty_file");
  const type = baseMime(file.type);
  if (type.startsWith("image/")) return (opts.compress ?? compressImage)(file, opts.image);
  if (type.startsWith("video/")) return (opts.check ?? checkVideo)(file, opts.video);
  throw new MediaError("unsupported_type");
}
