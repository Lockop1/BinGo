import { createChunks, stringToBase64URL } from "@supabase/ssr";
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError, type Session } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  authStorageKey,
  classifyRefreshError,
  createSessionKeeper,
  isSessionReconnectError,
  readStoredSession,
  retryDelayMs,
  type AuthLike,
  type StoredSession,
} from "@/lib/supabase/auth";

function session(userId: string, refreshToken = `rt-${userId}`): Session {
  return {
    access_token: `at-${userId}`,
    refresh_token: refreshToken,
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
    user: { id: userId } as Session["user"],
  };
}

type Result = { data: { session: Session | null }; error: unknown };
const ok = (s: Session): Result => ({ data: { session: s }, error: null });
const none: Result = { data: { session: null }, error: null };
const fail = (error: unknown): Result => ({ data: { session: null }, error });

const offline = () => new AuthRetryableFetchError("Failed to fetch", 0);
const serverDown = () => new AuthRetryableFetchError("Service Unavailable", 503);
const deadToken = () => new AuthApiError("Invalid Refresh Token: Refresh Token Not Found", 400, "refresh_token_not_found");

/** A fake `supabase.auth`: each method's behaviour is a swappable function; calls are counted. */
function fakeAuth() {
  let listener: ((event: string, s: Session | null) => void) | null = null;
  const fake = {
    getSession: vi.fn<() => Promise<Result>>(async () => none),
    refreshSession: vi.fn<(current: { refresh_token: string }) => Promise<Result>>(async () => fail(deadToken())),
    signInAnonymously: vi.fn<() => Promise<Result>>(async () => ok(session("fresh"))),
    onAuthStateChange: vi.fn((cb: (event: string, s: Session | null) => void) => {
      listener = cb;
      return { data: { subscription: { unsubscribe() {} } } };
    }),
    emit: (event: string, s: Session | null) => listener?.(event, s),
  };
  return fake;
}

function keeper(fake: ReturnType<typeof fakeAuth>, stored: () => StoredSession | null = () => null) {
  const onReplace = vi.fn();
  const k = createSessionKeeper({ auth: () => fake as unknown as AuthLike, readStored: stored, onReplace });
  return { ensureSession: () => k.ensureSession(), onReplace };
}

const STORED: StoredSession = { refreshToken: "rt-old", userId: "old" };

