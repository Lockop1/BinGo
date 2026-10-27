import { expect, test, type Page } from "@playwright/test";

/**
 * Two phones build a Blank board together and start the game. The local
 * backend never delivers Realtime events, so everything here propagates via
 * the resync poll (NEXT_PUBLIC_SYNC_POLL_MS=1500 in playwright.config.ts).
 */

const LIVE = { timeout: 3_000 };

async function expectNoHorizontalScroll(page: Page) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, `scrollWidth on ${page.url()}`).toBeLessThanOrEqual(375);
}

test("host and friend edit the board live, ready up and start", async ({ browser }) => {
  const gameName = `E2E Lobby ${Date.now().toString(36)}`;

  const hostContext = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  // Force the copy fallback (desktop Chromium may or may not expose Web Share).
  await hostContext.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "share", { value: undefined, configurable: true });
  });
  const friendContext = await browser.newContext();
  const host = await hostContext.newPage();
  const friend = await friendContext.newPage();

  // Host creates a Blank game.
  await host.goto("/new");
  await host.waitForLoadState("networkidle");
  const create = host.getByTestId("create-game");
  await expect(async () => {
    await host.getByTestId("game-name").fill(gameName);
    await host.getByTestId("host-name").fill("Hosty");
    await expect(create).toBeEnabled({ timeout: 1_000 });
  }).toPass();
  await host.getByTestId("pack-blank").click();
  await create.click();
  await expect(host).toHaveURL(/\/game\/[0-9a-f-]{36}$/);
  await expect(host.getByTestId("lobby")).toBeVisible();
  await expect(host.getByTestId("lobby-title")).toHaveText(gameName);
  const code = (await host.getByTestId("invite-code").getAttribute("data-code"))!;
  expect(code).toMatch(/^[A-Z0-9]{8}$/);
  await expect(host.getByTestId("square-12")).toHaveAttribute("data-free", "true");
  await expectNoHorizontalScroll(host);

  // Invite: no share sheet here, so the link is copied.
  await host.getByTestId("invite-share").click();
  await expect(host.getByTestId("invite-feedback")).toHaveText("Copied");
  expect(await host.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`/g/${code}$`));

  // Friend joins.
  await friend.goto(`/g/${code}`);
  await friend.getByTestId("join-name").fill("Friendo");
  await friend.getByTestId("join-game").click();
  await expect(friend).toHaveURL(new RegExp(`${new URL(host.url()).pathname}$`));
  await expect(friend.getByTestId("lobby")).toBeVisible();

  // The host sees the friend arrive without reloading.
  await expect(host.getByTestId("player")).toHaveCount(2, LIVE);
  const friendRow = friend.getByTestId("player").filter({ hasText: "Friendo" });
  await expect(friendRow).toContainText("you");
  await expect(friend.getByTestId("player").filter({ hasText: "Hosty" })).toContainText("host");
  await expect(friend.getByTestId("start-game")).toHaveCount(0);
  await expect(friend.getByTestId("lobby-status")).toHaveText("Waiting for Hosty to start");

  // Friend writes square 0; the sheet fits the phone.
  await friend.getByTestId("square-0").click();
  const sheet = friend.getByTestId("square-sheet");
  await expect(sheet).toBeVisible();
  await expect(friend.getByTestId("square-label")).toBeFocused();
  await friend.getByTestId("square-label").fill("Skyline Chili");
  await expect(friend.getByTestId("label-remaining")).toHaveText("27 left");
  await friend.getByTestId("square-details").fill("A three-way with oyster crackers.");
  await friend.getByTestId("counter-toggle").click();
  await expect(friend.getByTestId("counter-target")).toBeVisible();
  await friend.getByTestId("counter-target").fill("3");
  await expectNoHorizontalScroll(friend);
  await friend.getByTestId("square-save").click();
  await expect(sheet).toBeHidden();
  await expect(friend.getByTestId("square-0")).toContainText("Skyline Chili");

  // The host sees it, with details in the sheet and the counter badge on the grid.
  await expect(host.getByTestId("square-0")).toContainText("Skyline Chili", LIVE);
  await expect(host.getByTestId("square-0").getByTestId("counter-badge")).toHaveText("×3", LIVE);
  await host.getByTestId("square-0").click();
  await expect(host.getByTestId("square-details")).toHaveValue("A three-way with oyster crackers.");
  await expectNoHorizontalScroll(host);
  await host.keyboard.press("Escape");
  await expect(host.getByTestId("square-sheet")).toBeHidden();

  // Someone else saves the square the host is typing in: the host is asked, typing kept.
  await host.getByTestId("square-1").click();
  await host.getByTestId("square-label").fill("Mine");
  await friend.getByTestId("square-1").click();
  await friend.getByTestId("square-label").fill("Theirs");
  await friend.getByTestId("square-save").click();
  await expect(host.getByTestId("square-conflict")).toContainText("Updated by someone else", LIVE);
  await expect(host.getByTestId("square-label")).toHaveValue("Mine");
  await host.getByTestId("conflict-keep").click();
  await expect(host.getByTestId("square-conflict")).toHaveCount(0);
  await host.getByTestId("square-save").click();
  await expect(host.getByTestId("square-sheet")).toBeHidden();
  await expect(friend.getByTestId("square-1")).toContainText("Mine", LIVE);

  // Free space is chosen on the Create screen only: no control in the lobby for anyone.
  // Tapping the free center explains that, on both phones, instead of opening an editor.
  for (const page of [host, friend]) {
    await expect(page.getByTestId("free-center-toggle")).toHaveCount(0);
    await expect(page.getByRole("switch")).toHaveCount(0);
    await page.getByTestId("square-12").click();
    const info = page.getByTestId("free-space-info");
    await expect(info).toContainText("Free space was set when the game was created.");
    await expect(page.getByTestId("free-space-sheet").getByRole("switch")).toHaveCount(0);
    await expect(page.getByTestId("free-space-sheet").getByRole("checkbox")).toHaveCount(0);
    await expect(page.getByTestId("square-sheet")).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("free-space-sheet")).toBeHidden();
  }

  // Start stays disabled until everyone (host included) is ready.
  const start = host.getByTestId("start-game");
  await expect(start).toBeDisabled();
  await host.getByTestId("ready-toggle").click();
  await expect(host.getByTestId("ready-toggle")).toHaveText("Not ready");
  await expect(friend.getByTestId("player").filter({ hasText: "Hosty" })).toHaveAttribute("data-ready", "true", LIVE);
  await expect(start).toBeDisabled();

  await friend.getByTestId("ready-toggle").click();
  await expect(friend.getByTestId("ready-toggle")).toHaveText("Not ready");
  await expect(start).toBeEnabled(LIVE);
  await expectNoHorizontalScroll(host);
  await expectNoHorizontalScroll(friend);

  // Start: both phones leave the lobby.
  await start.click();
  for (const page of [host, friend]) {
    await expect(page.getByTestId("game-screen")).toHaveAttribute("data-status", "active", LIVE);
    await expect(page.getByTestId("lobby")).toHaveCount(0);
    await expect(page.getByTestId("board-grid")).toBeVisible();
    // start_game completed the free center chosen at creation.
    await expect(page.getByTestId("cell-12")).toHaveAttribute("data-free", "true");
    await expect(page.getByTestId("cell-12")).toHaveAttribute("data-completed", "true");
  }

  await hostContext.close();
  await friendContext.close();
});

