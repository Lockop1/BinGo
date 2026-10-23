import { expect, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "@playwright/test";

/**
 * Shared two-phone setup for the live-board specs. The local backend never
 * delivers Realtime events, so everything that crosses phones travels over
 * the resync poll (NEXT_PUBLIC_SYNC_POLL_MS=1500 in playwright.config.ts).
 */

export const LIVE = { timeout: 3_000 };

export type Pack = "night-out" | "day-adventure" | "blank";

export type TwoPhones = {
  hostContext: BrowserContext;
  friendContext: BrowserContext;
  host: Page;
  friend: Page;
  gameName: string;
  gameId: string;
  code: string;
  close: () => Promise<void>;
};

export type TwoPhoneOptions = {
  /** Shown in the game name (`E2E <prefix> <random>`). */
  prefix?: string;
  pack?: Pack;
  host?: BrowserContextOptions;
  friend?: BrowserContextOptions;
  /** Runs on each context before its first page opens (e.g. addInitScript). */
  prepare?: (context: BrowserContext) => Promise<void>;
};

/** Host creates a game, a friend joins via the link, both tap Ready: Start is enabled on the host. */
export async function twoPhonesInLobby(browser: Browser, options: TwoPhoneOptions = {}): Promise<TwoPhones> {
  const gameName = `E2E ${options.prefix ?? "Board"} ${Date.now().toString(36)}`;
  const hostContext = await browser.newContext(options.host);
  const friendContext = await browser.newContext(options.friend);
  if (options.prepare) {
    await options.prepare(hostContext);
    await options.prepare(friendContext);
  }
  const host = await hostContext.newPage();
  const friend = await friendContext.newPage();

  await host.goto("/new");
  await host.waitForLoadState("networkidle");
  const create = host.getByTestId("create-game");
  await expect(async () => {
    await host.getByTestId("game-name").fill(gameName);
    await host.getByTestId("host-name").fill("Hosty");
    await expect(create).toBeEnabled({ timeout: 1_000 });
  }).toPass();
  await host.getByTestId(`pack-${options.pack ?? "night-out"}`).click();
  await create.click();
  await expect(host).toHaveURL(/\/game\/[0-9a-f-]{36}$/);
  const gameId = new URL(host.url()).pathname.split("/").pop()!;
  const code = (await host.getByTestId("invite-code").getAttribute("data-code"))!;

  await friend.goto(`/g/${code}`);
  await friend.getByTestId("join-name").fill("Friendo");
  await friend.getByTestId("join-game").click();
  await expect(friend.getByTestId("lobby")).toBeVisible();
  await expect(host.getByTestId("player")).toHaveCount(2, LIVE);

  await host.getByTestId("ready-toggle").click();
  await friend.getByTestId("ready-toggle").click();
  await expect(host.getByTestId("start-game")).toBeEnabled(LIVE);

  return {
    hostContext,
    friendContext,
    host,
    friend,
    gameName,
    gameId,
    code,
    close: async () => {
      await hostContext.close();
      await friendContext.close();
    },
  };
}

/** The host taps Start; resolves once both phones show the live board. */
export async function startGame(phones: Pick<TwoPhones, "host" | "friend">): Promise<void> {
  await phones.host.getByTestId("start-game").click();
  for (const page of [phones.host, phones.friend]) {
    await expect(page.getByTestId("game-screen")).toHaveAttribute("data-status", "active", { timeout: 5_000 });
    await expect(page.getByTestId("board-grid")).toBeVisible();
  }
}

/** Two phones that have reached an active game (Night Out pack unless told otherwise). */
export async function twoPhonesInActiveGame(browser: Browser, options: TwoPhoneOptions = {}): Promise<TwoPhones> {
  const phones = await twoPhonesInLobby(browser, options);
  await startGame(phones);
  return phones;
}

/** The page never scrolls sideways and the grid's right edge stays on screen. */
export async function expectFitsWidth(page: Page, label = "") {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, `scrollWidth ${label} on ${page.url()}`).toBeLessThanOrEqual(innerWidth);
  const grid = await page.getByTestId("board-grid").boundingBox();
  expect(grid, "board grid").not.toBeNull();
  expect(grid!.x, `grid left ${label}`).toBeGreaterThanOrEqual(0);
  expect(grid!.x + grid!.width, `grid right ${label}`).toBeLessThanOrEqual(innerWidth + 0.5);
}
