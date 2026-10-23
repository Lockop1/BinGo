/** Normalizes a join code the same way the DB does: upper-case, alphanumerics only. */
export function normalizeJoinCode(raw: string): string {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Malformed escape sequence: fall back to the raw string.
  }
  return decoded.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function baseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured) return configured.replace(/\/+$/, "");
  if (typeof window !== "undefined") return window.location.origin;
  return "";
}

/** Absolute invite link for a join code, e.g. https://bingo.example/g/ABCD2345. */
export function inviteUrl(code: string): string {
  return `${baseUrl()}/g/${encodeURIComponent(code)}`;
}

/** "ABCD2345" → "ABCD-2345" for reading aloud; the join route accepts either. */
export function formatJoinCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}
