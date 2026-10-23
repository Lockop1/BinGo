import { expect, test, type Page } from "@playwright/test";

async function expectNoHorizontalScroll(page: Page) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, `scrollWidth on ${page.url()}`).toBeLessThanOrEqual(375);
}

async function playerColors(page: Page): Promise<{ indexes: string[]; fills: string[] }> {
  const players = page.getByTestId("player");
  await expect(players).toHaveCount(2);
  const indexes = await players.evaluateAll((els) => els.map((el) => el.getAttribute("data-color") ?? ""));
  const fills = await page
    .getByTestId("player-swatch")
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
  return { indexes, fills };
}

test("host creates a Night Out game and a friend joins via the link", async ({ browser }) => {
  const gameName = `E2E Night ${Date.now().toString(36)}`;

  // Two contexts = two phones = two anonymous users.
  const hostContext = await browser.newContext();
  const friendContext = await browser.newContext();
  const host = await hostContext.newPage();
  const friend = await friendContext.newPage();

  // Home: fresh phone, empty state, fits 375px.
  await host.goto("/");
  await expect(host.getByRole("heading", { name: "Bingo Night" })).toBeVisible();
  await expect(host.getByText("No games on this phone yet.")).toBeVisible();
  await expectNoHorizontalScroll(host);

  // Create.
  await host.getByTestId("new-game").click();
  await expect(host).toHaveURL(/\/new$/);
  await host.waitForLoadState("networkidle");
  await expectNoHorizontalScroll(host);
  const create = host.getByTestId("create-game");
  await expect(create).toBeDisabled();
  await expect(async () => {
    await host.getByTestId("game-name").fill(gameName);
    await host.getByTestId("host-name").fill("Hosty");
    await expect(create).toBeEnabled({ timeout: 1_000 });
  }).toPass();
  await host.getByTestId("pack-night-out").click();
  await expect(host.getByTestId("pack-night-out").locator("input")).toBeChecked();
  await create.click();

  await expect(host).toHaveURL(/\/game\/[0-9a-f-]{36}$/);
  const inviteCode = host.getByTestId("invite-code");
  await expect(inviteCode).toHaveAttribute("data-code", /^[A-Z0-9]{8}$/);
  const code = (await inviteCode.getAttribute("data-code"))!;
  await expect(host.getByTestId("board")).toContainText("Sing on stage at karaoke");
  await expect(host.getByTestId("board")).toContainText("FREE");
  await expect(host.getByTestId("player")).toHaveCount(1);
  await expectNoHorizontalScroll(host);

  // Join from the second phone.
  await friend.goto(`/g/${code}`);
  await expect(friend.getByRole("heading", { name: gameName })).toBeVisible();
  await expect(friend.getByTestId("join-status")).toContainText("Lobby");
  await expect(friend.getByTestId("player-count")).toHaveText("1/10");
  await expectNoHorizontalScroll(friend);
  await friend.getByTestId("join-name").fill("Friendo");
  await friend.getByTestId("join-game").click();
  await expect(friend).toHaveURL(/\/game\/[0-9a-f-]{36}$/);
  const gameUrl = new URL(friend.url()).pathname;
  expect(new URL(host.url()).pathname).toBe(gameUrl);

  // Both phones see two players with distinct colors (no Realtime locally: host refreshes).
  await host.getByTestId("refresh").click();
  for (const page of [host, friend]) {
    const { indexes, fills } = await playerColors(page);
    expect(new Set(indexes).size, `palette indexes on ${page.url()}`).toBe(2);
    expect(new Set(fills).size, `swatch colors on ${page.url()}`).toBe(2);
    await expect(page.getByTestId("players")).toContainText("Hosty");
    await expect(page.getByTestId("players")).toContainText("Friendo");
    await expectNoHorizontalScroll(page);
  }

  // Opening the invite link again as a member goes straight to the game.
  await friend.goto(`/g/${code.toLowerCase().slice(0, 4)}-${code.toLowerCase().slice(4)}`);
  await expect(friend).toHaveURL(new RegExp(`${gameUrl}$`));

  // Each phone's home screen lists the game.
  for (const page of [host, friend]) {
    await page.goto("/");
    const row = page.getByTestId("game-row").filter({ hasText: gameName });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Lobby");
    await expect(row).toContainText("2");
    await expectNoHorizontalScroll(page);
  }

  await hostContext.close();
  await friendContext.close();
});

test("unknown join code and unknown game show the not-found state", async ({ page }) => {
  await page.goto("/g/ZZZZ2222");
  await expect(page.getByText("We couldn't find that game.")).toBeVisible();
  await expectNoHorizontalScroll(page);

  await page.goto("/game/00000000-0000-4000-8000-000000000000");
  await expect(page.getByText("We couldn't find that game.")).toBeVisible();
  await page.getByRole("link", { name: "Go home" }).click();
  await expect(page).toHaveURL(/\/$/);
});