test("a game created without the free space has a normal, editable center", async ({ page }) => {
  const gameName = `E2E NoFree ${Date.now().toString(36)}`;
  await page.goto("/new");
  await page.waitForLoadState("networkidle");
  const create = page.getByTestId("create-game");
  await expect(async () => {
    await page.getByTestId("game-name").fill(gameName);
    await page.getByTestId("host-name").fill("Hosty");
    await expect(create).toBeEnabled({ timeout: 1_000 });
  }).toPass();
  await page.getByTestId("pack-blank").click();
  await page.getByTestId("free-center").uncheck({ force: true });
  await expect(page.getByTestId("free-center")).not.toBeChecked();
  await create.click();
  await expect(page.getByTestId("lobby")).toBeVisible();

  const center = page.getByTestId("square-12");
  await expect(center).toHaveAttribute("data-free", "false");
  await expect(center).not.toContainText("FREE");
  await center.click();
  await expect(page.getByTestId("square-sheet")).toBeVisible();
  await expect(page.getByTestId("free-space-sheet")).toBeHidden();
  await page.getByTestId("square-label").fill("Middle of it all");
  await page.getByTestId("square-save").click();
  await expect(page.getByTestId("square-sheet")).toBeHidden();
  await expect(center).toContainText("Middle of it all");
  await expectNoHorizontalScroll(page);
});
