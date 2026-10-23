import { describe, expect, it, vi } from "vitest";
import { SignedUrlError, createSignedUrlCache, type SignedUrlStorageLike } from "@/lib/media/signedUrls";

function fakeStorage(opts: { fail?: (paths: string[]) => boolean; refuse?: Set<string> } = {}) {
  const calls: { bucket: string; paths: string[]; expiresIn: number }[] = [];
  let version = 0;
  const storage: SignedUrlStorageLike = {
    from(bucket) {
      return {
        async createSignedUrls(paths, expiresIn) {
          calls.push({ bucket, paths, expiresIn });
          version += 1;
          if (opts.fail?.(paths)) return { data: null, error: { message: "boom", status: 500 } };
          return {
            data: paths.map((path) =>
              opts.refuse?.has(path)
                ? { path, signedUrl: null, error: "Either the object does not exist or you do not have access to it" }
                : { path, signedUrl: `https://sb.test/sign/${path}?v=${version}`, error: null },
            ),
            error: null,
          };
        },
      };
    },
  };
  return { storage, calls };
}

const paths = (n: number) => Array.from({ length: n }, (_, i) => `g/${i % 25}/${i}.jpg`);

describe("signed URL cache", () => {
  it("signs in batches of at most 50 from game-media", async () => {
    const { storage, calls } = fakeStorage();
    const cache = createSignedUrlCache({ storage });
    const list = paths(120);
    const urls = await cache.getSignedUrls(list);
    expect(calls.map((c) => c.paths.length)).toEqual([50, 50, 20]);
    expect(calls.every((c) => c.bucket === "game-media" && c.expiresIn === 3600)).toBe(true);
    expect(Object.keys(urls)).toHaveLength(120);
    expect(urls[list[7]]).toMatch(/^https:\/\/sb\.test\/sign\/g\/7\/7\.jpg/);
  });

  it("serves cached URLs and only signs what is missing", async () => {
    const { storage, calls } = fakeStorage();
    const cache = createSignedUrlCache({ storage });
    const first = await cache.getSignedUrls(["a/1/x.jpg", "a/1/x.jpg", "a/2/y.jpg"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].paths).toEqual(["a/1/x.jpg", "a/2/y.jpg"]);
    const second = await cache.getSignedUrls(["a/2/y.jpg", "a/3/z.jpg"]);
    expect(calls).toHaveLength(2);
    expect(calls[1].paths).toEqual(["a/3/z.jpg"]);
    expect(second["a/2/y.jpg"]).toBe(first["a/2/y.jpg"]);
  });

  it("re-signs once less than 5 minutes of validity remain", async () => {
    let now = 1_000_000;
    const { storage, calls } = fakeStorage();
    const cache = createSignedUrlCache({ storage, now: () => now });
    const a = await cache.getSignedUrls(["p/1/a.jpg"]);
    now += 54 * 60_000; // 6 minutes left: still fresh
    expect(await cache.getSignedUrls(["p/1/a.jpg"])).toEqual(a);
    expect(calls).toHaveLength(1);
    now += 2 * 60_000; // 4 minutes left: refresh
    const b = await cache.getSignedUrls(["p/1/a.jpg"]);
    expect(calls).toHaveLength(2);
    expect(b["p/1/a.jpg"]).not.toBe(a["p/1/a.jpg"]);
  });

  it("leaves out paths Storage refused and caches nothing for them", async () => {
    const { storage, calls } = fakeStorage({ refuse: new Set(["g/1/gone.jpg"]) });
    const cache = createSignedUrlCache({ storage });
    const urls = await cache.getSignedUrls(["g/1/gone.jpg", "g/1/ok.jpg"]);
    expect(Object.keys(urls)).toEqual(["g/1/ok.jpg"]);
    await cache.getSignedUrls(["g/1/gone.jpg"]);
    expect(calls).toHaveLength(2);
  });

  it("throws a SignedUrlError on a failed batch; good batches stay cached", async () => {
    const { storage, calls } = fakeStorage({ fail: (p) => p.includes("g/0/50.jpg") });
    const cache = createSignedUrlCache({ storage });
    await expect(cache.getSignedUrls(paths(60))).rejects.toBeInstanceOf(SignedUrlError);
    const getter = vi.fn(async () => storage);
    const again = createSignedUrlCache({ storage: getter });
    expect(await again.getSignedUrls([])).toEqual({});
    expect(getter).not.toHaveBeenCalled();
    calls.length = 0;
    await expect(cache.getSignedUrls(paths(50))).resolves.toHaveProperty(["g/3/3.jpg"]);
    expect(calls).toHaveLength(0);
  });
});