describe("ensureSession", () => {
  it("returns the current session without signing in", async () => {
    const fake = fakeAuth();
    fake.getSession.mockResolvedValue(ok(session("old")));
    const { ensureSession } = keeper(fake, () => STORED);

    await expect(ensureSession()).resolves.toMatchObject({ user: { id: "old" } });
    expect(fake.signInAnonymously).not.toHaveBeenCalled();
    expect(fake.refreshSession).not.toHaveBeenCalled();
  });

  it("(a) no stored session: signs in anonymously once, even with concurrent callers", async () => {
    const fake = fakeAuth();
    let finish!: (r: Result) => void;
    fake.signInAnonymously.mockImplementation(() => new Promise<Result>((resolve) => (finish = resolve)));
    const { ensureSession, onReplace } = keeper(fake);

    const calls = [ensureSession(), ensureSession(), ensureSession()];
    await vi.waitFor(() => expect(fake.signInAnonymously).toHaveBeenCalled());
    finish(ok(session("fresh")));
    const sessions = await Promise.all(calls);

    expect(fake.signInAnonymously).toHaveBeenCalledTimes(1);
    expect(fake.getSession).toHaveBeenCalledTimes(1);
    expect(new Set(sessions.map((s) => s.user.id))).toEqual(new Set(["fresh"]));
    expect(onReplace).not.toHaveBeenCalled();
  });

  it("(a) a failed fresh sign-in (offline) throws the sign-in error, not a reconnect error", async () => {
    const fake = fakeAuth();
    fake.signInAnonymously.mockResolvedValue(fail(offline()));
    const { ensureSession } = keeper(fake);

    const error = await ensureSession().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthRetryableFetchError);
    expect(isSessionReconnectError(error)).toBe(false);
  });

  it.each([
    ["offline / fetch failure", offline()],
    ["5xx", serverDown()],
    ["rate limit (429)", new AuthApiError("Request rate limit reached", 429, "over_request_rate_limit")],
    ["unrecognised error", new Error("Lock acquire timed out")],
  ])("(b) stored session + transient refresh failure (%s): keeps the identity, retryable error", async (_label, error) => {
    const fake = fakeAuth();
    fake.getSession.mockResolvedValue(fail(error));
    const { ensureSession, onReplace } = keeper(fake, () => STORED);

    const thrown = await ensureSession().catch((e: unknown) => e);
    expect(isSessionReconnectError(thrown)).toBe(true);
    expect((thrown as { cause: unknown }).cause).toBe(error);
    expect(fake.signInAnonymously).not.toHaveBeenCalled();
    expect(onReplace).not.toHaveBeenCalled();
  });

  it("(b) getSession throwing outright with a stored session is retryable too", async () => {
    const fake = fakeAuth();
    fake.getSession.mockRejectedValue(new TypeError("Failed to fetch"));
    const { ensureSession } = keeper(fake, () => STORED);

    await expect(ensureSession()).rejects.toSatisfy(isSessionReconnectError);
    expect(fake.signInAnonymously).not.toHaveBeenCalled();
  });

  it("(b) storage wiped by a non-final failure: retries bring the same identity back, never a new one", async () => {
    const fake = fakeAuth();
    let stored: StoredSession | null = STORED;
    // auth-js deletes the stored session after a 429 once the access token has expired.
    fake.getSession.mockImplementationOnce(async () => {
      stored = null;
      return fail(new AuthApiError("Request rate limit reached", 429, "over_request_rate_limit"));
    });
    fake.refreshSession.mockResolvedValue(fail(offline()));
    const { ensureSession } = keeper(fake, () => stored);

    await expect(ensureSession()).rejects.toSatisfy(isSessionReconnectError);
    // Next attempts: storage is empty, so the keeper refreshes with the token it remembered.
    await expect(ensureSession()).rejects.toSatisfy(isSessionReconnectError);
    expect(fake.refreshSession).toHaveBeenLastCalledWith({ refresh_token: "rt-old" });

    fake.refreshSession.mockResolvedValue(ok(session("old", "rt-rotated")));
    await expect(ensureSession()).resolves.toMatchObject({ user: { id: "old" } });
    expect(fake.signInAnonymously).not.toHaveBeenCalled();
  });

  it("(b) after SIGNED_OUT the identity from the last auth event is asked back first", async () => {
    const fake = fakeAuth();
    fake.getSession.mockResolvedValueOnce(ok(session("old", "rt-1")));
    const { ensureSession } = keeper(fake);
    await ensureSession();
    // A rotation broadcast, then auth-js wipes storage (SIGNED_OUT) after a non-final failure.
    fake.emit("TOKEN_REFRESHED", session("old", "rt-2"));
    fake.emit("SIGNED_OUT", null);
    fake.refreshSession.mockResolvedValue(fail(serverDown()));

    await expect(ensureSession()).rejects.toSatisfy(isSessionReconnectError);
    expect(fake.refreshSession).toHaveBeenCalledWith({ refresh_token: "rt-2" });
    expect(fake.signInAnonymously).not.toHaveBeenCalled();
  });

  it.each([
    ["refresh_token_not_found", deadToken()],
    ["legacy invalid_grant shape", new AuthApiError("Invalid Refresh Token: Already Used", 400, undefined)],
    ["refresh_token_already_used", new AuthApiError("Invalid Refresh Token: Already Used", 400, "refresh_token_already_used")],
    ["session_not_found", new AuthSessionMissingError()],
  ])("(c) stored session + definitive refresh failure (%s): signs in anew, logged once", async (_label, error) => {
    const fake = fakeAuth();
    fake.getSession.mockResolvedValue(fail(error));
    const { ensureSession, onReplace } = keeper(fake, () => STORED);

    await expect(ensureSession()).resolves.toMatchObject({ user: { id: "fresh" } });
    expect(fake.signInAnonymously).toHaveBeenCalledTimes(1);
    expect(onReplace).toHaveBeenCalledTimes(1);
    expect(onReplace).toHaveBeenCalledWith(error);
  });

  it("(c) storage already wiped and the remembered token is dead: signs in anew once", async () => {
    const fake = fakeAuth();
    let stored: StoredSession | null = STORED;
    fake.getSession.mockImplementation(async () => {
      stored = null;
      return none;
    });
    fake.refreshSession.mockResolvedValue(fail(deadToken()));
    const { ensureSession, onReplace } = keeper(fake, () => stored);

    await expect(ensureSession()).resolves.toMatchObject({ user: { id: "fresh" } });
    expect(fake.refreshSession).toHaveBeenCalledWith({ refresh_token: "rt-old" });
    expect(fake.signInAnonymously).toHaveBeenCalledTimes(1);
    expect(onReplace).toHaveBeenCalledTimes(1);
  });
});

