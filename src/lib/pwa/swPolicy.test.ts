import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Runs the exact file the worker imports (public/sw-policy.js) in a sandbox
 * whose only globals are `self` and `URL`, then tests its pure routing policy.
 */

type Strategy = "navigation" | "cache-first" | "network-first" | "stale-while-revalidate";
type Config = { origin: string; supabaseOrigin: string | null; dev: boolean };
type RequestLike = {
  url: string;
  method?: string;
  mode?: string;
  destination?: string;
  headers?: { get(name: string): string | null };
};
type ResponseLike = {
  ok: boolean;
  status: number;
  type: string;
  redirected?: boolean;
  headers: { get(name: string): string | null };
};
type Policy = {
  CACHE_VERSION: string;
  CACHE_NAMES: { pages: string; static: string; assets: string };
  NAVIGATION_TIMEOUT_MS: number;
  readConfig(scriptUrl: string): Config;
  selectStrategy(request: RequestLike, config: Config): Strategy | null;
  shouldCache(request: RequestLike, config: Config): boolean;
  cacheNameFor(strategy: Strategy | null): string | null;
  cacheLimitFor(cacheName: string): number;
  isCacheableResponse(response: ResponseLike, strategy: Strategy): boolean;
  pageCacheKey(url: string): string;
  staleCacheNames(names: string[]): string[];
  extractShellAssetUrls(html: string, origin: string): string[];
  offlineHtml(): string;
};

const APP = "http://127.0.0.1:3000";
const SUPABASE = "http://127.0.0.1:54321";
const PROD: Config = { origin: APP, supabaseOrigin: SUPABASE, dev: false };
const DEV: Config = { ...PROD, dev: true };

let policy: Policy;
let sandboxKeys: string[];

beforeAll(() => {
  const file = path.resolve(__dirname, "../../../public/sw-policy.js");
  const self: Record<string, unknown> = {};
  vm.runInNewContext(readFileSync(file, "utf8"), { self, URL }, { filename: file });
  sandboxKeys = Object.keys(self);
  policy = self.BingoSWPolicy as Policy;
});

function get(url: string, headers: Record<string, string> = {}, extra: Partial<RequestLike> = {}): RequestLike {
  return { url, method: "GET", mode: "cors", destination: "", headers: new Headers(headers), ...extra };
}
function nav(url: string, extra: Partial<RequestLike> = {}): RequestLike {
  return get(url, { accept: "text/html" }, { mode: "navigate", destination: "document", ...extra });
}
function response(init: Omit<Partial<ResponseLike>, "headers"> & { headers?: Record<string, string> } = {}): ResponseLike {
  const { headers, ...rest } = init;
  return { ok: true, status: 200, type: "basic", redirected: false, ...rest, headers: new Headers(headers ?? {}) };
}

