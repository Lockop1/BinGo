import { expect, test, type Page } from "@playwright/test";
import { LIVE, expectFitsWidth, twoPhonesInActiveGame } from "./helpers";

/**
 * The live board on two phones (Night Out pack, free center on). The local
 * backend never delivers Realtime events, so everything that crosses phones
 * here travels over the resync poll (NEXT_PUBLIC_SYNC_POLL_MS=1500).
 *
 * Night Out layout used below: 0 "Sing on stage at karaoke", 2 "Collect 15
 * stranger signatures" (counter, target 15), 5 "Stranger takes our group
 * photo", 6 "Compliment a stranger's outfit", 12 FREE, 18 "Get the DJ to
 * play our request", 24 "Air guitar solo on the dance floor". The bingo line
 * is the diagonal 0-6-12-18-24 (row 0 contains the counter square).
 */

async function expectNoHorizontalScroll(page: Page, width: number) {
  expect(page.viewportSize()?.width).toBe(width);
  await expectFitsWidth(page, `at ${width}px`);
  // Square cells by default.
  const cell = (await page.getByTestId("cell-7").boundingBox())!;
  expect(Math.abs(cell.width - cell.height)).toBeLessThan(1.5);
}

async function openSquare(page: Page, position: number) {
  await page.getByTestId(`cell-${position}`).click();
  const sheet = page.getByTestId("square-sheet");
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("square-sheet-body")).toHaveAttribute("data-position", String(position));
  return sheet;
}

async function closeSheet(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("square-sheet")).toBeHidden();
}

/** Tap Complete, then Confirm (the keyboard / reduced-motion path). */
async function completeViaConfirm(page: Page, position: number) {
  const sheet = await openSquare(page, position);
  await page.getByTestId("complete-hold").click();
  await page.getByTestId("complete-confirm").click();
  await expect(sheet).toBeHidden();
}

/** Press and hold Complete for longer than 600 ms. */
async function completeViaHold(page: Page, position: number) {
  const sheet = await openSquare(page, position);
  const button = page.getByTestId("complete-hold");
  await button.click({ trial: true }); // waits until the sheet has stopped moving
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(button).toHaveAttribute("data-holding", "true");
  await page.waitForTimeout(800);
  await page.mouse.up();
  await expect(sheet).toBeHidden();
}

async function expectCelebrationOnBoth(a: Page, b: Page) {
  await Promise.all([
    expect(a.getByTestId("celebration")).toBeVisible(LIVE),
    expect(b.getByTestId("celebration")).toBeVisible(LIVE),
  ]);
  await Promise.all([
    expect(a.getByTestId("celebration-overlay")).toContainText("BINGO!"),
    expect(b.getByTestId("celebration-overlay")).toContainText("BINGO!"),
  ]);
  await Promise.all([
    expect(a.getByTestId("celebration")).toHaveCount(0, { timeout: 5_000 }),
    expect(b.getByTestId("celebration")).toHaveCount(0, { timeout: 5_000 }),
  ]);
}

