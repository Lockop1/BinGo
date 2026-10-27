import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  LIVE,
  expectFitsWidth,
  openSettings,
  rpcRawAs,
  selectAs,
  setDeadlineViaDb,
  startGame,
  twoPhonesInLobby,
} from "./helpers";

/**
 * The host-set deadline end to end, on two phones: picked at creation,
 * changed in the lobby (live on the other phone), the "Passed" lock, the quiet
 * countdown on the board, the single "1 hour left." toast, the one extension,
 * and the game ending for everyone at the deadline. Cross-phone changes ride
 * the 1.5 s resync poll (the local backend has no Realtime). "Passed" and
 * "about to pass" deadlines are set straight in the local database
 * (`setDeadlineViaDb`), since the RPCs refuse them.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;
const HOUR_TOAST = "1 hour left.";

type DeadlineRow = { deadline_at: string; deadline_extended_at: string | null };

/** Counts every "1 hour left." toast this page load shows (`window.__hourToasts`). */
async function countHourToasts(context: BrowserContext) {
  await context.addInitScript((text: string) => {
    const w = window as unknown as { __hourToasts: number };
    w.__hourToasts = 0;
    const seen = new WeakSet<Element>();
    new MutationObserver(() => {
      document.querySelectorAll('[data-testid="toast"]').forEach((el) => {
        if (!seen.has(el) && el.textContent?.includes(text)) {
          seen.add(el);
          w.__hourToasts += 1;
        }
      });
    }).observe(document, { childList: true, subtree: true, characterData: true });
  }, HOUR_TOAST);
}

const hourToasts = (page: Page) => page.evaluate(() => (window as unknown as { __hourToasts: number }).__hourToasts);

/** `YYYY-MM-DDTHH:mm` for a datetime-local input, on the phone's own clock and zone. */
const localInput = (page: Page, ms: number) =>
  page.evaluate((t) => {
    const d = new Date(t);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }, ms);

/** The host opens the lobby deadline sheet, picks Custom `minutes` from now and saves. */
async function changeDeadline(host: Page, minutes: number) {
  await host.getByTestId("lobby-deadline-change").click();
  const sheet = host.getByTestId("deadline-sheet");
  await expect(sheet).toBeVisible();
  await sheet.getByTestId("deadline-option-custom").click();
  // The input keeps whole minutes (dropping seconds): aim just under a minute later so at least `minutes` remain.
  await sheet.getByTestId("deadline-custom-input").fill(await localInput(host, Date.now() + minutes * MINUTE + 50_000));
  await expect(sheet.getByTestId("deadline-custom-message")).toHaveAttribute("data-state", "ok");
  await sheet.getByTestId("deadline-save").click();
  await expect(sheet).toBeHidden();
}