describe("sw-policy.js", () => {
  it("only defines BingoSWPolicy (no listeners, no side effects)", () => {
    expect(sandboxKeys).toEqual(["BingoSWPolicy"]);
    expect(policy.CACHE_NAMES).toEqual({
      pages: `bingo-pages-${policy.CACHE_VERSION}`,
      static: `bingo-static-${policy.CACHE_VERSION}`,
      assets: `bingo-assets-${policy.CACHE_VERSION}`,
    });
    expect(policy.NAVIGATION_TIMEOUT_MS).toBe(3000);
  });

  it("reads its config from the script URL", () => {
    expect(policy.readConfig(`${APP}/sw.js?supabase=${encodeURIComponent(`${SUPABASE}/`)}&dev=1`)).toEqual({
      origin: APP,
      supabaseOrigin: SUPABASE,
      dev: true,
    });
    expect(policy.readConfig(`${APP}/sw.js`)).toEqual({ origin: APP, supabaseOrigin: null, dev: false });
    expect(policy.readConfig(`${APP}/sw.js?supabase=not%20a%20url`).supabaseOrigin).toBeNull();
  });

  describe("navigations", () => {
    it.each(["/", "/new", "/g/ABCD2345", "/game/0f0e4c1a-2b3c-4d5e-8f90-123456789abc", "/?from=home"])(
      "%s is network-first with a cache fallback",
      (pathname) => {
        expect(policy.selectStrategy(nav(`${APP}${pathname}`), PROD)).toBe("navigation");
        expect(policy.cacheNameFor("navigation")).toBe(policy.CACHE_NAMES.pages);
      },
    );

    it("recognises document requests from engines without mode=navigate", () => {
      expect(policy.selectStrategy(get(`${APP}/`, { accept: "text/html" }, { destination: "document" }), PROD)).toBe(
        "navigation",
      );
    });

    it("never handles /api navigations or tokenised page URLs", () => {
      expect(policy.selectStrategy(nav(`${APP}/api/cron/cleanup`), PROD)).toBeNull();
      expect(policy.selectStrategy(nav(`${APP}/api`), PROD)).toBeNull();
      expect(policy.selectStrategy(nav(`${APP}/game/x?token=abc`), PROD)).toBeNull();
    });
  });

  describe("never cached: game data, auth and writes", () => {
    const supabaseUrls = [
      `${SUPABASE}/rest/v1/games?select=*&id=eq.1`,
      `${SUPABASE}/rest/v1/rpc/complete_square`,
      `${SUPABASE}/auth/v1/token?grant_type=refresh_token`,
      `${SUPABASE}/auth/v1/user`,
      `${SUPABASE}/realtime/v1/websocket?apikey=anon&vsn=1.0.0`,
      `${SUPABASE}/storage/v1/object/sign/game-media/g/1/a.jpg?token=eyJhbGciOi`,
      "https://abcd.supabase.co/rest/v1/squares?game_id=eq.1",
      "https://abcd.supabase.co/storage/v1/object/sign/game-media/x.mp4?token=t",
    ];

    it.each(supabaseUrls)("%s (Supabase / other origin)", (url) => {
      expect(policy.selectStrategy(get(url, { apikey: "anon", authorization: "Bearer t" }), PROD)).toBeNull();
      expect(policy.selectStrategy(get(url), PROD)).toBeNull();
      // Even without the configured Supabase origin, the same-origin rule keeps them out.
      expect(policy.selectStrategy(get(url), { ...PROD, supabaseOrigin: null })).toBeNull();
      expect(policy.shouldCache(get(url), PROD)).toBe(false);
    });

    it("Supabase stays network-only even when served from the app origin", () => {
      expect(policy.selectStrategy(get(`${APP}/x.png`), { ...PROD, supabaseOrigin: APP })).toBeNull();
    });

    it.each([
      "/api/cron/cleanup",
      "/api/anything?x=1",
      "/rest/v1/games",
      "/auth/v1/user",
      "/realtime/v1/websocket",
      "/storage/v1/object/public/x.png",
      "/functions/v1/hello",
      "/_next/image?url=%2Ficons%2Ficon-512.png&w=64&q=75",
      "/_next/webpack-hmr",
      "/_next/hmr?id=abc",
      "/__nextjs_original-stack-frames",
      "/sw.js",
      "/sw-policy.js",
      "/favicon.ico",
      "/robots.txt",
    ])("same-origin %s", (pathname) => {
      expect(policy.selectStrategy(get(`${APP}${pathname}`), PROD)).toBeNull();
      expect(policy.selectStrategy(get(`${APP}${pathname}`), DEV)).toBeNull();
    });

    it.each(["POST", "PUT", "PATCH", "DELETE", "post"])("%s requests", (method) => {
      expect(policy.selectStrategy({ ...nav(`${APP}/game/1`), method }, PROD)).toBeNull();
      expect(policy.selectStrategy({ ...get(`${APP}/_next/static/chunks/a.js`), method }, PROD)).toBeNull();
    });

    it("RSC / router data requests and server actions", () => {
      expect(policy.selectStrategy(get(`${APP}/game/1?_rsc=1x2y`), PROD)).toBeNull();
      expect(policy.selectStrategy(get(`${APP}/game/1`, { rsc: "1" }), PROD)).toBeNull();
      expect(policy.selectStrategy(get(`${APP}/new`, { "next-router-prefetch": "1" }), PROD)).toBeNull();
      expect(policy.selectStrategy(get(`${APP}/new`, { "next-router-state-tree": "%5B%5D" }), PROD)).toBeNull();
      expect(policy.selectStrategy(get(`${APP}/new`, { "next-action": "abc" }), PROD)).toBeNull();
    });

    it("authenticated, ranged or signed same-origin requests", () => {
      const asset = `${APP}/icons/icon-192.png`;
      expect(policy.selectStrategy(get(asset, { authorization: "Bearer t" }), PROD)).toBeNull();
      expect(policy.selectStrategy(get(asset, { apikey: "anon" }), PROD)).toBeNull();
      expect(policy.selectStrategy(get(asset, { range: "bytes=0-" }), PROD)).toBeNull();
      for (const param of ["token", "signature", "X-Amz-Signature", "sig", "access_token"]) {
        expect(policy.selectStrategy(get(`${asset}?${param}=abc`), PROD)).toBeNull();
      }
    });

    it("non-http(s) and malformed URLs", () => {
      expect(policy.selectStrategy(get("chrome-extension://abc/x.js"), PROD)).toBeNull();
      expect(policy.selectStrategy(get("data:text/plain,hi"), PROD)).toBeNull();
      expect(policy.selectStrategy(get("not a url"), PROD)).toBeNull();
    });
  });

  describe("app shell assets", () => {
    it("hashed /_next/static output is cache-first in production, network-first in dev", () => {
      for (const pathname of [
        "/_next/static/chunks/0a1b2c3d4e5f.js",
        "/_next/static/chunks/9f8e7d.css",
        "/_next/static/media/patrick_hand-latin.0e1a2b3c.woff2",
      ]) {
        expect(policy.selectStrategy(get(`${APP}${pathname}`), PROD)).toBe("cache-first");
        expect(policy.selectStrategy(get(`${APP}${pathname}`), DEV)).toBe("network-first");
      }
      expect(policy.cacheNameFor("cache-first")).toBe(policy.CACHE_NAMES.static);
      expect(policy.cacheNameFor("network-first")).toBe(policy.CACHE_NAMES.static);
    });

    it("icons, fonts and the manifest are stale-while-revalidate", () => {
      for (const pathname of ["/icons/icon-192.png", "/icons/apple-touch-icon.png", "/manifest.webmanifest", "/fonts/x.woff2"]) {
        expect(policy.selectStrategy(get(`${APP}${pathname}`), PROD)).toBe("stale-while-revalidate");
      }
      expect(policy.cacheNameFor("stale-while-revalidate")).toBe(policy.CACHE_NAMES.assets);
      expect(policy.cacheNameFor(null)).toBeNull();
    });

    it("every cache has a size limit", () => {
      for (const name of Object.values(policy.CACHE_NAMES)) expect(policy.cacheLimitFor(name)).toBeGreaterThan(0);
      expect(policy.cacheLimitFor("someone-else")).toBe(0);
    });
  });

  describe("responses", () => {
    it("stores only complete same-origin 200s", () => {
      expect(policy.isCacheableResponse(response({ headers: { "content-type": "text/javascript" } }), "cache-first")).toBe(
        true,
      );
      expect(policy.isCacheableResponse(response({ type: "default" }), "stale-while-revalidate")).toBe(true);
      expect(policy.isCacheableResponse(response({ type: "opaque", ok: false, status: 0 }), "cache-first")).toBe(false);
      expect(policy.isCacheableResponse(response({ type: "cors" }), "cache-first")).toBe(false);
      expect(policy.isCacheableResponse(response({ status: 206 }), "cache-first")).toBe(false);
      expect(policy.isCacheableResponse(response({ ok: false, status: 404 }), "cache-first")).toBe(false);
      expect(policy.isCacheableResponse(response({ ok: false, status: 500 }), "navigation")).toBe(false);
      expect(policy.isCacheableResponse(response({ headers: { vary: "*" } }), "cache-first")).toBe(false);
    });

    it("stores pages only as non-redirected HTML", () => {
      const html = { "content-type": "text/html; charset=utf-8", vary: "rsc, next-router-state-tree, Accept-Encoding" };
      expect(policy.isCacheableResponse(response({ headers: html }), "navigation")).toBe(true);
      expect(policy.isCacheableResponse(response({ headers: html, redirected: true }), "navigation")).toBe(false);
      expect(
        policy.isCacheableResponse(response({ headers: { "content-type": "application/json" } }), "navigation"),
      ).toBe(false);
    });
  });

  it("keys pages by URL without the fragment", () => {
    expect(policy.pageCacheKey(`${APP}/game/1?x=1#board`)).toBe(`${APP}/game/1?x=1`);
  });

  it("deletes only its own outdated caches", () => {
    const current = Object.values(policy.CACHE_NAMES);
    expect(policy.staleCacheNames([...current, "bingo-pages-v0", "bingo-static-v0", "other-app-cache"])).toEqual([
      "bingo-pages-v0",
      "bingo-static-v0",
    ]);
  });

  it("finds the build assets a page references", () => {
    const html = `<!DOCTYPE html><html><head>
      <link rel="stylesheet" href="/_next/static/chunks/a1.css" data-precedence="next">
      <link rel="preload" href="/_next/static/media/font.0e1a.woff2" as="font" crossorigin="">
      <script src="/_next/static/chunks/b2.js?dpl=abc&amp;v=1" async=""></script>
      <script src="${APP}/_next/static/chunks/b2.js?dpl=abc&amp;v=1" async=""></script>
      <script src="https://cdn.example.com/_next/static/chunks/c3.js"></script>
      </head><body><script>self.__next_f.push([1,"0:{\\"P\\":null,\\"c\\":[\\"/_next/static/chunks/d4.js\\"]}"])</script></body></html>`;
    expect(policy.extractShellAssetUrls(html, APP).sort()).toEqual(
      [
        `${APP}/_next/static/chunks/a1.css`,
        `${APP}/_next/static/chunks/b2.js?dpl=abc&v=1`,
        `${APP}/_next/static/chunks/d4.js`,
        `${APP}/_next/static/media/font.0e1a.woff2`,
      ].sort(),
    );
  });

  it("has a tiny offline page with the promised copy", () => {
    const html = policy.offlineHtml();
    expect(html).toContain("You’re offline — the board will load as soon as you have signal.");
    expect(html).toContain('addEventListener("online"');
    expect(html.length).toBeLessThan(3000);
  });
});
