import { expect, test, type Page } from "@playwright/test";
import {
  LIVE,
  endGameFromSettings,
  expectFitsWidth,
  expectPageFitsWidth,
  publicSupabaseEnv,
  rpcAs,
  twoPhonesInActiveGame,
} from "./helpers";

/**
 * Media and the recap wired into the real game (Night Out pack, free center
 * on). The local backend's Storage answers 501, so no upload can finish here:
 * this proves the gating of the square sheet's media row, the album button,
 * and that the ended screen renders the recap from real game data.
 *
 * Night Out square 0 is "Sing on stage at karaoke". The host is color 0, the
 * friend (second to join) color 1.
 */

const SQUARE_0 = "Sing on stage at karaoke";

async function openSquare(page: Page, position: number) {
  await page.getByTestId(`cell-${position}`).click();
  await expect(page.getByTestId("square-sheet")).toBeVisible();
  await expect(page.getByTestId("square-sheet-body")).toHaveAttribute("data-position", String(position));
}

async function closeSheet(page: Page, testId = "square-sheet") {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId(testId)).toBeHidden();
}

async function expectAddAndShare(page: Page) {
  const sheet = page.getByTestId("square-sheet");
  await expect(sheet.getByTestId("add-media")).toBeVisible(LIVE);
  await expect(sheet.getByTestId("add-media")).toHaveText("Add photo/video");
  await expect(sheet.getByTestId("add-media-input")).toHaveAttribute("capture", "environment");
  await expect(sheet.getByTestId("share-group")).toHaveText("Share to group chat");
  await expect(sheet.getByTestId("media-hint")).toHaveCount(0);
  // No media yet: no thumbnail strip.
  await expect(sheet.getByTestId("square-media")).toHaveCount(0);
}

test("media wiring: sheet gating, empty album, recap on end", async ({ browser }) => {
  test.setTimeout(120_000);
  const { host, friend, code, close } = await twoPhonesInActiveGame(browser, {
    prefix: "Media",
    // The friend can read the clipboard, and has no share sheet (so Share copies).
    friend: { permissions: ["clipboard-read", "clipboard-write"] },
    prepare: async (context) => {
      await context.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, "share", { value: undefined, configurable: true });
      });
    },
  });

  // --- An open square: the "complete it first" hint, no Add button, Share still offered.
  await openSquare(friend, 0);
  const sheet = friend.getByTestId("square-sheet");
  await expect(sheet.getByTestId("media-hint")).toHaveText("Complete it to add a photo or video.");
  await expect(sheet.getByTestId("add-media")).toHaveCount(0);
  await expect(sheet.getByTestId("share-group")).toBeVisible();
  await expectFitsWidth(friend, "with the square sheet open");
  await friend.setViewportSize({ width: 320, height: 640 });
  await expectFitsWidth(friend, "with the square sheet open at 320px");
  await friend.setViewportSize({ width: 375, height: 812 });

  // --- The friend completes square 0: their sheet now offers Add photo/video and Share.
  await friend.getByTestId("complete-hold").click();
  await friend.getByTestId("complete-confirm").click();
  await expect(sheet).toBeHidden();
  await expect(friend.getByTestId("cell-0")).toHaveAttribute("data-completed", "true");
  await expect(friend.getByTestId("cell-0")).not.toHaveAttribute("data-pending");
  await openSquare(friend, 0);
  await expectAddAndShare(friend);
  await expectFitsWidth(friend, "with the completed square's sheet open");
  // Without a share sheet, Share copies the message and the link, not just the link.
  await friend.getByTestId("share-group").click();
  await expect(friend.getByTestId("share-feedback")).toHaveText("Copied");
  const copied = await friend.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(new RegExp(`^Friendo just completed ${SQUARE_0}\n\\S+/g/${code}$`));
  await closeSheet(friend);

  // The host sees it completed and gets the same actions for square 0.
  await expect(host.getByTestId("cell-0")).toHaveAttribute("data-completed", "true", LIVE);
  await openSquare(host, 0);
  await expect(host.getByTestId("square-status")).toContainText("Crossed off by Friendo");
  await expectAddAndShare(host);
  await closeSheet(host);

  // --- The album button is live on both phones; with no media it explains how to add some.
  for (const page of [host, friend]) {
    const album = page.getByTestId("album-button");
    await expect(album).toBeEnabled();
    await expect(album).toHaveAttribute("data-count", "0");
    await expect(page.getByTestId("album-count")).toHaveCount(0);
    await album.click();
    const albumSheet = page.getByTestId("album-sheet");
    await expect(albumSheet).toBeVisible();
    await expect(page.getByTestId("album-empty")).toHaveText(
      "No photos yet — complete a square and add one from its sheet.",
    );
    await expect(page.getByTestId("recap-story")).toHaveCount(0);
    await expectFitsWidth(page, "with the album sheet open");
    await closeSheet(page, "album-sheet");
  }

  // --- The host ends the game: both phones land on the recap.
  await endGameFromSettings(host);

  for (const page of [host, friend]) {
    await expect(page.getByTestId("game-screen")).toHaveAttribute("data-status", "ended", LIVE);
    await expect(page.getByTestId("board-grid")).toHaveCount(0);
    const summary = page.getByTestId("recap-summary");
    await expect(summary).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Night recap" })).toBeVisible();
    // Square 0 plus the free center.
    await expect(page.getByTestId("recap-count")).toHaveAttribute("data-count", "2");
    await expect(page.getByTestId("recap-no-media")).toContainText("No photos or videos this time.");
    const row = page.getByTestId("recap-square-row").filter({ hasText: SQUARE_0 });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Friendo");
    await expect(row.getByTestId("color-chip")).toHaveAttribute("data-color", "1");
    await expect(page.getByTestId("recap-square-row").filter({ hasText: "FREE" })).toContainText("on the house");
    await expect(page.getByTestId("recap-player").filter({ hasText: "Friendo" })).toContainText("1 square");
    await expect(page.getByTestId("recap-expiry")).toContainText("Album available until");
    await expect(summary).toContainText("Save before it's gone.");
    // Nothing to watch or download without media.
    await expect(page.getByTestId("recap-watch")).toHaveCount(0);
    await expectPageFitsWidth(page, "on the recap");
  }
  await friend.setViewportSize({ width: 320, height: 640 });
  await expectPageFitsWidth(friend, "on the recap at 320px");

  // --- "Back to home" works.
  await friend.getByTestId("back-home").click();
  await expect(friend).toHaveURL(/\/$/);
  await expect(friend.getByTestId("new-game")).toBeVisible();

  await close();
});