test("deadline: picked at creation, changed in the lobby, counted down, warned once, extended once, ends for everyone", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const phones = await twoPhonesInLobby(browser, { prefix: "Deadline", deadline: "day", prepare: countHourToasts });
  const { host, friend, hostContext, gameId, close } = phones;

  // (a) "24 hours" at creation: stored ~now + 24 h, shown in both lobbies.
  const [created] = await selectAs<DeadlineRow>(hostContext, `games?id=eq.${gameId}&select=deadline_at,deadline_extended_at`);
  expect(Math.abs(Date.parse(created.deadline_at) - (Date.now() + DAY))).toBeLessThan(2 * MINUTE);
  expect(created.deadline_extended_at).toBeNull();
  for (const page of [host, friend]) {
    await expect(page.getByTestId("lobby-deadline")).toContainText(/^Ends .+ · 23h 5\dm/);
  }

  // (b) Only the host can change it; the friend's line follows within the poll.
  await expect(friend.getByTestId("lobby-deadline-change")).toHaveCount(0);
  await changeDeadline(host, 40);
  await expect(host.getByTestId("lobby-deadline")).toContainText(/ · (3[89]|40)m/);
  await expect(friend.getByTestId("lobby-deadline")).toContainText(/ · (3[89]|40)m/, LIVE);

  // (c) A passed deadline locks Start until the host picks a new one.
  setDeadlineViaDb(gameId, new Date(Date.now() - MINUTE).toISOString());
  for (const page of [host, friend]) {
    await expect(page.getByTestId("lobby-deadline").getByTestId("deadline-summary")).toHaveText("Passed", LIVE);
  }
  await expect(host.getByTestId("start-game")).toBeDisabled();
  await expect(host.getByTestId("lobby-status")).toHaveText("Pick a new deadline first");
  await expect(friend.getByTestId("lobby-status")).toHaveText("Waiting for Hosty to set a new deadline");
  await changeDeadline(host, 45);
  for (const page of [host, friend]) {
    await expect(page.getByTestId("lobby-deadline")).toContainText(/ · 4[345]m/, LIVE);
  }
  await expect(host.getByTestId("start-game")).toBeEnabled(LIVE);
  await startGame(phones);

  // (d) A quiet countdown right after the board title, on both phones; the board still fits.
  for (const page of [host, friend]) {
    const countdown = page.getByTestId("deadline-countdown");
    await expect(countdown).toHaveText(/^4[2345]m$/);
    const title = (await page.getByTestId("board-title").boundingBox())!;
    const box = (await countdown.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(title.x + title.width - 1);
    expect(box.x - (title.x + title.width)).toBeLessThan(12);
    expect(Math.abs(box.y + box.height / 2 - (title.y + title.height / 2))).toBeLessThan(8);
    await expectFitsWidth(page, "at 375px with the countdown");
  }
  await friend.setViewportSize({ width: 320, height: 640 });
  await expect(friend.getByTestId("deadline-countdown")).toBeVisible();
  await expectFitsWidth(friend, "at 320px with the countdown");
  await friend.setViewportSize({ width: 375, height: 812 });

  // (e) Under an hour already: "1 hour left." exactly once per phone, remembered across a reload.
  for (const page of [host, friend]) {
    await expect.poll(() => hourToasts(page), { timeout: 5_000 }).toBe(1);
    await expect(page.getByTestId("toast")).toHaveCount(0, { timeout: 5_000 });
    expect(await page.evaluate((id) => localStorage.getItem(`bingo.deadlineToast.${id}`), gameId)).not.toBeNull();
  }
  await host.waitForTimeout(2_000);
  for (const page of [host, friend]) expect(await hourToasts(page)).toBe(1);
  for (const page of [host, friend]) {
    await page.reload();
    await expect(page.getByTestId("board-grid")).toBeVisible();
    await expect(page.getByTestId("deadline-countdown")).toBeVisible();
  }
  await host.waitForTimeout(3_000);
  for (const page of [host, friend]) expect(await hourToasts(page)).toBe(0);

  // (f) The host extends once by +1 hour (Settings → Host): both countdowns move; no second extension.
  await expect(friend.getByTestId("players-button")).toBeVisible();
  await openSettings(host);
  await host.getByTestId("extend-deadline").click();
  const extend = host.getByTestId("extend-sheet");
  await expect(extend).toBeVisible();
  await extend.getByTestId("extend-option-1h").click();
  await extend.getByTestId("extend-save").click();
  await expect(extend).toBeHidden();
  for (const page of [host, friend]) {
    await expect(page.getByTestId("deadline-countdown")).toHaveText(/^1h 4[2345]m$/, LIVE);
  }
  await openSettings(host);
  await expect(host.getByTestId("deadline-extended")).toHaveText("Deadline extended once", LIVE);
  await expect(host.getByTestId("extend-deadline")).toHaveCount(0);
  await expect(host.getByTestId("settings-auto-end")).toContainText(/^Ends .+ \(1h 4[2345]m\)$/);
  await host.keyboard.press("Escape");
  await expect(host.getByTestId("settings-sheet")).toBeHidden();
  await host.getByTestId("players-button").click();
  await expect(host.getByTestId("auto-end")).toContainText(/^Ends .+ \(1h 4[2345]m\)$/);
  await host.keyboard.press("Escape");
  await friend.getByTestId("players-button").click();
  await expect(friend.getByTestId("players-sheet")).toBeVisible();
  await expect(friend.getByTestId("auto-end")).toContainText(/\(1h 4[2345]m\)$/);
  await expect(friend.getByTestId("extend-deadline")).toHaveCount(0);
  await expect(friend.getByTestId("end-game")).toHaveCount(0);
  await friend.keyboard.press("Escape");
  const [extended] = await selectAs<DeadlineRow>(hostContext, `games?id=eq.${gameId}&select=deadline_at,deadline_extended_at`);
  expect(extended.deadline_extended_at).not.toBeNull();
  const again = await rpcRawAs(hostContext, "extend_deadline", {
    game_id: gameId,
    deadline_at: new Date(Date.parse(extended.deadline_at) + 30 * MINUTE).toISOString(),
  });
  expect(again.status).toBe(400);
  expect(again.body.message).toBe("already_extended");
  for (const page of [host, friend]) expect(await hourToasts(page)).toBe(0);

  // (g) At the deadline the game ends for everyone: the recap, and the instant-return record is gone.
  setDeadlineViaDb(gameId, new Date(Date.now() + 20_000).toISOString());
  for (const page of [host, friend]) {
    await expect(page.getByTestId("deadline-countdown")).toHaveText(/^<1m$/, LIVE);
  }
  for (const page of [host, friend]) {
    await expect(page.getByTestId("recap-summary")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("game-screen")).toHaveAttribute("data-status", "ended");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("bingo.activeGame")), { timeout: 5_000 }).toBeNull();
  }

  await close();
});

