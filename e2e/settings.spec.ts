import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { LIVE, expectFitsWidth, twoPhonesInActiveGame, twoPhonesInLobby } from "./helpers";

/**
 * Board settings (theme, text size, square size) and the start transition.
 * Settings are per phone (localStorage `bingo.settings`); the theme follows
 * the phone's color scheme until one is picked.
 */

type Seen = { present: boolean; at: number; visible: boolean; variant: string | null };
type Recorder = { __startTransitions?: Seen[] };

/**
 * Records every appearance / disappearance of the start-transition overlay
 * (a MutationObserver from before the first script runs), so a ~1 s overlay
 * on a phone that only learns about the start via the poll cannot slip
 * between two Playwright polls.
 */
async function recordTransitions(context: BrowserContext) {
  await context.addInitScript(() => {
    const w = window as Window & Recorder;
    const log: Seen[] = [];
    w.__startTransitions = log;
    let present = false;
    const check = () => {
      const el = document.querySelector<HTMLElement>('[data-testid="start-transition"]');
      if (!!el === present) return;
      present = !!el;
      const box = el?.getBoundingClientRect();
      log.push({
        present,
        at: performance.now(),
        visible: !!el && !!box && box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== "hidden",
        variant: el?.getAttribute("data-variant") ?? null,
      });
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true });
  });
}

const transitions = (page: Page) => page.evaluate(() => (window as Window & Recorder).__startTransitions ?? []);

const board = (page: Page) => page.getByTestId("game-screen");

test("theme follows the phone; the start transition plays on both phones, not after a reload", async ({ browser }) => {
  test.setTimeout(120_000);
  const phones = await twoPhonesInLobby(browser, {
    prefix: "Start",
    host: { colorScheme: "dark" },
    friend: { colorScheme: "light" },
    prepare: recordTransitions,
  });
  const { host, friend } = phones;

  await host.getByTestId("start-game").click();
  // The host's own start: the overlay is up at once and gone within ~2.5 s.
  await expect(host.getByTestId("start-transition")).toBeVisible();
  await expect(host.getByTestId("start-transition")).toHaveCount(0, { timeout: 2_500 });
  await expect(board(friend)).toHaveAttribute("data-status", "active", { timeout: 5_000 });

  // The friend learns about the start over the poll and plays it too.
  for (const page of [host, friend]) {
    await expect.poll(async () => (await transitions(page)).length, { timeout: 10_000 }).toBe(2);
    const [shown, gone] = await transitions(page);
    expect(shown.present && shown.visible, "overlay shown").toBe(true);
    expect(gone.present).toBe(false);
    expect(gone.at - shown.at, "overlay duration (ms)").toBeLessThan(2_500);
    await expect(board(page)).toHaveAttribute("data-status", "active");
  }
  expect((await transitions(host))[0].variant).toBe("scoreboard");
  expect((await transitions(friend))[0].variant).toBe("whiteboard");

  // Theme from the phone: dark → Dark Scoreboard, light → Whiteboard.
  await expect(board(host)).toHaveAttribute("data-theme", "scoreboard");
  await expect(board(friend)).toHaveAttribute("data-theme", "whiteboard");
  // ...and it follows the phone changing its mind.
  await friend.emulateMedia({ colorScheme: "dark" });
  await expect(board(friend)).toHaveAttribute("data-theme", "scoreboard");
  await friend.emulateMedia({ colorScheme: "light" });
  await expect(board(friend)).toHaveAttribute("data-theme", "whiteboard");

  // A phone that opens the game once it is already active never sees the transition.
  await friend.reload();
  await expect(friend.getByTestId("board-grid")).toBeVisible();
  await friend.waitForTimeout(2_500);
  expect(await transitions(friend)).toEqual([]);
  await expect(friend.getByTestId("start-transition")).toHaveCount(0);

  await phones.close();
});

const THEMES = ["scoreboard", "whiteboard"] as const;
const TEXT_SIZES = ["normal", "large", "xlarge"] as const;
const SQUARE_SIZES = ["normal", "tall"] as const;
const RATIO = { normal: 1, tall: 1.35 } as const;

/** Write settings as another tab would (storage event), then wait for the board to apply them. */
async function applySettings(
  page: Page,
  settings: { theme: (typeof THEMES)[number] | null; textSize: string; squareSize: (typeof SQUARE_SIZES)[number] },
) {
  await page.evaluate((value) => {
    localStorage.setItem("bingo.settings", JSON.stringify(value));
    window.dispatchEvent(new StorageEvent("storage", { key: "bingo.settings" }));
  }, settings);
  if (settings.theme) await expect(board(page)).toHaveAttribute("data-theme", settings.theme);
  await expect(board(page)).toHaveAttribute("data-text-size", settings.textSize);
  await expect(board(page)).toHaveAttribute("data-square-size", settings.squareSize);
}

