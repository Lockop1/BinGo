import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  endGameFromSettings,
  joinPhone,
  rpcAs,
  selectAs,
  startGame,
  twoPhonesInActiveGame,
  twoPhonesInLobby,
  waitForBoard,
  waitForEndSequence,
} from "./helpers";

/**
 * The start and end moments (visual layer only): the pencil countdown over the
 * dimmed lobby shows the same digit on both phones at the same instant; a live
 * end plays once per phone over the recap (blackout: the marquee, then the
 * credits; host / deadline: the final buzzer, then the credits); opening an
 * ended game, or reloading mid-way or afterwards, shows the recap only; reduced
 * motion swaps it all for fades and static cards. The Night Out pack: the
 * counter "Collect 15 stranger signatures" is at position 2, the free center
 * at 12.
 */

const COUNTER = 2;
const LAST = 24;
/** What the recorder watches: a name → its selector (most are plain test ids). */
const WATCHED: Record<string, string> = {
  ...Object.fromEntries(
    ["start-countdown", "end-sequence", "blackout-sequence", "end-buzzer", "end-dark", "credits-card", "recap-summary"].map(
      (id) => [id, `[data-testid="${id}"]`],
    ),
  ),
  // The board's own "BLACKOUT!" overlay (bingo-line overlays are fine).
  "blackout-overlay": '[data-kind="blackout"] [data-testid="celebration-overlay"]',
};

type Seen = { at: number; present: string[] };
type Recorder = { __seen?: Seen[]; __buzz?: unknown[] };

/**
 * Logs (from before the first script runs) which of the watched screens are on
 * the page whenever that changes, and every `navigator.vibrate` call.
 */
async function record(context: BrowserContext) {
  await context.addInitScript((watched: Record<string, string>) => {
    const w = window as Window & Recorder;
    const log: Seen[] = [];
    w.__seen = log;
    w.__buzz = [];
    try {
      Object.defineProperty(Navigator.prototype, "vibrate", {
        configurable: true,
        value: (pattern: unknown) => {
          w.__buzz!.push(pattern);
          return true;
        },
      });
    } catch {
      // No vibrate stub: the buzz count just stays empty.
    }
    let last = "";
    const check = () => {
      const present = Object.keys(watched).filter((name) => document.querySelector(watched[name]));
      const key = present.join(",");
      if (key === last) return;
      last = key;
      log.push({ at: Date.now(), present });
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true });
  }, WATCHED);
}

const seen = (page: Page) => page.evaluate(() => (window as Window & Recorder).__seen ?? []);
const everSeen = async (page: Page, id: string) => (await seen(page)).some((e) => e.present.includes(id));
const endSeen = (page: Page, gameId: string) => page.evaluate((id) => localStorage.getItem(`bingo.endSeen.${id}`), gameId);

type Result = { applied: boolean; completed_at: string | null };

/** Everything but `LAST` straight through the RPCs: the counter's 15 taps by the host, the rest shared. */
async function fillAllButLast(host: BrowserContext, friend: BrowserContext, gameId: string) {
  for (let tap = 1; tap <= 15; tap++) {
    await rpcAs<Result>(host, "increment_square", { game_id: gameId, position: COUNTER, action_id: randomUUID() });
  }
  for (let position = 0; position < 25; position++) {
    if (position === 12 || position === COUNTER || position === LAST) continue;
    const row = await rpcAs<Result>(position % 2 === 0 ? host : friend, "complete_square", { game_id: gameId, position });
    expect(row.applied, `square ${position}`).toBe(true);
  }
}

/** Tap Complete, then Confirm (the keyboard / reduced-motion path), once no celebration covers the board. */
async function completeViaConfirm(page: Page, position: number) {
  await expect(page.getByTestId("celebration")).toHaveCount(0, { timeout: 15_000 });
  await page.getByTestId(`cell-${position}`).click();
  await expect(page.getByTestId("square-sheet-body")).toHaveAttribute("data-position", String(position));
  await page.getByTestId("complete-hold").click();
  await page.getByTestId("complete-confirm").click();
}