test("a stale games read after the host's extension never brings back the old deadline or the Extend button", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const phones = await twoPhonesInLobby(browser, { prefix: "Stale", deadline: "day" });
  await startGame(phones);
  const { host, close } = phones;
  await expect(host.getByTestId("deadline-countdown")).toHaveText(/^23h 5\dm$/);

  // From the moment the host taps Save, every `games` read the host's phone
  // makes answers late with the row as it was before the extension (a slow bar
  // connection, or a read that predates the commit): the resync poll keeps
  // fetching it while the RPC result already shows the new deadline. Squares,
  // players and media still come back fresh.
  let before: { status: number; headers: Record<string, string>; body: Buffer } | null = null;
  let replay = false;
  let replayed = 0;
  await host.route(/\/rest\/v1\/games\?/, async (route) => {
    if (replay && before) {
      replayed += 1;
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.fulfill(before).catch(() => {});
      return;
    }
    const response = await route.fetch();
    const body = await response.body();
    if (!replay) before = { status: response.status(), headers: response.headers(), body };
    await route.fulfill({ response, body });
  });
  await expect.poll(() => before !== null, { timeout: 5_000 }).toBe(true);

  await openSettings(host);
  await host.getByTestId("extend-deadline").click();
  const extend = host.getByTestId("extend-sheet");
  await extend.getByTestId("extend-option-1h").click();
  replay = true;
  await extend.getByTestId("extend-save").click();
  await expect(extend).toBeHidden();
  // 24 h 5x m left: "1d" from here on.
  await expect(host.getByTestId("deadline-countdown")).toHaveText(/^1d$/, LIVE);
  await openSettings(host);
  await expect(host.getByTestId("deadline-extended")).toHaveText("Deadline extended once", LIVE);

  // Several polls bring the pre-extension row; none of them may undo what the phone has shown.
  const seen = new Set<string>();
  const until = Date.now() + 6_000;
  while (Date.now() < until) {
    seen.add(`${await host.getByTestId("deadline-countdown").textContent()}|extend=${await host.getByTestId("extend-deadline").count()}`);
    await host.waitForTimeout(100);
  }
  expect(replayed, "stale games reads served").toBeGreaterThanOrEqual(3);
  expect([...seen]).toEqual(["1d|extend=0"]);
  await expect(host.getByTestId("deadline-extended")).toBeVisible();

  // Fresh reads again: still the extension.
  replay = false;
  await host.waitForTimeout(2_000);
  await expect(host.getByTestId("deadline-countdown")).toHaveText(/^1d$/);
  await expect(host.getByTestId("extend-deadline")).toHaveCount(0);
  await close();
});

