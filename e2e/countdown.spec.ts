import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { START_COUNTDOWN_MS, rpcAs, rpcRawAs, selectAs, twoPhonesInLobby, waitForBoard } from "./helpers";

/**
 * The shared start countdown: after Start every phone counts down (5, 4, 3,
 * 2, 1) to the one `countdown_ends_at` the server stamped, and the board
 * appears on all of them at the same moment. Completions sent before then are
 * refused by the server (`countdown_in_progress`). A phone that opens the game
 * after the countdown goes straight to the board. The friend learns about the
 * start over the 1.5 s resync poll (no Realtime locally), well inside the 5 s.
 */

type Seen = { at: number; seconds: string | null; board: boolean; transition: boolean };
type Recorder = { __countdown?: Seen[] };

/**
 * Logs (wall clock, shared by both pages of this browser) every change of the
 * countdown number and when the board / start transition appear, from before
 * the first script runs, so nothing slips between two Playwright polls.
 */
async function recordCountdown(context: BrowserContext) {
  await context.addInitScript(() => {
    const w = window as Window & Recorder;
    const log: Seen[] = [];
    w.__countdown = log;
    let last = "";
    const check = () => {
      const seconds = document.querySelector('[data-testid="start-countdown"]')?.textContent ?? null;
      const board = !!document.querySelector('[data-testid="board-grid"]');
      const transition = !!document.querySelector('[data-testid="start-transition"]');
      const key = `${seconds}|${board}|${transition}`;
      if (key === last) return;
      last = key;
      log.push({ at: Date.now(), seconds, board, transition });
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true, characterData: true });
  });
}

const seen = (page: Page) => page.evaluate(() => (window as Window & Recorder).__countdown ?? []);

/** The number a phone showed at wall-clock time `t` (null: no countdown on screen then). */
function shownAt(log: Seen[], t: number): string | null {
  let current: string | null = null;
  for (const entry of log) {
    if (entry.at > t) break;
    current = entry.seconds;
  }
  return current;
}

/** When the board first appeared on this phone (ms, wall clock). */
function boardAt(log: Seen[]): number {
  const entry = log.find((e) => e.board);
  expect(entry, "board appeared").toBeTruthy();
  return entry!.at;
}

type GameRow = { status: string; started_at: string; countdown_ends_at: string | null };

test("both phones count down to the server's countdown_ends_at and reach the board together; early completions are refused", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const phones = await twoPhonesInLobby(browser, { prefix: "Countdown", prepare: recordCountdown });
  const { host, friend, hostContext, friendContext, gameId, close } = phones;

  await host.getByTestId("start-game").click();
  await expect(host.getByTestId("start-countdown")).toBeVisible();
  await expect(friend.getByTestId("start-countdown")).toBeVisible({ timeout: 4_000 });
  for (const page of [host, friend]) {
    await expect(page.getByTestId("game-screen")).toHaveAttribute("data-phase", "countdown");
    await expect(page.getByTestId("board-grid")).toHaveCount(0);
  }

  // The one server timestamp everyone counts down to: 5 seconds after the start.
  const [game] = await selectAs<GameRow>(hostContext, `games?id=eq.${gameId}&select=status,started_at,countdown_ends_at`);
  expect(game.status).toBe("active");
  expect(game.countdown_ends_at).not.toBeNull();
  const endsAt = Date.parse(game.countdown_ends_at!);
  expect(endsAt - Date.parse(game.started_at)).toBe(START_COUNTDOWN_MS);

  // During the countdown the server refuses completions, whoever sends them.
  for (const context of [friendContext, hostContext]) {
    const early = await rpcRawAs(context, "complete_square", { game_id: gameId, position: 0 });
    expect(early.status).toBe(400);
    expect(early.body.message).toBe("countdown_in_progress");
  }
  const earlyPlus = await rpcRawAs(friendContext, "increment_square", { game_id: gameId, position: 2, action_id: randomUUID() });
  expect(earlyPlus.body.message).toBe("countdown_in_progress");

  // Both phones at the same instant, away from a second boundary: the same number.
  await expect
    .poll(
      async () => {
        const left = endsAt - Date.now();
        if (left < 600) return "too late";
        if (left % 1000 < 250 || left % 1000 > 750) return "boundary";
        const [a, b] = await Promise.all([
          host.getByTestId("start-countdown").textContent(),
          friend.getByTestId("start-countdown").textContent(),
        ]);
        return a === b && /^[1-5]$/.test(a ?? "") ? "equal" : `host ${a} / friend ${b}`;
      },
      { timeout: 4_000, intervals: [50] },
    )
    .toBe("equal");

  for (const page of [host, friend]) await waitForBoard(page);
  const [hostLog, friendLog] = await Promise.all([seen(host), seen(friend)]);

  // Mid-second samples of what each phone showed: the same whole seconds left, on both.
  let compared = 0;
  for (let k = 5; k >= 1; k--) {
    const t = endsAt - k * 1000 + 500;
    const a = shownAt(hostLog, t);
    const b = shownAt(friendLog, t);
    if (a === null || b === null) continue; // the friend had not seen the start yet
    expect(a, `host at ${k} s left`).toBe(String(k));
    expect(b, `friend at ${k} s left`).toBe(String(k));
    compared += 1;
  }
  expect(compared, "seconds compared on both phones").toBeGreaterThanOrEqual(3);

  // The board appears on both at the server's moment, within ~300 ms of each other.
  const hostBoard = boardAt(hostLog);
  const friendBoard = boardAt(friendLog);
  test.info().annotations.push({ type: "board-gap-ms", description: String(Math.abs(hostBoard - friendBoard)) });
  expect(Math.abs(hostBoard - friendBoard), "board appeared apart (ms)").toBeLessThan(300);
  for (const at of [hostBoard, friendBoard]) {
    expect(at, "not before countdown_ends_at").toBeGreaterThanOrEqual(endsAt - 20);
    expect(at - endsAt, "soon after countdown_ends_at (ms)").toBeLessThan(600);
  }
  // Never a "0", and the start transition played over the board on both.
  for (const log of [hostLog, friendLog]) {
    expect(log.some((e) => e.seconds === "0")).toBe(false);
    expect(log.some((e) => e.transition)).toBe(true);
  }

  // Now completions go through.
  const done = await rpcAs<{ applied: boolean }>(friendContext, "complete_square", { game_id: gameId, position: 0 });
  expect(done.applied).toBe(true);
  await expect(host.getByTestId("cell-0")).toHaveAttribute("data-completed", "true", { timeout: 5_000 });

  // A phone that (re)opens the game after the countdown lands straight on the board.
  await friend.reload();
  await expect(friend.getByTestId("board-grid")).toBeVisible();
  await friend.waitForTimeout(1_500);
  const afterReload = await seen(friend);
  expect(afterReload.some((e) => e.seconds !== null), "no countdown after a reload").toBe(false);
  expect(afterReload.some((e) => e.transition), "no start transition after a reload").toBe(false);
  await expect(friend.getByTestId("cell-0")).toHaveAttribute("data-completed", "true");

  await close();
});
