import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { LIVE, expectPageFitsWidth, rpcAs, rpcRawAs, selectAs, twoPhonesInActiveGame } from "./helpers";

/**
 * Blackout ends the game: the completion of the 25th square ends it on the
 * server in the same transaction (`end_reason = 'blackout'`), the completer's
 * phone fetches the ended row at once, the other phone follows within the
 * resync poll, and both land on the recap. The recap's "Your squares" offers
 * Add photo/video on the viewer's own squares only, and a photo of someone
 * else's square still registers in the 10 minutes after the end (an upload
 * that was in flight at the blackout). The Night Out pack: the counter
 * "Collect 15 stranger signatures" is at position 2, the free center at 12.
 */

const COUNTER = 2;
const FRIEND_LAST = 23;
const HOST_LAST = 24;

type Result = { applied: boolean; completed_at: string | null; completed_by_player_id: string | null };
type GameRow = { status: string; end_reason: string | null; ended_at: string | null };
type PlayerRow = { id: string; display_name: string };

/** Tap Complete, then Confirm (the keyboard / reduced-motion path), once no celebration covers the board. */
async function completeViaConfirm(page: Page, position: number) {
  await expect(page.getByTestId("celebration")).toHaveCount(0, { timeout: 15_000 });
  await page.getByTestId(`cell-${position}`).click();
  await expect(page.getByTestId("square-sheet-body")).toHaveAttribute("data-position", String(position));
  await page.getByTestId("complete-hold").click();
  await page.getByTestId("complete-confirm").click();
  await expect(page.getByTestId("square-sheet")).toBeHidden();
}

async function yourSquares(page: Page): Promise<number[]> {
  const items = page.getByTestId("your-square");
  const positions = await items.evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-position"))));
  return positions.sort((a, b) => a - b);
}

test("blackout: the 25th square ends the game for both phones; the recap offers media for your own squares", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { host, friend, hostContext, friendContext, gameId, close } = await twoPhonesInActiveGame(browser, {
    prefix: "Blackout",
  });

  // 22 squares straight through the RPCs (the free center is the 23rd): the host
  // takes the even positions and the counter's 15 taps, the friend the odd ones.
  const open = Array.from({ length: 25 }, (_, p) => p).filter((p) => p !== 12 && p !== FRIEND_LAST && p !== HOST_LAST);
  const hostSquares = new Set<number>([COUNTER, HOST_LAST]);
  const friendSquares = new Set<number>([FRIEND_LAST]);
  for (let tap = 1; tap <= 15; tap++) {
    const row = await rpcAs<Result>(hostContext, "increment_square", { game_id: gameId, position: COUNTER, action_id: randomUUID() });
    expect(row.applied).toBe(true);
    expect(row.completed_at !== null).toBe(tap === 15);
  }
  for (const position of open) {
    if (position === COUNTER) continue;
    const mine = position % 2 === 0;
    (mine ? hostSquares : friendSquares).add(position);
    const row = await rpcAs<Result>(mine ? hostContext : friendContext, "complete_square", { game_id: gameId, position });
    expect(row.applied, `square ${position}`).toBe(true);
  }
  for (const page of [host, friend]) {
    await expect(page.getByTestId("board-progress")).toContainText("23 of 25 crossed off", { timeout: 10_000 });
  }
  const [live] = await selectAs<GameRow>(hostContext, `games?id=eq.${gameId}&select=status,end_reason,ended_at`);
  expect(live).toEqual({ status: "active", end_reason: null, ended_at: null });

  // The 24th on the friend's phone: still live.
  await completeViaConfirm(friend, FRIEND_LAST);
  await expect(host.getByTestId(`cell-${FRIEND_LAST}`)).toHaveAttribute("data-completed", "true", LIVE);
  await expect(host.getByTestId("game-screen")).toHaveAttribute("data-status", "active");

  // The 25th on the host's phone: the server ends the game; both phones reach the recap.
  await completeViaConfirm(host, HOST_LAST);
  await expect(host.getByTestId("recap-summary")).toBeVisible({ timeout: 5_000 });
  await expect(friend.getByTestId("recap-summary")).toBeVisible(LIVE);
  for (const page of [host, friend]) {
    await expect(page.getByTestId("game-screen")).toHaveAttribute("data-status", "ended");
    await expect(page.getByTestId("game-ended")).toHaveAttribute("data-end-reason", "blackout");
    await expect(page.getByTestId("board-grid")).toHaveCount(0);
    await expect(page.getByTestId("recap-count")).toHaveAttribute("data-count", "25");
    await expect(page.getByTestId("recap-lines")).toHaveText("Blackout: all 12 lines");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("bingo.activeGame")), { timeout: 5_000 }).toBeNull();
  }
  const [ended] = await selectAs<GameRow>(friendContext, `games?id=eq.${gameId}&select=status,end_reason,ended_at`);
  expect(ended.status).toBe("ended");
  expect(ended.end_reason).toBe("blackout");
  const [winner] = await selectAs<{ completed_at: string }>(hostContext, `squares?game_id=eq.${gameId}&position=eq.${HOST_LAST}&select=completed_at`);
  expect(Date.parse(ended.ended_at!)).toBe(Date.parse(winner.completed_at));

  // The board is final: no undo, no more completions.
  const undo = await rpcRawAs(hostContext, "undo_completion", { game_id: gameId, position: HOST_LAST });
  expect(undo.body.message).toBe("game_not_active");

  // "Your squares": Add photo/video on what each phone's player crossed off, nothing else.
  await expect(host.getByTestId("recap-your-squares")).toBeVisible();
  await expect(friend.getByTestId("recap-your-squares")).toBeVisible();
  expect(await yourSquares(host)).toEqual([...hostSquares].sort((a, b) => a - b));
  expect(await yourSquares(friend)).toEqual([...friendSquares].sort((a, b) => a - b));
  for (const page of [host, friend]) {
    const items = page.getByTestId("your-square");
    await expect(items.first().getByTestId("add-media")).toBeVisible();
    expect(await items.getByTestId("add-media").count()).toBe(await items.count());
    await expectPageFitsWidth(page, "recap with Your squares");
  }

  // A photo of the host's winning square, in flight on the friend's phone at the
  // blackout, still registers (within 10 minutes of the end) and reaches both recaps.
  // (Local Storage is a stub: the upload's register_media goes through rpcAs.)
  const [friendPlayer] = await selectAs<PlayerRow>(friendContext, `players?game_id=eq.${gameId}&display_name=eq.Friendo&select=id,display_name`);
  const media = await rpcAs<{ id: string; player_id: string }>(friendContext, "register_media", {
    game_id: gameId,
    position: HOST_LAST,
    storage_path: `${gameId}/${HOST_LAST}/${randomUUID()}.jpg`,
    kind: "photo",
  });
  expect(media.player_id).toBe(friendPlayer.id);
  for (const page of [host, friend]) {
    await expect(page.getByTestId("recap-watch")).toBeVisible({ timeout: 5_000 });
  }

  await close();
});
