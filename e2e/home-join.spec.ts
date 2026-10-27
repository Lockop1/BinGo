import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { anonUser, expectPageFitsWidth, joinPhone, rpcWithToken } from "./helpers";

/**
 * Home's "Got a code? Join a game": a friend who only has the code (no link)
 * types it on Home and lands on the join screen; unknown, full and ended
 * codes get their message right on Home. Hosts and extra players are bare
 * anonymous users (`anonUser`), so filling a game to 10 costs no browsers.
 */

type GameRow = { id: string; join_code: string };

async function hostGame(request: APIRequestContext, name: string): Promise<{ game: GameRow; token: string }> {
  const { token } = await anonUser(request);
  const game = await rpcWithToken<GameRow>(request, token, "create_game", { name, host_name: "Hosty" });
  expect(game.join_code).toMatch(/^[A-Z0-9]{8}$/);
  return { game, token };
}

/** "ABCD2345" → "abcd 2345" (or with a dash): how people actually type a code read out to them. */
function sloppy(code: string, sep: string): string {
  return `${code.slice(0, 4)}${sep}${code.slice(4)}`.toLowerCase();
}

async function openHome(page: Page, path = "/") {
  await page.goto(path);
  await expect(page.getByTestId("home-join-code")).toBeVisible();
  await page.waitForLoadState("networkidle");
}

test("a friend with only the code joins from Home", async ({ browser, request }) => {
  const name = `E2E HomeJoin ${Date.now().toString(36)}`;
  const { game } = await hostGame(request, name);

  const context = await browser.newContext();
  const page = await context.newPage();
  await openHome(page);

  const input = page.getByTestId("home-join-code");
  const button = page.getByTestId("home-join-button");
  // A code, not a word: no autocapitalize / autocorrect, big enough that iOS never zooms.
  await expect(input).toHaveAttribute("autocapitalize", "off");
  await expect(input).toHaveAttribute("autocorrect", "off");
  await expect(input).toHaveAttribute("inputmode", "text");
  const fontSize = await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(16);
  for (const target of [input, button]) {
    const box = await target.boundingBox();
    expect(box!.height, "tap target height").toBeGreaterThanOrEqual(44);
  }
  // "New game" stays first, "Your games" below the join line.
  const newGame = await page.getByTestId("new-game").boundingBox();
  const yourGames = await page.getByRole("heading", { name: "Your games" }).boundingBox();
  const inputBox = await input.boundingBox();
  expect(newGame!.y).toBeLessThan(inputBox!.y);
  expect(inputBox!.y).toBeLessThan(yourGames!.y);

  // Join stays disabled until there are 8 characters (spaces / dashes don't count).
  await expect(button).toBeDisabled();
  await input.pressSequentially(sloppy(game.join_code, " ").slice(0, 8));
  await expect(button).toBeDisabled();
  await input.pressSequentially(game.join_code.slice(7).toLowerCase());
  await expect(input).toHaveValue(sloppy(game.join_code, " "));
  await expect(button).toBeEnabled();
  await expectPageFitsWidth(page, "home with a code");

  // Enter submits.
  await input.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/g/${game.join_code}$`));
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await page.getByTestId("join-name").fill("Codey");
  await page.getByTestId("join-game").click();
  await expect(page).toHaveURL(new RegExp(`/game/${game.id}$`));
  await expect(page.getByTestId("lobby")).toBeVisible();
  await expect(page.getByTestId("player")).toHaveCount(2);

  await context.close();
});

test("Home explains unknown codes without leaving the screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openHome(page);
  const input = page.getByTestId("home-join-code");
  const button = page.getByTestId("home-join-button");
  const error = page.getByTestId("home-join-error");

  await input.fill("zzzz-2222");
  await button.click();
  await expect(error).toHaveText("We couldn't find that game.");
  await expect(page).toHaveURL(/\/$/);
  await expectPageFitsWidth(page, "home at 320 with an error");

  // Editing clears the message; too many characters is never a code.
  await input.fill("ABCD 23456");
  await expect(error).toHaveText("");
  await input.press("Enter");
  await expect(error).toHaveText("We couldn't find that game.");
  await expect(page).toHaveURL(/\/$/);
});

test("Home says when a game is full, but lets its own players in", async ({ browser, request }) => {
  const { game } = await hostGame(request, `E2E Full ${Date.now().toString(36)}`);
  // Host + 8 bare players + one phone = 10.
  for (let i = 0; i < 8; i++) {
    const { token } = await anonUser(request);
    await rpcWithToken(request, token, "join_game", { code: game.join_code, display_name: `P${i + 2}` });
  }
  const member = await joinPhone(browser, game.join_code, "Tenth");
  await expect(member.page.getByTestId("player")).toHaveCount(10);

  // A newcomer is stopped on Home.
  const context = await browser.newContext();
  const page = await context.newPage();
  await openHome(page);
  await page.getByTestId("home-join-code").fill(sloppy(game.join_code, "-"));
  await page.getByTestId("home-join-button").click();
  await expect(page.getByTestId("home-join-error")).toHaveText("This game is full (10 players).");
  await expect(page).toHaveURL(/\/$/);

  // The tenth player typing the same code goes straight back into the game.
  await openHome(member.page, "/?stay=1");
  await member.page.getByTestId("home-join-code").fill(game.join_code);
  await member.page.getByTestId("home-join-button").click();
  await expect(member.page).toHaveURL(new RegExp(`/game/${game.id}$`));
  await expect(member.page.getByTestId("lobby")).toBeVisible();

  await context.close();
  await member.context.close();
});

test("Home says when a game has already ended", async ({ page, request }) => {
  const { game, token } = await hostGame(request, `E2E Ended ${Date.now().toString(36)}`);
  await rpcWithToken(request, token, "end_game", { game_id: game.id });

  await openHome(page);
  await page.getByTestId("home-join-code").fill(sloppy(game.join_code, " "));
  await page.getByTestId("home-join-button").click();
  await expect(page.getByTestId("home-join-error")).toHaveText("This game has already ended.");
  await expect(page).toHaveURL(/\/$/);
});