test("live board: cross-off, toasts, bingo once, undo, counters, offline, end game", async ({ browser }) => {
  test.setTimeout(150_000);
  // --- Lobby: Night Out pack, both ready, start (e2e/helpers.ts).
  const { host, friend, friendContext, gameName, gameId, close } = await twoPhonesInActiveGame(browser);

  // --- Both phones see the board; it owns the screen and fits 375 and 320.
  for (const page of [host, friend]) {
    await expect(page.getByTestId("game-screen")).toHaveAttribute("data-status", "active", LIVE);
    await expect(page.getByTestId("board-grid")).toBeVisible();
    await expect(page.getByTestId("board-title")).toHaveText(gameName);
    await expect(page.getByTestId("cell-12")).toHaveAttribute("data-free", "true");
    await expect(page.getByTestId("cell-12")).toHaveAttribute("data-completed", "true");
    await expect(page.getByTestId("cell-2").getByTestId("cell-count")).toHaveText("0/15");
    await expect(page.getByTestId("lobby")).toHaveCount(0);
    await expectNoHorizontalScroll(page, 375);
  }
  await expect(host.getByTestId("players-count")).toHaveText("2");
  await expect(host.getByTestId("album-button")).toBeEnabled();
  await friend.setViewportSize({ width: 320, height: 640 });
  await expectNoHorizontalScroll(friend, 320);

  // The free center explains itself and offers nothing to do.
  await openSquare(friend, 12);
  await expect(friend.getByTestId("square-status")).toContainText("On the house");
  await expect(friend.getByTestId("complete-hold")).toHaveCount(0);
  await expect(friend.getByTestId("undo")).toHaveCount(0);
  await expectNoHorizontalScroll(friend, 320);
  await closeSheet(friend);

  // --- Friend completes square 0 (Complete → Confirm): crossed off instantly, then confirmed.
  await completeViaConfirm(friend, 0);
  const friendCell0 = friend.getByTestId("cell-0");
  await expect(friendCell0).toHaveAttribute("data-completed", "true", { timeout: 500 });
  await expect(friendCell0.getByTestId("scribble")).toBeVisible();
  await expect(friendCell0).not.toHaveAttribute("data-pending");
  await expect(friendCell0.getByTestId("cell-badge")).toHaveText("F");

  // The host sees the cross-off and a toast within the poll interval.
  const hostCell0 = host.getByTestId("cell-0");
  await expect(hostCell0).toHaveAttribute("data-completed", "true", LIVE);
  await expect(host.getByTestId("toast")).toContainText("Friendo got Sing on stage at karaoke", LIVE);
  await expect(hostCell0.getByTestId("cell-badge")).toHaveText("F");

  // Tapping the toast's square shows who got it.
  await openSquare(host, 0);
  await expect(host.getByTestId("square-status")).toContainText("Crossed off by Friendo");
  await closeSheet(host);

  // --- Host finishes the diagonal: 6 (press and hold), 18, then 24 for the bingo.
  await completeViaHold(host, 6);
  await expect(host.getByTestId("cell-6")).toHaveAttribute("data-completed", "true");
  await completeViaConfirm(host, 18);
  await expect(friend.getByTestId("cell-18")).toHaveAttribute("data-completed", "true", LIVE);
  await expect(friend.getByTestId("cell-6")).toHaveAttribute("data-completed", "true");
  await expect(host.getByTestId("game-screen")).toHaveAttribute("data-celebrations", "0");
  await completeViaConfirm(host, 24);
  await expectCelebrationOnBoth(host, friend);
  await expect(host.getByTestId("game-screen")).toHaveAttribute("data-celebrations", "1");
  await expect(friend.getByTestId("game-screen")).toHaveAttribute("data-celebrations", "1");
  expect(
    JSON.parse((await host.evaluate((id) => localStorage.getItem(`bingo.celebrated.${id}`), gameId)) ?? "[]"),
  ).toContain("d0");

  // A reload does not celebrate the same line again.
  await host.reload();
  await expect(host.getByTestId("board-grid")).toBeVisible();
  await expect(host.getByTestId("cell-24")).toHaveAttribute("data-completed", "true");
  await host.waitForTimeout(2_500);
  await expect(host.getByTestId("celebration")).toHaveCount(0);
  await expect(host.getByTestId("game-screen")).toHaveAttribute("data-celebrations", "0");

  // --- Undo: the host may undo the friend's square (two taps); the friend sees it reopen.
  await openSquare(host, 0);
  const undoBox = (await host.getByTestId("undo").boundingBox())!;
  expect(undoBox.height).toBeGreaterThanOrEqual(44);
  // One tap only asks; left alone, it goes back to "Undo" and nothing changes.
  await host.getByTestId("undo").click();
  await expect(host.getByTestId("undo-confirm")).toHaveText("Confirm undo");
  await expect(host.getByTestId("undo")).toHaveText("Undo", { timeout: 6_000 });
  await expect(hostCell0).toHaveAttribute("data-completed", "true");
  // Tap, then confirm (a second tap within ~350 ms counts as a double-tap and is ignored).
  await host.getByTestId("undo").click();
  await expect(host.getByTestId("undo-hint")).toHaveText("Tap again to reopen it for everyone.");
  await host.waitForTimeout(500);
  await host.getByTestId("undo-confirm").click();
  await expect(host.getByTestId("complete-hold")).toBeVisible();
  await closeSheet(host);
  await expect(hostCell0).toHaveAttribute("data-completed", "false");
  await expect(friendCell0).toHaveAttribute("data-completed", "false", LIVE);
  await expect(friend.getByTestId("toast")).toContainText("Hosty undid Sing on stage at karaoke", { timeout: 10_000 });

  // The friend cannot undo the host's square (no control; the RPC enforces it anyway).
  await openSquare(friend, 6);
  await expect(friend.getByTestId("square-status")).toContainText("Crossed off by Hosty");
  await expect(friend.getByTestId("undo")).toHaveCount(0);
  await closeSheet(friend);

  // Re-completing the line does not celebrate it a second time on either phone.
  await completeViaConfirm(friend, 0);
  await expect(hostCell0).toHaveAttribute("data-completed", "true", LIVE);
  await host.waitForTimeout(1_500);
  await expect(friend.getByTestId("celebration")).toHaveCount(0);
  await expect(host.getByTestId("celebration")).toHaveCount(0);
  await expect(friend.getByTestId("game-screen")).toHaveAttribute("data-celebrations", "1");
  await expect(host.getByTestId("game-screen")).toHaveAttribute("data-celebrations", "0");

  // --- Counter square: every +1 counts exactly once (action ids; see counters.spec.ts).
  await openSquare(friend, 2);
  const counter = friend.getByTestId("counter-value");
  await expect(counter).toHaveText("0/15");
  const plusOne = friend.getByTestId("increment");
  await plusOne.click();
  await plusOne.click();
  await plusOne.click();
  await expect(counter).toHaveText("3/15");
  await closeSheet(friend);
  await expect(friend.getByTestId("cell-2")).toHaveAttribute("data-count", "3/15");

  await expect(host.getByTestId("cell-2")).toHaveAttribute("data-count", "3/15", LIVE);
  await openSquare(host, 2);
  await expect(host.getByTestId("counter-value")).toHaveText("3/15");
  await host.getByTestId("increment").click();
  await host.getByTestId("increment").click();
  await expect(host.getByTestId("counter-value")).toHaveText("5/15");
  await closeSheet(host);

  await expect(friend.getByTestId("cell-2")).toHaveAttribute("data-count", "5/15", LIVE);
  // Settled on the server: a couple of polls later both still say 5.
  await host.waitForTimeout(2_000);
  for (const page of [host, friend]) {
    await expect(page.getByTestId("cell-2")).toHaveAttribute("data-count", "5/15");
    await expect(page.getByTestId("cell-2")).toHaveAttribute("data-completed", "false");
  }

  // --- Offline: the friend's completion shows at once and syncs on reconnect.
  await friendContext.setOffline(true);
  await completeViaConfirm(friend, 5);
  const friendCell5 = friend.getByTestId("cell-5");
  await expect(friendCell5).toHaveAttribute("data-completed", "true");
  await expect(friendCell5).toHaveAttribute("data-pending", "true");
  await expect(friend.getByTestId("sync-mark")).toBeVisible();
  // Failed polls while offline never flip the pending cross-off back.
  await friend.waitForTimeout(2_500);
  await expect(friendCell5).toHaveAttribute("data-pending", "true");
  await expect(friendCell5).toHaveAttribute("data-completed", "true");
  await expect(host.getByTestId("cell-5")).toHaveAttribute("data-completed", "false");

  await friendContext.setOffline(false);
  await expect(host.getByTestId("cell-5")).toHaveAttribute("data-completed", "true", { timeout: 5_000 });
  await expect(host.getByTestId("cell-5")).toHaveAttribute("data-completed-by", (await friendCell5.getAttribute("data-completed-by"))!);
  await expect(friendCell5).not.toHaveAttribute("data-pending", { timeout: 5_000 });
  await expect(friend.getByTestId("sync-mark")).toHaveCount(0, { timeout: 5_000 });

  // --- Players sheet: everyone sees the auto-end time; only the host can end the game.
  await friend.getByTestId("players-button").click();
  await expect(friend.getByTestId("players-sheet")).toBeVisible();
  await expect(friend.getByTestId("board-player")).toHaveCount(2);
  await expect(friend.getByTestId("auto-end")).toContainText(/^Ends .+ \(.+\)$/);
  await expect(friend.getByTestId("end-game")).toHaveCount(0);
  await friend.keyboard.press("Escape");
  await expect(friend.getByTestId("players-sheet")).toBeHidden();

  await host.getByTestId("players-button").click();
  await expect(host.getByTestId("board-player").filter({ hasText: "Hosty" })).toContainText("you");
  await expect(host.getByTestId("board-player").filter({ hasText: "Hosty" })).toContainText("host");
  await expect(host.getByTestId("auto-end")).toContainText(/^Ends .+ \(.+\)$/);
  await host.getByTestId("end-game").click();
  await host.getByTestId("end-game-confirm").click();

  for (const page of [host, friend]) {
    await expect(page.getByTestId("recap-summary")).toBeVisible(LIVE);
    await expect(page.getByTestId("game-screen")).toHaveAttribute("data-status", "ended");
    await expect(page.getByTestId("board-grid")).toHaveCount(0);
  }

  await close();
});
