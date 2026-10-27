import { expect, test, type Page } from "@playwright/test";
import { LIVE, endGameFromSettings, publicSupabaseEnv, twoPhonesInActiveGame } from "./helpers";

/**
 * Instant return and the persisted offline queue, on two phones in a live
 * game (Night Out pack). The local backend never delivers Realtime events,
 * so cross-phone changes travel over the resync poll (1.5 s in e2e).
 *
 * (a) Reopening `/` jumps to the board, drawn from the localStorage snapshot
 *     before any REST response arrives (REST is held back 3 s).
 * (b) A completion made offline survives a reload (page from the service
 *     worker, board from the snapshot, overlay from the stored queue) and
 *     syncs once the connection is back. `next dev` cannot hydrate a document
 *     answered from the worker's cache (see the step), so there the reload is
 *     checked in two halves; production checks it in one.
 * (d) Home on purpose from the board stays home, with "Back to your game".
 * (c) After the host ends the game, the next open of `/` lands on the recap
 *     once; the one after that shows home with the game listed as Ended.
 */

const REST = "**/rest/v1/**";
const REST_DELAY_MS = 3_000;

async function stored(page: Page, key: string): Promise<unknown> {
  return page.evaluate((k) => {
    try {
      return JSON.parse(localStorage.getItem(k) ?? "null");
    } catch {
      return "corrupt";
    }
  }, key);
}

async function storedActiveGameId(page: Page): Promise<string | null> {
  const record = (await stored(page, "bingo.activeGame")) as { gameId?: string } | null;
  return record?.gameId ?? null;
}

async function openSquare(page: Page, position: number) {
  await page.getByTestId(`cell-${position}`).click();
  await expect(page.getByTestId("square-sheet")).toBeVisible();
  await expect(page.getByTestId("square-sheet-body")).toHaveAttribute("data-position", String(position));
}

/** Tap Complete, then Confirm (the keyboard / reduced-motion path). */
async function completeViaConfirm(page: Page, position: number) {
  await openSquare(page, position);
  await page.getByTestId("complete-hold").click();
  await page.getByTestId("complete-confirm").click();
  await expect(page.getByTestId("square-sheet")).toBeHidden();
}

