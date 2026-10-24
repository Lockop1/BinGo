import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Invite-link previews: /g/[code] carries Open Graph / Twitter tags with the game name and a
 * 1200x630 card image, fetched the way a link unfurler does (no cookies, no session); bogus
 * codes get the generic card, never an error. Also the icon set and favicon.ico.
 */

const BOT_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";

function decode(value: string): string {
  return value
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Content of `<meta property|name="key" content="…">` in the HTML (first match), decoded. */
function meta(html: string, key: string): string | null {
  const tag = new RegExp(`<meta (?:property|name)="${key.replace(/[:.]/g, "\\$&")}" content="([^"]*)"`).exec(html);
  return tag ? decode(tag[1]) : null;
}

/** GETs a page as a crawler: a fresh request context has no cookies. */
async function crawl(request: APIRequestContext, path: string, userAgent?: string): Promise<string> {
  const response = await request.get(path, userAgent ? { headers: { "user-agent": userAgent } } : undefined);
  expect(response.status(), path).toBe(200);
  return response.text();
}

/** og:image as a same-origin path (dev resolves social images against localhost:<port>). */
function imagePath(html: string, code: string): string {
  const image = meta(html, "og:image");
  expect(image, "og:image").not.toBeNull();
  const url = new URL(image!);
  expect(url.pathname).toBe(`/g/${code}/opengraph-image`);
  expect(meta(html, "twitter:image")).toBe(image);
  return `${url.pathname}${url.search}`;
}

async function expectCardPng(request: APIRequestContext, path: string): Promise<void> {
  const response = await request.get(path);
  expect(response.status(), path).toBe(200);
  expect(response.headers()["content-type"], path).toBe("image/png");
  expect(response.headers()["cache-control"], path).toMatch(/max-age=\d+/);
  const body = await response.body();
  // PNG signature, then IHDR: width and height are big-endian uint32 at bytes 16 and 20.
  expect(body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), path).toBe(true);
  expect(body.subarray(12, 16).toString("ascii")).toBe("IHDR");
  expect({ width: body.readUInt32BE(16), height: body.readUInt32BE(20) }).toEqual({ width: 1200, height: 630 });
}

test("invite links unfurl into a card with the game name and a board image", async ({ browser, request }) => {
  const gameName = `E2E OG ${Date.now().toString(36)}`;
  const context = await browser.newContext();
  const host = await context.newPage();
  try {
    await host.goto("/new");
    await host.waitForLoadState("networkidle");
    const create = host.getByTestId("create-game");
    await expect(async () => {
      await host.getByTestId("game-name").fill(gameName);
      await host.getByTestId("host-name").fill("Hosty");
      await expect(create).toBeEnabled({ timeout: 1_000 });
    }).toPass();
    await host.getByTestId("pack-night-out").click();
    await create.click();
    await expect(host).toHaveURL(/\/game\/[0-9a-f-]{36}$/);
    const code = (await host.getByTestId("invite-code").getAttribute("data-code"))!;
    expect(code).toMatch(/^[A-Z0-9]{8}$/);

    // As a crawler that does not run JavaScript (metadata is in <head>) …
    const html = await crawl(request, `/g/${code}`, BOT_UA);
    const title = `Join ${gameName} · Bingo Night`;
    const description = "1 player in. Tap to join the board — no signup.";
    expect(html).toContain(`<title>${title}</title>`);
    expect(meta(html, "og:title")).toBe(title);
    expect(meta(html, "og:description")).toBe(description);
    expect(meta(html, "og:type")).toBe("website");
    expect(meta(html, "og:site_name")).toBe("Bingo Night");
    expect(new URL(meta(html, "og:url")!).pathname).toBe(`/g/${code}`);
    expect(meta(html, "og:image:width")).toBe("1200");
    expect(meta(html, "og:image:height")).toBe("630");
    expect(meta(html, "twitter:card")).toBe("summary_large_image");
    expect(meta(html, "twitter:title")).toBe(title);
    expect(meta(html, "twitter:description")).toBe(description);
    await expectCardPng(request, imagePath(html, code));

    // … and as an ordinary client (streamed metadata still carries the tags).
    const plain = await crawl(request, `/g/${code}`);
    expect(meta(plain, "og:title")).toBe(title);

    // A lower-case, dashed link resolves to the same game.
    const dashed = await crawl(request, `/g/${code.slice(0, 4).toLowerCase()}-${code.slice(4).toLowerCase()}`, BOT_UA);
    expect(meta(dashed, "og:title")).toBe(title);
  } finally {
    await context.close();
  }
});

test("unknown codes get the generic card, never an error", async ({ request }) => {
  const html = await crawl(request, "/g/ZZZZZZZ9", BOT_UA);
  expect(meta(html, "og:title")).toBe("Join the game · Bingo Night");
  expect(meta(html, "og:description")).toBe("Tap to join the board — no signup.");
  expect(meta(html, "twitter:card")).toBe("summary_large_image");
  await expectCardPng(request, imagePath(html, "ZZZZZZZ9"));

  // Not even code-shaped: no lookup at all, still a card.
  await expectCardPng(request, "/g/not-a-code/opengraph-image");
});

test("favicon.ico and the icon set are served", async ({ request }) => {
  const ico = await request.get("/favicon.ico");
  expect(ico.status()).toBe(200);
  const icoBody = await ico.body();
  expect([...icoBody.subarray(0, 4)]).toEqual([0x00, 0x00, 0x01, 0x00]);
  expect(icoBody.readUInt16LE(4)).toBe(2); // 16 and 32
  expect([icoBody[6], icoBody[22]].sort((a, b) => a - b)).toEqual([16, 32]);

  for (const [path, size] of [
    ["/icons/favicon-32.png", 32],
    ["/icons/favicon-16.png", 16],
  ] as const) {
    const png = await request.get(path);
    expect(png.status(), path).toBe(200);
    expect(png.headers()["content-type"], path).toContain("image/png");
    const body = await png.body();
    expect(body.subarray(1, 4).toString("ascii"), path).toBe("PNG");
    expect(body.readUInt32BE(16), path).toBe(size);
  }

  const svg = await request.get("/icons/logo.svg");
  expect(svg.status()).toBe(200);
  expect(svg.headers()["content-type"]).toContain("image/svg+xml");
  expect(await svg.text()).toContain("<svg");
});
