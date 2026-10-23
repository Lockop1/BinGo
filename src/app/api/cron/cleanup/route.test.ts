import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// connection() needs a Next request context; outside Next it only has to resolve.
vi.mock("next/server", () => ({ connection: vi.fn(async () => undefined) }));

const createAdminClient = vi.fn(() => ({ fake: "admin-client" }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));

const report = {
  endedGames: 1,
  expiredGames: 1,
  deletedGames: 0,
  deletedObjects: 0,
  errors: [{ gameId: "g1", step: "list_storage", message: "storage not available" }],
  durationMs: 5,
};
const runCleanup = vi.fn(async () => report);
vi.mock("@/lib/cleanup/runCleanup", () => ({ runCleanup }));

const { GET } = await import("./route");

const URL = "http://localhost/api/cron/cleanup";
const SECRET = "test-cron-secret-0123456789";

function call(headers: Record<string, string> = {}) {
  return GET(new Request(URL, { headers }));
}

describe("GET /api/cron/cleanup", () => {
  const original = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    createAdminClient.mockClear();
    runCleanup.mockClear();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
    vi.restoreAllMocks();
  });

  it("returns 401 without an Authorization header", async () => {
    const res = await call();
    expect(res.status).toBe(401);
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(runCleanup).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong secret", `Bearer wrong-secret`],
    ["same length, different", `Bearer ${SECRET.slice(0, -1)}X`],
    ["missing Bearer prefix", SECRET],
    ["prefix of the secret", `Bearer ${SECRET.slice(0, 5)}`],
  ])("returns 401 with a bad bearer (%s)", async (_label, value) => {
    const res = await call({ authorization: value });
    expect(res.status).toBe(401);
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(runCleanup).not.toHaveBeenCalled();
  });

  it("returns 500 with a clear message when CRON_SECRET is unset, even with a bearer", async () => {
    delete process.env.CRON_SECRET;
    const res = await call({ authorization: "Bearer " });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/CRON_SECRET/);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("runs cleanup with the admin client and returns the report as 200, even with errors", async () => {
    const res = await call({ authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(report);
    expect(createAdminClient).toHaveBeenCalledTimes(1);
    expect(runCleanup).toHaveBeenCalledWith({ fake: "admin-client" });
  });

  it("returns 500 when the run itself throws", async () => {
    runCleanup.mockRejectedValueOnce(new Error("boom"));
    const res = await call({ authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "Cleanup run failed", message: "boom" });
  });
});