describe("classifyRefreshError", () => {
  it("only a dead refresh token is definitive", () => {
    expect(classifyRefreshError(offline())).toBe("transient");
    expect(classifyRefreshError(serverDown())).toBe("transient");
    expect(classifyRefreshError(new AuthApiError("Request rate limit reached", 429, "over_request_rate_limit"))).toBe("transient");
    expect(classifyRefreshError(new AuthApiError("Request timeout", 408, "request_timeout"))).toBe("transient");
    expect(classifyRefreshError(new TypeError("Failed to fetch"))).toBe("transient");
    expect(classifyRefreshError(undefined)).toBe("transient");

    expect(classifyRefreshError(deadToken())).toBe("definitive");
    expect(classifyRefreshError(new AuthApiError("Invalid Refresh Token: Refresh Token Not Found", 400, undefined))).toBe("definitive");
    expect(classifyRefreshError(new AuthApiError("invalid_grant", 400, undefined))).toBe("definitive");
    expect(classifyRefreshError(new AuthApiError("Refresh token is not valid", 400, "validation_failed"))).toBe("definitive");
    expect(classifyRefreshError(new AuthApiError("Unable to validate email address", 400, "validation_failed"))).toBe("transient");
    expect(classifyRefreshError(new AuthApiError("User not found", 404, "user_not_found"))).toBe("definitive");
    expect(classifyRefreshError(new AuthSessionMissingError())).toBe("definitive");
  });
});

describe("stored session cookies", () => {
  const key = authStorageKey("http://127.0.0.1:54321");
  const value = JSON.stringify({ access_token: "at", refresh_token: "rt-1", expires_at: 1, user: { id: "u-1" } });

  it("derives supabase-js's default storage key", () => {
    expect(key).toBe("sb-127-auth-token");
    expect(authStorageKey("https://abcdefgh.supabase.co")).toBe("sb-abcdefgh-auth-token");
  });

  it("reads a single base64 cookie, chunked cookies and plain JSON", () => {
    const encoded = `base64-${stringToBase64URL(value)}`;
    expect(readStoredSession(`other=1; ${key}=${encoded}`, key)).toEqual({ refreshToken: "rt-1", userId: "u-1" });

    const padded = JSON.stringify({ ...JSON.parse(value), pad: "x".repeat(5000) });
    const chunks = createChunks(key, `base64-${stringToBase64URL(padded)}`);
    expect(chunks.length).toBeGreaterThan(1);
    const header = chunks.map((c) => `${c.name}=${c.value}`).join("; ");
    expect(readStoredSession(header, key)).toEqual({ refreshToken: "rt-1", userId: "u-1" });

    expect(readStoredSession(`${key}=${encodeURIComponent(value)}`, key)).toEqual({ refreshToken: "rt-1", userId: "u-1" });
  });

  it("treats a missing, partial or malformed cookie as nothing stored", () => {
    expect(readStoredSession("", key)).toBeNull();
    expect(readStoredSession(`${key}-code-verifier=abc`, key)).toBeNull();
    expect(readStoredSession(`${key}=base64-!!!`, key)).toBeNull();
    expect(readStoredSession(`${key}=${encodeURIComponent(JSON.stringify({ refresh_token: "rt" }))}`, key)).toBeNull();
  });
});

describe("retryDelayMs", () => {
  it("backs off 1, 2, 4, 8 s, then every 15 s", () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(retryDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
  });
});
