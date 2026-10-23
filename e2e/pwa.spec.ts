import { expect, test, type APIResponse, type Page } from "@playwright/test";

/**
 * App shell PWA: manifest + icons, and the service worker (public/sw.js) that
 * serves a cached shell offline while never caching Supabase or /api calls.
 * Needs the dev server started with NEXT_PUBLIC_ENABLE_SW=1 (playwright.config.ts does).
 */

async function pngSize(response: APIResponse): Promise<{ width: number; height: number }> {
  const body = await response.body();
  // PNG signature, then the IHDR chunk: width and height are big-endian uint32 at bytes 16 and 20.
  expect(body.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: body.readUInt32BE(16), height: body.readUInt32BE(20) };
}

async function cacheInventory(page: Page): Promise<{ names: string[]; urls: string[] }> {
  return page.evaluate(async () => {
    const names = await caches.keys();
    const urls: string[] = [];
    for (const name of names) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) urls.push(request.url);
    }
    return { names, urls };
  });
}

/** Resolves to "ok:<status>" or "failed" (network error) for a fetch made by the page. */
async function pageFetch(page: Page, url: string, init?: RequestInit): Promise<string> {
  return page.evaluate(
    async ([target, options]) => {
      try {
        const res = await fetch(target, options);
        return `ok:${res.status}`;
      } catch {
        return "failed";
      }
    },
    [url, init ?? {}] as const,
  );
}

test("installable app shell that loads offline without caching game data", async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL!).origin;

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Bingo Night" })).toBeVisible();

  // Manifest + icon links are in the page head.
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", /\/manifest\.webmanifest/);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/icons/apple-touch-icon.png");

  // The worker registers after load and takes control of this page (clients.claim).
  const scriptURL = await page.evaluate(
    () =>
      Promise.race([
        navigator.serviceWorker.ready.then((registration) => registration.active?.scriptURL ?? ""),
        new Promise<string>((resolve) => setTimeout(() => resolve("not registered"), 30_000)),
      ]),
  );
  expect(scriptURL, "start the dev server with NEXT_PUBLIC_ENABLE_SW=1").toContain("/sw.js");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const supabaseOrigin = new URL(scriptURL).searchParams.get("supabase") ?? "http://127.0.0.1:54321";
  expect(new URL(supabaseOrigin).origin).not.toBe(origin);

  // Manifest content.
  const manifestResponse = await page.request.get("/manifest.webmanifest");
  expect(manifestResponse.status()).toBe(200);
  const manifest = await manifestResponse.json();
  expect(manifest).toMatchObject({
    id: "/",
    name: "Bingo Night",
    short_name: "Bingo Night",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#fbf8ef",
    theme_color: "#fbf8ef",
  });
  const icons = manifest.icons as { src: string; sizes: string; type: string; purpose: string }[];
  expect(icons.map((icon) => `${icon.sizes} ${icon.purpose}`).sort()).toEqual([
    "192x192 any",
    "512x512 any",
    "512x512 maskable",
  ]);

  // Every icon is a real PNG of the declared size.
  for (const { src, sizes } of [...icons, { src: "/icons/apple-touch-icon.png", sizes: "180x180" }]) {
    const response = await page.request.get(src);
    expect(response.status(), src).toBe(200);
    expect(response.headers()["content-type"], src).toContain("image/png");
    const { width, height } = await pngSize(response);
    expect(`${width}x${height}`, src).toBe(sizes);
  }
  expect((await page.request.get("/icons/icon.svg")).status()).toBe(200);

  // Touch Supabase and /api while online, so a caching bug would have something to cache.
  const supabaseRest = `${supabaseOrigin}/rest/v1/`;
  expect(await pageFetch(page, supabaseRest)).toMatch(/^ok:/);
  await pageFetch(page, "/api/pwa-e2e-probe");

  // The shell ("/" HTML + its build assets) is cached; Supabase and /api never are.
  await expect
    .poll(async () => (await cacheInventory(page)).urls.includes(`${origin}/`), { timeout: 30_000 })
    .toBe(true);
  await expect
    .poll(async () => (await cacheInventory(page)).urls.some((url) => url.includes("/_next/static/")))
    .toBe(true);
  const inventory = await cacheInventory(page);
  expect(inventory.names.every((name) => name.startsWith("bingo-"))).toBe(true);
  for (const url of inventory.urls) {
    expect(new URL(url).origin, url).toBe(origin);
    expect(new URL(url).pathname, url).not.toMatch(/^\/(api|rest|auth|realtime|storage)\//);
    expect(url, url).not.toContain("_rsc=");
  }

  // Offline: reloading "/" renders the cached home shell, not a browser error.
  await context.setOffline(true);
  try {
    const offlineReload = await page.reload();
    expect(offlineReload?.fromServiceWorker()).toBe(true);
    await expect(page.getByRole("heading", { name: "Bingo Night" })).toBeVisible();
    await expect(page.getByTestId("new-game")).toBeVisible();

    // Game data and auth are never answered from a cache: they fail honestly.
    expect(await pageFetch(page, supabaseRest)).toBe("failed");
    expect(await pageFetch(page, `${supabaseOrigin}/auth/v1/user`)).toBe("failed");
    expect(await pageFetch(page, "/api/pwa-e2e-probe")).toBe("failed");

    // A page that was never cached gets the inline offline page.
    await page.goto("/g/NEVERSEEN");
    await expect(page.getByText("the board will load as soon as you have signal")).toBeVisible();
  } finally {
    await context.setOffline(false);
  }

  // Back online: fresh network wins again.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Bingo Night" })).toBeVisible();
  expect(await pageFetch(page, supabaseRest)).toMatch(/^ok:/);
});
