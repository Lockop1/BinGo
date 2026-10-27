import { expect, test } from "@playwright/test";
import { LIVE, expectPageFitsWidth, openSettings, rpcRawAs, selectAs, twoPhonesInActiveGame } from "./helpers";

/**
 * The host's controls live in one place: Settings (the board's gear) → "Host",
 * at the top of the sheet: Extend deadline (once) and End game (with a
 * confirm step). Nobody else's Settings shows the section, the Players sheet
 * has no host buttons any more, and the RPCs refuse a non-host who calls them
 * directly (`not_host`).
 */

type GameRow = { status: string; end_reason: string | null; deadline_at: string; deadline_extended_at: string | null };

test("host settings: only the host sees Host in Settings; extend and end from there; non-host RPCs get not_host", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { host, friend, hostContext, friendContext, gameId, close } = await twoPhonesInActiveGame(browser, {
    prefix: "HostSettings",
    deadline: "day",
  });

  // The board screen itself has no host buttons: they are all inside Settings.
  for (const page of [host, friend]) {
    await expect(page.getByTestId("end-game")).toHaveCount(0);
    await expect(page.getByTestId("extend-deadline")).toHaveCount(0);
  }

  // The friend: Settings without a Host section; Players without host controls.
  await openSettings(friend);
  await expect(friend.getByTestId("settings-theme")).toBeVisible();
  await expect(friend.getByTestId("settings-host")).toHaveCount(0);
  await expect(friend.getByTestId("end-game")).toHaveCount(0);
  await expect(friend.getByTestId("extend-deadline")).toHaveCount(0);
  await friend.keyboard.press("Escape");
  await expect(friend.getByTestId("settings-sheet")).toBeHidden();
  await friend.getByTestId("players-button").click();
  await expect(friend.getByTestId("players-sheet")).toBeVisible();
  await expect(friend.getByTestId("auto-end")).toBeVisible();
  await expect(friend.getByTestId("end-game")).toHaveCount(0);
  await friend.keyboard.press("Escape");
  await expect(friend.getByTestId("players-sheet")).toBeHidden();

  // ...and calling the RPCs directly does not help.
  const [before] = await selectAs<GameRow>(hostContext, `games?id=eq.${gameId}&select=status,end_reason,deadline_at,deadline_extended_at`);
  const notHostExtend = await rpcRawAs(friendContext, "extend_deadline", {
    game_id: gameId,
    deadline_at: new Date(Date.parse(before.deadline_at) + 60 * 60_000).toISOString(),
  });
  expect(notHostExtend.status).toBe(400);
  expect(notHostExtend.body.message).toBe("not_host");
  const notHostEnd = await rpcRawAs(friendContext, "end_game", { game_id: gameId });
  expect(notHostEnd.status).toBe(400);
  expect(notHostEnd.body.message).toBe("not_host");
  const [unchanged] = await selectAs<GameRow>(hostContext, `games?id=eq.${gameId}&select=status,end_reason,deadline_at,deadline_extended_at`);
  expect(unchanged).toEqual(before);

  // The host: the Host section opens the sheet, above the board settings.
  await host.getByTestId("players-button").click();
  await expect(host.getByTestId("players-sheet")).toBeVisible();
  await expect(host.getByTestId("end-game")).toHaveCount(0);
  await expect(host.getByTestId("extend-deadline")).toHaveCount(0);
  await host.keyboard.press("Escape");
  await expect(host.getByTestId("players-sheet")).toBeHidden();
  await openSettings(host);
  const section = host.getByTestId("settings-host");
  await expect(section).toBeVisible();
  await expect(section).toContainText("Host");
  const sectionBox = (await section.boundingBox())!;
  const themeBox = (await host.getByTestId("settings-theme").boundingBox())!;
  expect(sectionBox.y, "Host section first").toBeLessThan(themeBox.y);
  await expect(section.getByTestId("extend-deadline")).toBeVisible();
  await expect(section.getByTestId("end-game")).toBeVisible();
  await host.setViewportSize({ width: 320, height: 640 });
  await expectPageFitsWidth(host, "Settings with the Host section at 320px");
  await host.setViewportSize({ width: 375, height: 812 });

  // Extend once by +1 hour from Settings: both countdowns move; then only the muted line.
  await section.getByTestId("extend-deadline").click();
  const extend = host.getByTestId("extend-sheet");
  await expect(extend).toBeVisible();
  await expect(host.getByTestId("settings-sheet")).toBeHidden();
  await extend.getByTestId("extend-option-1h").click();
  await extend.getByTestId("extend-save").click();
  await expect(extend).toBeHidden();
  const [extended] = await selectAs<GameRow>(hostContext, `games?id=eq.${gameId}&select=status,end_reason,deadline_at,deadline_extended_at`);
  expect(extended.deadline_extended_at).not.toBeNull();
  expect(Date.parse(extended.deadline_at) - Date.parse(before.deadline_at)).toBe(60 * 60_000);
  await openSettings(host);
  await expect(host.getByTestId("deadline-extended")).toHaveText("Deadline extended once", LIVE);
  await expect(host.getByTestId("extend-deadline")).toHaveCount(0);
  await expect(host.getByTestId("end-game")).toBeVisible();

  // End game: a confirm step, "Keep playing" backs out.
  await host.getByTestId("end-game").click();
  await expect(host.getByTestId("end-game-confirm")).toBeVisible();
  await host.getByTestId("end-game-cancel").click();
  await expect(host.getByTestId("end-game-confirm")).toHaveCount(0);
  await expect(host.getByTestId("game-screen")).toHaveAttribute("data-status", "active");
  await host.getByTestId("end-game").click();
  await host.getByTestId("end-game-confirm").click();
  for (const page of [host, friend]) {
    await expect(page.getByTestId("recap-summary")).toBeVisible(LIVE);
    await expect(page.getByTestId("game-ended")).toHaveAttribute("data-end-reason", "host");
  }
  const [ended] = await selectAs<GameRow>(friendContext, `games?id=eq.${gameId}&select=status,end_reason,deadline_at,deadline_extended_at`);
  expect(ended.status).toBe("ended");
  expect(ended.end_reason).toBe("host");

  await close();
});