test("create form: a preset that drifts under 10 minutes moves on with a notice, and Create is never disabled without a reason", async ({
  browser,
}) => {
  test.setTimeout(90_000);

  /** One look at the deadline part of the form. */
  const look = async (page: Page, preset: string) => ({
    row: (await page.getByTestId(`deadline-option-${preset}`).getByTestId("deadline-resolved").textContent())?.replace(/\s+/g, " "),
    notice: (await page.getByTestId("deadline-refresh-notice").count()) ? await page.getByTestId("deadline-refresh-notice").textContent() : null,
    problem: (await page.getByTestId("create-deadline-problem").count()) ? await page.getByTestId("create-deadline-problem").textContent() : null,
    createEnabled: await page.getByTestId("create-game").isEnabled(),
  });

  /** A New York phone whose clock reads `iso`, on the create form with a name typed in. */
  const formAt = async (iso: string) => {
    const context = await browser.newContext({ timezoneId: "America/New_York" });
    await context.clock.install({ time: new Date(iso) });
    const page = await context.newPage();
    await page.goto("/new");
    await page.waitForLoadState("networkidle");
    await page.getByTestId("game-name").fill("E2E Drift");
    await page.getByTestId("host-name").fill("Hosty");
    return { context, page };
  };

  // (a) Tonight picked at 02:49:40 (the verifier's run): 3:00 AM is 10m 20s away.
  {
    const { context, page } = await formAt("2026-10-20T06:49:40Z"); // Tue 02:49:40 EDT
    await expect(page.getByTestId("deadline-picker")).toHaveAttribute("data-selected", "tonight");
    expect(await look(page, "tonight")).toEqual({ row: "Tonight 3:00 AM", notice: null, problem: null, createEnabled: true });
    // Step through 02:50:00 a second at a time: Create is enabled, or a line says why not.
    for (let i = 0; i < 30; i++) {
      await page.clock.runFor(1_000);
      const seen = await look(page, "tonight");
      expect(seen.createEnabled || seen.problem !== null, `at +${i + 1}s: ${JSON.stringify(seen)}`).toBe(true);
    }
    expect(await look(page, "tonight")).toEqual({
      row: "Tomorrow 3:00 AM",
      notice: "Updated to the next 3 AM — the earlier time is less than 10 minutes away",
      problem: null,
      createEnabled: true,
    });
    await expect(page.getByTestId("create-deadline-summary")).toContainText(/ · 1d$/);
    // Picking a row again clears the notice.
    await page.getByTestId("deadline-option-day").click();
    await expect(page.getByTestId("deadline-refresh-notice")).toHaveCount(0);
    await expect(page.getByTestId("create-game")).toBeEnabled();
    await context.close();
  }

  // (b) "This weekend" late on Sunday: the 7-day clamp is valid the moment it is picked.
  {
    const { context, page } = await formAt("2026-10-26T03:49:50Z"); // Sun Oct 25, 11:49:50 PM EDT
    await page.getByTestId("deadline-option-weekend").click();
    await expect(page.getByTestId("create-game")).toBeEnabled({ timeout: 1_000 });
    expect((await look(page, "weekend")).problem).toBeNull();
    await context.close();
  }

  // (c) "This weekend" picked at 11:48 PM on Sunday, left open past 11:49 PM: it moves to next week and says so.
  {
    const { context, page } = await formAt("2026-10-26T03:48:00Z"); // Sun Oct 25, 11:48:00 PM EDT
    await page.getByTestId("deadline-option-weekend").click();
    expect(await look(page, "weekend")).toMatchObject({ row: "Tonight 11:59 PM", notice: null, createEnabled: true });
    await page.clock.runFor(61_000);
    const moved = await look(page, "weekend");
    expect(moved).toMatchObject({
      notice: "Updated to the next weekend — the earlier time is less than 10 minutes away",
      problem: null,
      createEnabled: true,
    });
    expect(moved.row).not.toBe("Tonight 11:59 PM");
    await context.close();
  }
});
