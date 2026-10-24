import { AuthApiError, AuthRetryableFetchError, AuthUnknownError } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CookieWrite } from "@/lib/supabase/proxy";

// A fake server client: `getUser()` replays whatever `scenario` says, calling the
// captured `cookies.setAll` the way @supabase/ssr does (from inside getUser).
type Scenario = { writes: CookieWrite[][]; error: unknown };
const fake = vi.hoisted(() => ({
  scenario: { writes: [], error: null } as { writes: unknown[][]; error: unknown },
  getAllSeen: [] as { name: string; value: string }[],
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    options: {
      cookies: {
        getAll: () => { name: string; value: string }[];
        setAll: (cookies: unknown[], headers: Record<string, string>) => void;
      };
    },
  ) => ({
    auth: {
      getUser: async () => {
        fake.getAllSeen = options.cookies.getAll();
        for (const batch of fake.scenario.writes) {
          options.cookies.setAll(batch, {
            "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
            Expires: "0",
            Pragma: "no-cache",
          });
        }
        return { data: { user: null }, error: fake.scenario.error };
      },
    },
  }),
}));

const { updateSession, cookieWritesToApply } = await import("@/lib/supabase/proxy");

const KEY = "sb-127-auth-token";
const BASE = { path: "/", sameSite: "lax" as const, httpOnly: false };
const remove = (name: string): CookieWrite => ({ name, value: "", options: { ...BASE, maxAge: 0 } });
const set = (name: string, value: string): CookieWrite => ({ name, value, options: { ...BASE, maxAge: 400 * 86400 } });

function request(cookies: Record<string, string>) {
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return new NextRequest("http://127.0.0.1:3000/game/abc", { headers: { cookie } });
}

async function run(scenario: Scenario, cookies: Record<string, string> = { [`${KEY}.0`]: "base64-old0", [`${KEY}.1`]: "base64-old1" }) {
  fake.scenario = scenario;
  const response = await updateSession(request(cookies));
  const setCookies = response.headers.getSetCookie();
  return { response, setCookies, names: setCookies.map((c) => c.split("=")[0]) };
}

// Deletions emitted when auth-js removes the stored (chunked) session.
const wipe = [remove(`${KEY}.0`), remove(`${KEY}.1`)];

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("updateSession", () => {
  it.each([
    ["network failure", new AuthRetryableFetchError("fetch failed", 0)],
    ["5xx", new AuthRetryableFetchError("Bad Gateway", 502)],
    ["429", new AuthApiError("Request rate limit reached", 429, "over_request_rate_limit")],
    ["unparsable error page", new AuthUnknownError("Unexpected token <", new SyntaxError("Unexpected token <"))],
  ])("transient failure (%s): the session cookies are not deleted", async (_label, error) => {
    const { response, setCookies } = await run({ writes: [wipe], error });
    expect(setCookies).toEqual([]);
    expect(response.cookies.get(`${KEY}.0`)).toBeUndefined();
    // The no-cache headers still go out.
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("transient failure: other cookies are still written; only session deletions are held back", async () => {
    const { names } = await run({ writes: [[...wipe, remove(`${KEY}-code-verifier`)]], error: new AuthRetryableFetchError("fetch failed", 0) });
    expect(names).toEqual([`${KEY}-code-verifier`]);
  });

  it.each([
    ["refresh_token_not_found", new AuthApiError("Invalid Refresh Token: Refresh Token Not Found", 400, "refresh_token_not_found")],
    ["refresh_token_already_used", new AuthApiError("Invalid Refresh Token: Already Used", 400, "refresh_token_already_used")],
  ])("definitive failure (%s): the deletions are applied", async (_label, error) => {
    const { setCookies, response } = await run({ writes: [wipe], error });
    expect(setCookies).toHaveLength(2);
    expect(setCookies.every((c) => /Max-Age=0/i.test(c))).toBe(true);
    expect(response.cookies.get(`${KEY}.0`)?.value).toBe("");
  });

  it("successful refresh with a rotated token: the new values (and stale-chunk removals) are applied", async () => {
    const { response, names } = await run({ writes: [[remove(`${KEY}.1`), set(`${KEY}.0`, "base64-new")]], error: null });
    expect(names.sort()).toEqual([`${KEY}.0`, `${KEY}.1`]);
    expect(response.cookies.get(`${KEY}.0`)?.value).toBe("base64-new");
    expect(response.cookies.get(`${KEY}.1`)?.value).toBe("");
  });

  it("a rotation followed by a transient /user failure keeps the rotated token", async () => {
    const { response } = await run({
      writes: [[remove(`${KEY}.1`), set(`${KEY}.0`, "base64-new")]],
      error: new AuthRetryableFetchError("fetch failed", 0),
    });
    expect(response.cookies.get(`${KEY}.0`)?.value).toBe("base64-new");
    expect(response.cookies.get(`${KEY}.1`)?.value).toBe("");
  });

  it("no writes: plain pass-through", async () => {
    const { setCookies, response } = await run({ writes: [], error: null });
    expect(setCookies).toEqual([]);
    expect(response.headers.get("Cache-Control")).toBeNull();
    expect(fake.getAllSeen.map((c) => c.name).sort()).toEqual([`${KEY}.0`, `${KEY}.1`]);
  });
});

describe("cookieWritesToApply", () => {
  const transient = new AuthRetryableFetchError("fetch failed", 0);

  it("treats an expired Expires as a deletion too", () => {
    const expired: CookieWrite = { name: KEY, value: "x", options: { ...BASE, expires: new Date(0) } };
    expect(cookieWritesToApply([expired], transient, Date.now())).toEqual([]);
    expect(cookieWritesToApply([expired], null)).toEqual([expired]);
  });

  it("passes everything through without an error", () => {
    expect(cookieWritesToApply(wipe, null)).toEqual(wipe);
  });
});