test("instant return: board from the snapshot, offline completion across a reload, recap once, home on purpose", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const phones = await twoPhonesInActiveGame(browser, { prefix: "Return" });
  const { host, friendContext, gameId, gameName, close } = phones;
  const gameUrl = new RegExp(`/game/${gameId}$`);
  let friend = phones.friend;

  // The friend's phone keeps the live game and a snapshot of it (debounced save).
  await expect.poll(() => storedActiveGameId(friend)).toBe(gameId);
  await expect
    .poll(async () => ((await stored(friend, "bingo.activeGame")) as { status?: string } | null)?.status)
    .toBe("active");

  await test.step("(a) reopening / lands on the board before the network answers", async () => {
    // Compile both routes first, so the dev server's first-request compile is not what gets timed.
    await friendContext.request.get("/");
    await friendContext.request.get(`/game/${gameId}`);

    await friend.close();
    friend = await friendContext.newPage();
    const restResponses: string[] = [];
    friend.on("response", (response) => {
      if (response.url().includes("/rest/v1/")) restResponses.push(response.url());
    });
    // Records whether home's "New game" button was ever rendered visible (it must not flash).
    await friend.addInitScript(() => {
      const w = window as unknown as { __homePainted?: boolean };
      w.__homePainted = false;
      const check = () => {
        const button = document.querySelector('[data-testid="new-game"]');
        if (button && getComputedStyle(button).visibility !== "hidden") w.__homePainted = true;
      };
      new MutationObserver(check).observe(document, { childList: true, subtree: true, attributes: true });
    });
    await friend.route(REST, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, REST_DELAY_MS));
      await route.continue().catch(() => {});
    });

    const started = Date.now();
    await friend.goto("/", { waitUntil: "commit" });
    await expect(friend).toHaveURL(gameUrl, { timeout: REST_DELAY_MS });
    await expect(friend.getByTestId("board-grid")).toBeVisible({ timeout: REST_DELAY_MS });
    const elapsed = Date.now() - started;
    expect(restResponses, "the board was drawn before any REST response").toEqual([]);
    expect(elapsed, "board visible soon after the open").toBeLessThan(REST_DELAY_MS);
    await expect(friend.getByTestId("board-title")).toHaveText(gameName);
    await expect(friend.getByTestId("cell-12")).toHaveAttribute("data-completed", "true");
    await expect(friend.getByTestId("game-screen")).toHaveAttribute("data-sync-state", "syncing");
    // Home never painted on the way.
    await expect(friend.getByTestId("new-game")).toHaveCount(0);
    expect(await friend.evaluate(() => (window as unknown as { __homePainted?: boolean }).__homePainted)).toBe(false);

    await friend.unroute(REST);
    await expect(friend.getByTestId("game-screen")).toHaveAttribute("data-sync-state", "live", { timeout: 15_000 });
    expect(restResponses.length).toBeGreaterThan(0);
  });

  await test.step("(b) an offline completion survives a reload and syncs on reconnect", async () => {
    // `next dev` streams React debug info for each document over its HMR socket,
    // keyed by the request id in `self.__next_r`, and hydration waits for it. A
    // document answered from the service worker's cache never gets it, so in dev
    // it can't hydrate (production has no debug channel). In that case the
    // offline reload proves the worker serves the cached game page, and a second
    // reload with only Supabase unreachable proves the board is drawn from the
    // snapshot with the stored overlay.
    const devDebugChannel = await friend.evaluate(
      () => typeof (self as unknown as { __next_r?: unknown }).__next_r === "string",
    );
    const supabase = publicSupabaseEnv();
    expect(supabase, "NEXT_PUBLIC_SUPABASE_URL").not.toBeNull();
    const supabaseRequests = `${new URL(supabase!.url).origin}/**`;
    // Dev only: Supabase stays unreachable from this page until the step lifts it.
    if (devDebugChannel) await friend.route(supabaseRequests, (route) => route.abort("internetdisconnected"));

    await friendContext.setOffline(true);
    await completeViaConfirm(friend, 5);
    const cell = friend.getByTestId("cell-5");
    await expect(cell).toHaveAttribute("data-completed", "true");
    await expect(cell).toHaveAttribute("data-pending", "true");
    await expect
      .poll(async () => JSON.stringify(await stored(friend, `bingo.pending.${gameId}`)))
      .toContain('"position":5');

    // Reload with no signal: the page comes from the service worker (the cached
    // game page, not its "you're offline" fallback), the board from the snapshot.
    const reload = await friend.reload();
    expect(reload?.fromServiceWorker(), "page served by the service worker").toBe(true);
    expect(reload?.status()).toBe(200);
    await expect(friend.getByText("the board will load as soon as you have signal")).toHaveCount(0);
    expect(new URL(friend.url()).pathname).toBe(`/game/${gameId}`);
    if (devDebugChannel) {
      // Dev only: let the page itself load (from the dev server), Supabase still unreachable.
      await friendContext.setOffline(false);
      await friend.reload();
    }
    await expect(friend.getByTestId("board-grid")).toBeVisible();
    await expect(friend.getByTestId("board-title")).toHaveText(gameName);
    await expect(cell).toHaveAttribute("data-completed", "true");
    await expect(cell).toHaveAttribute("data-pending", "true");
    await expect(friend.getByTestId("game-screen")).toHaveAttribute("data-sync-state", "offline");
    await expect(friend.getByTestId("sync-mark")).toHaveAttribute("data-pending-count", "1");
    await friend.waitForTimeout(2_000);
    await expect(cell).toHaveAttribute("data-pending", "true");
    await expect(host.getByTestId("cell-5")).toHaveAttribute("data-completed", "false");

    // Signal is back: the stored completion goes out.
    if (devDebugChannel) {
      await friend.unroute(supabaseRequests);
      await friendContext.setOffline(true);
    }
    await friendContext.setOffline(false);
    await expect(host.getByTestId("cell-5")).toHaveAttribute("data-completed", "true", { timeout: 5_000 });
    await expect(host.getByTestId("cell-5")).toHaveAttribute("data-completed-by", (await cell.getAttribute("data-completed-by"))!);
    await expect(cell).not.toHaveAttribute("data-pending", { timeout: 5_000 });
    await expect(cell).toHaveAttribute("data-completed", "true");
    await expect(friend.getByTestId("sync-mark")).toHaveCount(0, { timeout: 5_000 });
    await expect.poll(() => stored(friend, `bingo.pending.${gameId}`)).toBeNull();
  });

  await test.step("(d) Home on purpose from the board stays home, with Back to your game", async () => {
    const goHome = async () => {
      await friend.getByTestId("players-button").click();
      await expect(friend.getByTestId("players-sheet")).toBeVisible();
      await friend.getByTestId("board-home").click();
      await expect(friend).toHaveURL(/\/$/);
      await expect(friend.getByTestId("new-game")).toBeVisible();
      await expect(friend.getByTestId("back-to-game")).toContainText(gameName);
    };
    const backToGame = async () => {
      await friend.getByTestId("back-to-game").click();
      await expect(friend).toHaveURL(gameUrl);
      await expect(friend.getByTestId("board-grid")).toBeVisible();
      await expect(friend.getByTestId("cell-5")).toHaveAttribute("data-completed", "true");
      // The board comes back as it was left, minus the sheet that held the Home link.
      await expect(friend.getByTestId("players-sheet")).toHaveCount(0);
    };

    await goHome();
    await friend.waitForTimeout(1_500);
    await expect(friend).toHaveURL(/\/$/);
    await backToGame();

    // Still home after a reload in this tab (the deliberate visit is remembered per tab).
    await goHome();
    await friend.reload();
    await expect(friend.getByTestId("new-game")).toBeVisible();
    await expect(friend.getByTestId("back-to-game")).toBeVisible();
    await friend.waitForTimeout(1_000);
    await expect(friend).toHaveURL(/\/$/);
    await backToGame();
  });

  await test.step("(c) after the host ends the game, the next open lands on the recap once", async () => {
    await endGameFromSettings(host);
    await expect(friend.getByTestId("game-screen")).toHaveAttribute("data-status", "ended", LIVE);
    await expect(friend.getByTestId("recap-summary")).toBeVisible();
    await expect.poll(() => storedActiveGameId(friend)).toBeNull();
    expect(await stored(friend, "bingo.lastEnded")).toMatchObject({ gameId, consumed: false });

    const next = await friendContext.newPage();
    await next.goto("/");
    await expect(next).toHaveURL(gameUrl);
    await expect(next.getByTestId("recap-summary")).toBeVisible();
    await expect(next.getByTestId("game-screen")).toHaveAttribute("data-status", "ended");
    await expect.poll(async () => ((await stored(next, "bingo.lastEnded")) as { consumed?: boolean }).consumed).toBe(true);
    await next.close();

    const again = await friendContext.newPage();
    await again.goto("/");
    await expect(again.getByTestId("new-game")).toBeVisible();
    await again.waitForTimeout(1_500);
    await expect(again).toHaveURL(/\/$/);
    await expect(again.getByTestId("back-to-game")).toHaveCount(0);
    const row = again.getByTestId("game-row").filter({ hasText: gameName });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Ended");
    await again.close();
  });

  await close();
});