/**
 * A media row flowing through the live game. Local Storage is a stub (501),
 * so the friend's `register_media` is called directly, as the friend, the way
 * the upload queue does after an upload; the object itself never exists, so
 * every thumbnail and story item shows its "couldn't load" state. What this
 * proves: the row reaches both phones via the resync, the host gets a toast
 * that opens the square, the album badge counts it, the square sheet shows
 * the strip, a thumbnail and the album button open the story at that item,
 * and the recap switches to its with-media actions.
 */
test("media wiring: a registered photo reaches the strip, the album, a toast and the recap", async ({ browser }) => {
  test.skip(publicSupabaseEnv() === null, "needs NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY");
  test.setTimeout(120_000);
  const { host, friend, friendContext, gameId, close } = await twoPhonesInActiveGame(browser, { prefix: "Album" });

  // Friend completes square 0, then "uploads" a photo for it.
  await openSquare(friend, 0);
  await friend.getByTestId("complete-hold").click();
  await friend.getByTestId("complete-confirm").click();
  await expect(friend.getByTestId("cell-0")).not.toHaveAttribute("data-pending");
  await expect(friend.getByTestId("cell-0")).toHaveAttribute("data-completed", "true");
  await expect(host.getByTestId("cell-0")).toHaveAttribute("data-completed", "true", LIVE);
  // Let the completion toast on the host pass first.
  await expect(host.getByTestId("toast")).toHaveCount(0, { timeout: 5_000 });

  const media = await rpcAs<{ id: string; storage_path: string }>(friendContext, "register_media", {
    game_id: gameId,
    position: 0,
    storage_path: `${gameId}/0/e2e-${Date.now().toString(36)}.jpg`,
    kind: "photo",
  });

  // Host: a toast names the friend and the square; tapping it opens that square's sheet.
  const toast = host.getByTestId("toast");
  await expect(toast).toHaveText(`Friendo added a photo to ${SQUARE_0}`, LIVE);
  await toast.click();
  await expect(host.getByTestId("square-sheet-body")).toHaveAttribute("data-position", "0");
  await expect(host.getByTestId("square-media-heading")).toHaveText("Photos · 1");
  await expect(host.getByTestId("square-media-thumb")).toHaveCount(1);
  await expectFitsWidth(host, "with the strip open");
  await closeSheet(host);

  // The friend never gets a toast for their own photo; both badges count it.
  await expect(friend.getByTestId("album-count")).toHaveText("1", LIVE);
  await expect(host.getByTestId("album-count")).toHaveText("1");
  await expect(friend.getByTestId("toast")).toHaveCount(0);

  // A thumbnail opens the story at that item (the square sheet closes first).
  await openSquare(friend, 0);
  await friend.getByTestId("square-media-thumb").click();
  const story = friend.getByTestId("recap-story");
  await expect(story).toBeVisible();
  await expect(friend.getByTestId("square-sheet")).toBeHidden();
  await expect(story).toHaveAttribute("data-position", "0");
  await expect(friend.getByTestId("story-label")).toHaveText(SQUARE_0);
  await expect(friend.getByTestId("story-completer")).toHaveText("Friendo");
  await expect(friend.getByTestId("story-close")).toBeFocused();
  await friend.getByTestId("story-close").click();
  await expect(story).toHaveCount(0);
  // Closing the story leaves the page scrollable again (no stuck scroll lock).
  expect(await friend.evaluate(() => document.body.style.overflow)).toBe("");

  // The album button opens the story straight away now.
  await host.getByTestId("album-button").click();
  await expect(host.getByTestId("recap-story")).toBeVisible();
  await expect(host.getByTestId("album-sheet")).toHaveCount(0);
  await expect(host.getByTestId("story-position")).toHaveText("1 of 1");
  await host.keyboard.press("Escape");
  await expect(host.getByTestId("recap-story")).toHaveCount(0);

  // End: the recap offers the story and the download instead of the no-media copy.
  await endGameFromSettings(host);
  for (const page of [host, friend]) {
    await expect(page.getByTestId("recap-summary")).toBeVisible(LIVE);
    await expect(page.getByTestId("recap-watch")).toBeVisible();
    await expect(page.getByTestId("recap-no-media")).toHaveCount(0);
    await expectPageFitsWidth(page, "on the recap with media");
  }
  await friend.getByTestId("recap-watch").click();
  await expect(friend.getByTestId("recap-story")).toHaveAttribute("data-position", "0");
  await expect(friend.getByTestId("story-segment")).toHaveCount(1);
  expect(media.storage_path.startsWith(`${gameId}/0/`)).toBe(true);

  await close();
});
