import { isAuthApiError, isAuthRetryableFetchError, isAuthSessionMissingError } from "@supabase/supabase-js";

/**
 * Which auth refresh failures mean the anonymous identity is really gone.
 * Pure (no browser or server APIs): used by the browser session keeper
 * (lib/supabase/auth.ts) and by the server proxy (lib/supabase/proxy.ts),
 * which must never clear a phone's auth cookies for a passing failure.
 */

const DEAD_TOKEN_CODES = new Set([
  "refresh_token_not_found",
  "refresh_token_already_used",
  "session_not_found",
  "session_expired",
  "user_not_found",
  "invalid_grant",
]);
// Legacy `{ error: "invalid_grant", error_description: "Invalid Refresh Token: …" }` bodies carry no
// code; a malformed token gets `validation_failed` "Refresh token is not valid". Both are 400s.
const DEAD_TOKEN_MESSAGE = /invalid refresh token|refresh token not found|refresh token is not valid|invalid_grant|already used/i;

/**
 * `definitive` only when the server has said the refresh token can never work
 * again. Everything else, including errors we do not recognise, is
 * `transient`: keeping a dead identity a little longer costs a retry, while
 * dropping a live one loses the phone's games.
 */
export function classifyRefreshError(error: unknown): "transient" | "definitive" {
  if (isAuthRetryableFetchError(error)) return "transient";
  // auth-js maps a server `session_not_found` to this class.
  if (isAuthSessionMissingError(error)) return "definitive";
  if (isAuthApiError(error)) {
    if (error.code && DEAD_TOKEN_CODES.has(error.code)) return "definitive";
    const clientError = error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
    if (clientError && DEAD_TOKEN_MESSAGE.test(error.message)) return "definitive";
  }
  return "transient";
}
