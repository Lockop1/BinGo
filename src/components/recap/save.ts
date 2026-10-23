import type { RecapItem } from "@/components/recap/recapItems";
import type { GetSignedUrls } from "@/lib/media/signedUrls";

/** Triggers a browser download of a blob under `name`. */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the download time to start before freeing the blob.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export type SaveOutcome = "shared" | "downloaded" | "dismissed";

/**
 * Per-item Save: the share sheet with the file where the phone supports it
 * (iOS "Save Image" / "Save Video"), otherwise a plain download.
 */
export async function saveFile(blob: Blob, name: string): Promise<SaveOutcome> {
  const file = new File([blob], name, { type: blob.type || undefined });
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  let canShareFiles = false;
  try {
    canShareFiles = typeof nav?.share === "function" && nav.canShare?.({ files: [file] }) === true;
  } catch {
    canShareFiles = false;
  }
  if (canShareFiles && nav) {
    try {
      await nav.share({ files: [file] });
      return "shared";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return "dismissed";
      // NotAllowedError (activation expired) etc.: fall back to a download.
    }
  }
  downloadBlob(blob, name);
  return "downloaded";
}

export async function fetchBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.blob();
}

export type ZipProgress = { done: number; total: number };

/**
 * "Download all": fetch every item through its signed URL, zip them (stored,
 * not deflated; photos/videos are already compressed) and download the zip.
 * Returns how many items could not be fetched.
 */
export async function downloadAllZip(args: {
  items: readonly RecapItem[];
  names: readonly string[];
  zipName: string;
  getSignedUrls: GetSignedUrls;
  onProgress?: (progress: ZipProgress) => void;
}): Promise<{ added: number; failed: number }> {
  const { items, names, zipName, getSignedUrls, onProgress } = args;
  const [urls, { default: JSZip }] = await Promise.all([
    getSignedUrls(items.map((i) => i.media.storage_path)),
    import("jszip"),
  ]);
  const zip = new JSZip();
  let added = 0;
  let failed = 0;
  for (let i = 0; i < items.length; i += 1) {
    const url = urls[items[i].media.storage_path];
    try {
      if (!url) throw new Error("No signed URL");
      zip.file(names[i], await fetchBlob(url), { binary: true });
      added += 1;
    } catch {
      failed += 1;
    }
    onProgress?.({ done: i + 1, total: items.length });
  }
  if (added === 0) throw new Error("Nothing could be downloaded");
  const blob = await zip.generateAsync({ type: "blob", compression: "STORE", mimeType: "application/zip" });
  downloadBlob(blob, zipName);
  return { added, failed };
}