test("countdown: both phones show the same pencil digit at the same instant, over the dimmed lobby", async ({ browser }) => {
  test.setTimeout(90_000);
  const phones = await twoPhonesInLobby(browser, { prefix: "Digits", prepare: record });
  const { host, friend, hostContext, gameId, close } = phones;

  await host.getByTestId("start-game").click();
  await expect(host.getByTestId("start-countdown")).toBeVisible();
  await expect(friend.getByTestId("start-countdown")).toBeVisible({ timeout: 4_000 });
  const [game] = await selectAs<{ countdown_ends_at: string }>(hostContext, `games?id=eq.${gameId}&select=countdown_ends_at`);
  const endsAt = Date.parse(game.countdown_ends_at);

  // The lobby stays underneath, dimmed and frozen.
  for (const page of [host, friend]) {
    await expect(page.getByTestId("lobby")).toBeAttached();
    const under = page.getByTestId("lobby").locator("xpath=..");
    await expect(under).toHaveAttribute("inert", "");
    expect(Number(await under.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(0.5);
  }

  // Three mid-second instants still ahead: both phones, sampled together, show the same digit.
  const now = Date.now();
  const instants = [5, 4, 3, 2, 1].map((k) => ({ k, at: endsAt - k * 1000 + 500 })).filter((s) => s.at > now + 100);
  expect(instants.length, "mid-second instants left").toBeGreaterThanOrEqual(3);
  for (const { k, at } of instants.slice(0, 3)) {
    await host.waitForTimeout(Math.max(0, at - Date.now()));
    const [a, b] = await Promise.all([
      host.getByTestId("start-countdown").getAttribute("data-digit"),
      friend.getByTestId("start-countdown").getAttribute("data-digit"),
    ]);
    expect(`${a}/${b}`, `${k} s left`).toBe(`${k}/${k}`);
    await expect(host.getByTestId("start-countdown")).toHaveText(String(k));
  }

  // At zero: the start transition, then the board; each digit buzzed.
  for (const page of [host, friend]) {
    await expect(page.getByTestId("board-grid")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("start-countdown")).toHaveCount(0);
  }
  const buzzes = await host.evaluate(() => (window as Window & Recorder).__buzz?.length ?? 0);
  expect(buzzes, "pulse per digit (and the start)").toBeGreaterThanOrEqual(5);

  await close();
});

test("blackout: the marquee, then the credits, then the recap; once per phone", async ({ browser }) => {
  test.setTimeout(150_000);
  const { host, friend, hostContext, friendContext, gameId, gameName, close } = await twoPhonesInActiveGame(browser, {
    prefix: "Marquee",
    prepare: record,
  });
  await fillAllButLast(hostContext, friendContext, gameId);
  for (const page of [host, friend]) {
    await expect(page.getByTestId("board-progress")).toContainText("24 of 25 crossed off", { timeout: 10_000 });
  }

  // The 25th through the UI: the server ends the game, both phones play the blackout.
  await completeViaConfirm(host, LAST);
  for (const page of [host, friend]) {
    await expect(page.getByTestId("blackout-sequence")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("end-sequence")).toHaveAttribute("data-variant", "blackout");
    expect(await page.locator('[data-testid="blackout-sequence"] [data-animated="true"]').count()).toBeGreaterThan(16);
    await expect(page.getByTestId("game-ended")).toHaveAttribute("data-end-reason", "blackout");
  }
  for (const page of [host, friend]) {
    const credits = page.getByTestId("credits-card");
    await expect(credits).toBeVisible({ timeout: 8_000 });
    await expect(credits.getByTestId("credits-name")).toHaveText(gameName);
    await expect(credits.getByTestId("credits-player")).toHaveText(["Hosty", "Friendo"]);
    await expect(credits.getByTestId("credits-squares")).toHaveText("25/25");
    // No "BLACKOUT!" overlay from the board's own celebration on top of it.
    expect(await everSeen(page, "blackout-overlay"), "no board BLACKOUT! overlay").toBe(false);
  }

  // A reload during the credits lands on the recap.
  await friend.reload();
  await expect(friend.getByTestId("recap-summary")).toBeVisible();
  await friend.waitForTimeout(1_500);
  expect(await everSeen(friend, "end-sequence"), "no sequence after a reload mid-way").toBe(false);

  // The host's sequence finishes by itself on the recap; it never plays again.
  await waitForEndSequence(host, { timeout: 8_000, skip: false });
  await expect(host.getByTestId("recap-summary")).toBeVisible();
  expect(await endSeen(host, gameId)).toBe('"blackout"');
  await host.reload();
  await expect(host.getByTestId("recap-summary")).toBeVisible();
  await host.waitForTimeout(1_500);
  expect(await everSeen(host, "end-sequence"), "no sequence after it played").toBe(false);

  await close();
});

test("host end: the buzzer, the credits, the recap within ~5 s; a phone opening the ended game sees only the recap", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const phones = await twoPhonesInLobby(browser, { prefix: "Buzzer", prepare: record });
  const { host, friend, code, gameId, close } = phones;
  await startGame(phones);
  // A third player joins late, then puts the phone away.
  const third = await joinPhone(browser, code, "Thirdy");
  await expect(third.page.getByTestId("board-grid")).toBeVisible();
  await third.page.close();

  await endGameFromSettings(host);
  const ended = Date.now();
  await expect(host.getByTestId("end-buzzer")).toBeVisible({ timeout: 3_000 });
  await expect(host.getByTestId("end-sequence")).toHaveAttribute("data-variant", "buzzer");
  await expect(host.getByTestId("credits-card")).toBeVisible({ timeout: 3_000 });
  await expect(host.getByTestId("credits-player")).toHaveText(["Hosty", "Friendo", "Thirdy"]);
  await waitForEndSequence(host, { timeout: 6_000, skip: false });
  expect(Date.now() - ended, "recap within ~5 s").toBeLessThan(5_500);
  await expect(host.getByTestId("recap-summary")).toBeVisible();
  await expect(host.getByTestId("game-ended")).toHaveAttribute("data-end-reason", "host");
  expect(await endSeen(host, gameId)).toBe('"buzzer"');

  // The friend learns of the end over the poll and gets the same moment.
  await expect.poll(() => everSeen(friend, "end-buzzer"), { timeout: 4_000 }).toBe(true);
  await waitForEndSequence(friend, { skip: false });
  await expect(friend.getByTestId("recap-summary")).toBeVisible();
  expect(await everSeen(friend, "credits-card"), "friend: credits").toBe(true);

  // The third phone opens the game after the end: the recap only.
  await record(third.context);
  const reopened = await third.context.newPage();
  await reopened.goto(host.url());
  await expect(reopened.getByTestId("recap-summary")).toBeVisible();
  await reopened.waitForTimeout(1_500);
  expect(await everSeen(reopened, "end-sequence"), "no sequence on a phone that was not watching").toBe(false);
  await third.context.close();

  await close();
});

test("reduced motion: fading digits, a static BLACKOUT card and static credits; Skip goes to the recap", async ({ browser }) => {
  test.setTimeout(150_000);
  const phones = await twoPhonesInLobby(browser, {
    prefix: "Still",
    prepare: record,
    host: { reducedMotion: "reduce" },
    friend: { reducedMotion: "reduce" },
  });
  const { host, friend, hostContext, friendContext, gameId, close } = phones;
  await host.getByTestId("start-game").click();
  await expect(host.getByTestId("start-countdown")).toHaveAttribute("data-reduced", "true");
  for (const page of [host, friend]) await waitForBoard(page);

  await fillAllButLast(hostContext, friendContext, gameId);
  await expect(host.getByTestId("board-progress")).toContainText("24 of 25 crossed off", { timeout: 10_000 });
  await completeViaConfirm(host, LAST);

  const card = host.getByTestId("blackout-sequence");
  await expect(card).toBeVisible({ timeout: 5_000 });
  await expect(card).toHaveAttribute("data-reduced", "true");
  await expect(card).toContainText("BLACKOUT");
  await expect(host.getByTestId("end-sequence")).toHaveAttribute("data-reduced", "true");
  expect(await host.locator('[data-testid="end-sequence"] [data-animated]').count(), "no chasing bulbs").toBe(0);

  const credits = host.getByTestId("credits-card");
  await expect(credits).toBeVisible({ timeout: 5_000 });
  await expect(credits).toHaveAttribute("data-reduced", "true");
  await expect(credits.getByTestId("credits-squares")).toHaveText("25/25");
  const skip = credits.getByTestId("credits-skip");
  const box = await skip.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThanOrEqual(44);
  await skip.click();
  await expect(host.getByTestId("end-sequence")).toHaveCount(0, { timeout: 1_000 });
  await expect(host.getByTestId("recap-summary")).toBeVisible();
  await host.getByTestId("back-home").scrollIntoViewIfNeeded();
  await expect(host.getByTestId("back-home")).toBeVisible();

  // The friend's phone, reduced too, Skips from wherever it is.
  await waitForEndSequence(friend);
  await expect(friend.getByTestId("recap-summary")).toBeVisible();

  await close();
});