test("every setting combination fits 320 and 375 px; settings persist across a reload", async ({ browser }) => {
  test.setTimeout(150_000);
  const phones = await twoPhonesInActiveGame(browser, {
    prefix: "Settings",
    host: { reducedMotion: "reduce" },
    prepare: recordTransitions,
  });
  const { host } = phones;

  // Reduced motion: the start is a short cross-fade only.
  await expect.poll(async () => (await transitions(host)).length, { timeout: 5_000 }).toBe(2);
  const [shown, gone] = await transitions(host);
  expect(shown.variant).toBe("fade");
  expect(gone.at - shown.at, "reduced-motion transition (ms)").toBeLessThan(1_000);

  for (const width of [320, 375]) {
    await host.setViewportSize({ width, height: 700 });
    for (const theme of THEMES) {
      for (const textSize of TEXT_SIZES) {
        for (const squareSize of SQUARE_SIZES) {
          const label = `${theme}/${textSize}/${squareSize} at ${width}px`;
          await applySettings(host, { theme, textSize, squareSize });
          await expectFitsWidth(host, label);
          const cell = (await host.getByTestId("cell-7").boundingBox())!;
          expect(cell.height / cell.width, `cell ratio ${label}`).toBeCloseTo(RATIO[squareSize], 1);
          // No label pushes its square wider than the column.
          const overflowing = await host
            .getByTestId("board-grid")
            .locator("button[data-position]")
            .evaluateAll((cells) => cells.filter((c) => c.scrollWidth > c.clientWidth + 1).length);
          expect(overflowing, `cells overflowing ${label}`).toBe(0);
        }
      }
    }
  }

  // --- The sheet: phone default pre-selected, changes apply behind it at once.
  await applySettings(host, { theme: null, textSize: "normal", squareSize: "normal" });
  await host.setViewportSize({ width: 375, height: 812 });
  await expect(board(host)).toHaveAttribute("data-theme", "whiteboard");
  await host.getByTestId("settings-button").click();
  const sheet = host.getByTestId("settings-sheet");
  await expect(sheet).toBeVisible();
  const whiteboard = host.getByTestId("settings-theme-whiteboard");
  const scoreboard = host.getByTestId("settings-theme-scoreboard");
  await expect(whiteboard).toHaveAttribute("aria-checked", "true");
  await expect(whiteboard).toContainText("(phone default)");
  await expect(scoreboard).not.toContainText("(phone default)");
  await expect(host.getByTestId("settings-follow-system")).toHaveCount(0);
  for (const option of await sheet.locator('[role="radio"]').all()) {
    const box = (await option.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
  }

  await scoreboard.click();
  await expect(scoreboard).toHaveAttribute("aria-checked", "true");
  await expect(board(host)).toHaveAttribute("data-theme", "scoreboard");
  await expect(host.getByTestId("settings-follow-system")).toBeVisible();
  await host.getByTestId("settings-text-xlarge").click();
  await expect(board(host)).toHaveAttribute("data-text-size", "xlarge");
  await host.getByTestId("settings-square-tall").click();
  await expect(board(host)).toHaveAttribute("data-square-size", "tall");
  await expectFitsWidth(host, "after picking in the sheet");
  await host.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  // --- Persisted on this phone only.
  expect(JSON.parse((await host.evaluate(() => localStorage.getItem("bingo.settings")))!)).toEqual({
    theme: "scoreboard",
    textSize: "xlarge",
    squareSize: "tall",
  });
  await host.reload();
  await expect(host.getByTestId("board-grid")).toBeVisible();
  await expect(board(host)).toHaveAttribute("data-theme", "scoreboard");
  await expect(board(host)).toHaveAttribute("data-text-size", "xlarge");
  await expect(board(host)).toHaveAttribute("data-square-size", "tall");
  await expect(board(phones.friend)).toHaveAttribute("data-theme", "whiteboard");
  await expect(board(phones.friend)).toHaveAttribute("data-text-size", "normal", LIVE);

  // "Follow phone setting" unpins the theme.
  await host.getByTestId("settings-button").click();
  await host.getByTestId("settings-follow-system").click();
  await expect(board(host)).toHaveAttribute("data-theme", "whiteboard");
  await expect(host.getByTestId("settings-follow-system")).toHaveCount(0);
  await expect(host.getByTestId("settings-theme-whiteboard")).toHaveAttribute("aria-checked", "true");
  expect(JSON.parse((await host.evaluate(() => localStorage.getItem("bingo.settings")))!).theme).toBeNull();

  await phones.close();
});
