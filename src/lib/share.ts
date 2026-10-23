/**
 * Sharing helpers (browser only). The Web Share API opens the phone's share
 * sheet (group chats); where it is missing or fails, the link is copied.
 */

export type ShareData = { title: string; text: string; url: string };

/** `shared`: share sheet completed. `copied`: link on the clipboard. `dismissed`: user closed the sheet. */
export type ShareOutcome = "shared" | "copied" | "dismissed" | "failed";

function canUseWebShare(data: ShareData): boolean {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function") return false;
  try {
    return typeof navigator.canShare === "function" ? navigator.canShare(data) : true;
  } catch {
    return false;
  }
}

/** Copies text, falling back to a hidden textarea where the async Clipboard API is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or insecure context: try the legacy path.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.left = "0";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Share sheet when available, otherwise (or if it errors) copy the URL. */
export async function shareOrCopy(data: ShareData): Promise<ShareOutcome> {
  if (canUseWebShare(data)) {
    try {
      await navigator.share(data);
      return "shared";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return "dismissed";
      // NotAllowedError / DataError etc.: fall through to copying.
    }
  }
  return (await copyText(data.url)) ? "copied" : "failed";
}
