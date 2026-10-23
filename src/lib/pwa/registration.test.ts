import { describe, expect, it } from "vitest";
import { isServiceWorkerEnabled, sameOriginUrls, serviceWorkerUrl } from "./registration";

describe("isServiceWorkerEnabled", () => {
  it("is on in production and opt-in in dev", () => {
    expect(isServiceWorkerEnabled("production", undefined)).toBe(true);
    expect(isServiceWorkerEnabled("development", undefined)).toBe(false);
    expect(isServiceWorkerEnabled("development", "0")).toBe(false);
    expect(isServiceWorkerEnabled("development", "1")).toBe(true);
    expect(isServiceWorkerEnabled("test", "1")).toBe(true);
  });
});

describe("serviceWorkerUrl", () => {
  it("passes the Supabase origin (never the path or key) and the dev flag", () => {
    expect(serviceWorkerUrl({ supabaseUrl: "https://abcd.supabase.co/", dev: false })).toBe(
      "/sw.js?supabase=https%3A%2F%2Fabcd.supabase.co",
    );
    expect(serviceWorkerUrl({ supabaseUrl: "http://127.0.0.1:54321", dev: true })).toBe(
      "/sw.js?supabase=http%3A%2F%2F127.0.0.1%3A54321&dev=1",
    );
  });

  it("falls back to the bare script without a usable Supabase URL", () => {
    expect(serviceWorkerUrl({ supabaseUrl: undefined, dev: false })).toBe("/sw.js");
    expect(serviceWorkerUrl({ supabaseUrl: "not a url", dev: false })).toBe("/sw.js");
    expect(serviceWorkerUrl({ supabaseUrl: null, dev: true })).toBe("/sw.js?dev=1");
  });
});

describe("sameOriginUrls", () => {
  it("keeps unique same-origin URLs without fragments", () => {
    expect(
      sameOriginUrls(
        [
          "http://127.0.0.1:3000/_next/static/chunks/a.js",
          "/_next/static/chunks/a.js#x",
          "http://127.0.0.1:54321/rest/v1/games",
          "https://fonts.example.com/f.woff2",
          "/icons/icon-192.png",
          "http://[bad",
        ],
        "http://127.0.0.1:3000",
      ),
    ).toEqual(["http://127.0.0.1:3000/_next/static/chunks/a.js", "http://127.0.0.1:3000/icons/icon-192.png"]);
  });
});
