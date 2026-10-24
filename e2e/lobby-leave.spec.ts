import { expect, test, type Page } from "@playwright/test";
import { LIVE, joinPhone, twoPhonesInLobby } from "./helpers";

/**
 * Nobody can keep a lobby from starting: a player's Leave really leaves
 * (`leave_game`), and the host can remove someone who never readies up
 * (`remove_player`). The host has End game instead of Leave. The local
 * backend never delivers Realtime events, so the other phones catch up over
 * the resync poll (1.5 s in e2e).
 */

async function storedActiveGameId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    try {
      return (JSON.parse(localStorage.getItem("bingo.activeGame") ?? "null") as { gameId?: string } | null)?.gameId ?? null;
    } catch {
      return "corrupt";
    }
  });
}

test("lobby: a player leaves, the host removes an idle one, and Start is never blocked", async ({ browser }) => {
  test.setTimeout(150_000);
  // Host and friend in the lobby, both ready (Start enabled on the host).
  const { host, friend, gameId, gameName, code, close } = await twoPhonesInLobby(browser, { prefix: "Leave" });

  await test.step("the host has End game (with a hint), not Leave; players have Leave", async () => {
    await expect(host.getByTestId("leave-lobby")).toHaveCount(0);
    await expect(host.getByTestId("lobby-end-game")).toBeVisible();
    await host.getByTestId("lobby-end-game").click();
    await expect(host.getByTestId("lobby-end-game-panel")).toBeVisible();
    await expect(host.getByTestId("host-leave-hint")).toContainText("can't leave");
    await host.getByTestId("lobby-end-game-cancel").click();
    await expect(host.getByTestId("lobby-end-game-panel")).toHaveCount(0);
    await expect(host.getByTestId("lobby")).toBeVisible();

    await expect(friend.getByTestId("leave-lobby")).toBeVisible();
    await expect(friend.getByTestId("lobby-end-game")).toHaveCount(0);
    // Only the host gets remove controls, and never on their own row.
    await expect(friend.getByTestId("remove-player")).toHaveCount(0);
    await expect(host.getByTestId("remove-player")).toHaveCount(1);
    await expect(host.getByTestId("player").filter({ hasText: "Hosty" }).getByTestId("remove-player")).toHaveCount(0);
  });

  await test.step("the friend leaves: gone from the host's list, the game forgotten on their phone", async () => {
    await expect.poll(() => storedActiveGameId(friend)).toBe(gameId);
    await friend.getByTestId("leave-lobby").click();
    await expect(friend).toHaveURL(/\/$/);
    await expect(friend.getByTestId("new-game")).toBeVisible();
    expect(await storedActiveGameId(friend)).toBeNull();
    // Not a player any more: no "Back to your game", and the game is not in their list.
    await expect(friend.getByText("No games on this phone yet.")).toBeVisible();
    await expect(friend.getByTestId("back-to-game")).toHaveCount(0);
    // (Next keeps the previous route mounted but hidden, so only visible text counts.)
    await expect(friend.getByText(gameName).filter({ visible: true })).toHaveCount(0);

    await expect(host.getByTestId("player")).toHaveCount(1, LIVE);
    await expect(host.getByTestId("player-count")).toHaveText("1/10");
  });

  await test.step("the host can start alone once ready", async () => {
    const start = host.getByTestId("start-game");
    await expect(start).toBeEnabled();
    await host.getByTestId("ready-toggle").click();
    await expect(host.getByTestId("ready-toggle")).toHaveAttribute("data-ready", "false");
    await expect(start).toBeDisabled();
    await host.getByTestId("ready-toggle").click();
    await expect(host.getByTestId("ready-toggle")).toHaveAttribute("data-ready", "true");
    await expect(start).toBeEnabled();
  });

  const third = await joinPhone(browser, code, "Thirdy");

  await test.step("a third phone joins and never readies: Start is locked", async () => {
    await expect(third.page.getByTestId("lobby")).toBeVisible();
    await expect(host.getByTestId("player")).toHaveCount(2, LIVE);
    await expect(host.getByTestId("start-game")).toBeDisabled();
    await expect(host.getByTestId("lobby-status")).toContainText("1 of 2 ready");
    await expect.poll(() => storedActiveGameId(third.page)).toBe(gameId);
  });

  await test.step("the host removes them (inline confirm): Start unlocks", async () => {
    const row = host.getByTestId("player").filter({ hasText: "Thirdy" });
    await row.getByTestId("remove-player").click();
    await expect(row.getByTestId("remove-player-panel")).toContainText("Remove Thirdy from the game?");
    // Cancel keeps them.
    await row.getByTestId("remove-player-cancel").click();
    await expect(row.getByTestId("remove-player-panel")).toHaveCount(0);
    await expect(host.getByTestId("player")).toHaveCount(2);

    await row.getByTestId("remove-player").click();
    await row.getByTestId("remove-player-confirm").click();
    await expect(host.getByTestId("player")).toHaveCount(1, { timeout: 1_000 });
    await expect(host.getByTestId("start-game")).toBeEnabled({ timeout: 5_000 });
    // The resync agrees (still 1 after a couple of polls).
    await host.waitForTimeout(2_000);
    await expect(host.getByTestId("player")).toHaveCount(1);
    await expect(host.getByTestId("remove-player-error")).toHaveCount(0);
  });

  await test.step("the removed phone says so, forgets the game and offers Join again", async () => {
    const page = third.page;
    await expect(page.getByTestId("no-longer-in-game")).toBeVisible(LIVE);
    await expect(page.getByTestId("no-longer-in-game")).toContainText("You're no longer in this game");
    await expect(page.getByTestId("lobby")).toHaveCount(0);
    await expect(page.getByTestId("join-again")).toHaveAttribute("href", `/g/${code}`);
    await expect(page.getByTestId("no-longer-home")).toHaveAttribute("href", "/");
    await expect.poll(() => storedActiveGameId(page)).toBeNull();
  });

  await test.step("the host starts alone; the removed phone can still join again (late join)", async () => {
    await host.getByTestId("start-game").click();
    await expect(host.getByTestId("game-screen")).toHaveAttribute("data-status", "active", { timeout: 5_000 });
    await expect(host.getByTestId("board-grid")).toBeVisible();

    await third.page.getByTestId("join-again").click();
    await expect(third.page).toHaveURL(new RegExp(`/g/${code}$`));
    await third.page.getByTestId("join-name").fill("Thirdy");
    await third.page.getByTestId("join-game").click();
    await expect(third.page.getByTestId("board-grid")).toBeVisible({ timeout: 10_000 });
  });

  await third.context.close();
  await close();
});
