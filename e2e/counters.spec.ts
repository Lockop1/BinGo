import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { LIVE, squareAs, twoPhonesInActiveGame } from "./helpers";

/**
 * Counter squares on two phones (Night Out pack: square 2 is "Collect 15
 * stranger signatures", target 15). Every +1 carries its own action id, so the
 * server counts each tap exactly once: taps from both phones at the same
 * time, taps made offline and sent later, and a tap whose answer was lost and
 * that is retried after a reload. The local backend never delivers Realtime
 * events, so the other phone catches up over the resync poll (1.5 s in e2e).
 */

const COUNTER = 2;
const RPC = "**/rest/v1/rpc/increment_square";
const SYNC = { timeout: 6_000 };

async function openCounter(page: Page): Promise<Locator> {
  await page.getByTestId(`cell-${COUNTER}`).click();
  await expect(page.getByTestId("square-sheet")).toBeVisible();
  await expect(page.getByTestId("square-sheet-body")).toHaveAttribute("data-position", String(COUNTER));
  const plus = page.getByTestId("increment");
  await plus.click({ trial: true }); // waits until the sheet has stopped moving
  return plus;
}

async function tap(plus: Locator, times: number) {
  for (let i = 0; i < times; i++) await plus.click();
}

const cell = (page: Page) => page.getByTestId(`cell-${COUNTER}`);

/** Both the grid cell and (when open) the sheet show `count`/15, settled (nothing pending). */
async function expectSettled(pages: Page[], count: number) {
  for (const page of pages) {
    await expect(cell(page)).toHaveAttribute("data-count", `${count}/15`, SYNC);
    await expect(cell(page)).not.toHaveAttribute("data-pending", SYNC);
  }
}

test("counter +1s: simultaneous, offline and retried-after-reload taps all count exactly once", async ({ browser }) => {
  test.setTimeout(150_000);
  const { host, friend, hostContext, friendContext, gameId, close } = await twoPhonesInActiveGame(browser, {
    prefix: "Counters",
  });
  const serverCount = async () => (await squareAs(hostContext, gameId, COUNTER)).current_count;
  for (const page of [host, friend]) await expect(cell(page)).toHaveAttribute("data-count", "0/15", LIVE);

  const [friendPlus, hostPlus] = await Promise.all([openCounter(friend), openCounter(host)]);

  await test.step("both phones tap at once: 3 + 2 = 5 on both, nothing lost", async () => {
    await Promise.all([tap(friendPlus, 3), tap(hostPlus, 2)]);
    for (const page of [host, friend]) await expect(page.getByTestId("counter-value")).toHaveText("5/15", SYNC);
    await expect.poll(serverCount).toBe(5);
    await expectSettled([host, friend], 5);
    // A couple of polls later both still say 5 (no late correction either way).
    await host.waitForTimeout(2_000);
    await expectSettled([host, friend], 5);
    await expect(friend.getByTestId("square-outcome")).toHaveCount(0);
  });

  await test.step("offline taps go out on reconnect: 5 + 2 offline + 1 online = 8 on both", async () => {
    await friendContext.setOffline(true);
    await tap(friendPlus, 2);
    await expect(friend.getByTestId("counter-value")).toHaveText("7/15");
    await expect(friend.getByTestId("square-pending")).toContainText("waiting for signal");
    await tap(hostPlus, 1);
    await expect(host.getByTestId("counter-value")).toHaveText("6/15", SYNC);
    await expect.poll(serverCount).toBe(6);
    // Failed polls while offline change nothing: still my two on top of what I last saw.
    await friend.waitForTimeout(2_000);
    await expect(friend.getByTestId("counter-value")).toHaveText("7/15");

    await friendContext.setOffline(false);
    for (const page of [host, friend]) await expect(page.getByTestId("counter-value")).toHaveText("8/15", SYNC);
    await expect.poll(serverCount).toBe(8);
    await expectSettled([host, friend], 8);
  });

  await test.step("a +1 whose answer was lost, retried after a reload with the same id, counts once", async () => {
    // First request: it reaches the server (which counts it) but the answer
    // never reaches the phone. Its retry is then held in the air, so the reload
    // below happens while that tap is still in doubt.
    let mode: "lose" | "hold" | "pass" = "lose";
    const held: Route[] = [];
    const sentIds: string[] = [];
    await friend.route(RPC, async (route) => {
      if (route.request().method() !== "POST") return route.continue().catch(() => {});
      sentIds.push((route.request().postDataJSON() as { action_id?: string }).action_id ?? "");
      if (mode === "lose") {
        mode = "hold";
        await route.fetch().catch(() => null);
        await route.abort("internetdisconnected").catch(() => {});
      } else if (mode === "hold") {
        held.push(route);
      } else {
        await route.continue().catch(() => {});
      }
    });
    const answers: { actionId: string; applied: boolean; count: number }[] = [];
    friend.on("response", async (response) => {
      if (!response.url().includes("/rest/v1/rpc/increment_square") || response.request().method() !== "POST") return;
      try {
        const body = (await response.json()) as { applied: boolean; current_count: number };
        const actionId = (response.request().postDataJSON() as { action_id?: string }).action_id ?? "";
        answers.push({ actionId, applied: body.applied, count: body.current_count });
      } catch {
        // Not a JSON answer: ignored.
      }
    });

    await tap(friendPlus, 1); // tap A: counted by the server, answer lost
    await expect.poll(serverCount).toBe(9);
    await expect.poll(() => held.length, { timeout: 10_000 }).toBe(1); // A's retry, in the air
    await tap(friendPlus, 1); // tap B: queued behind A, not sent yet
    const [idA] = sentIds;
    expect(sentIds).toEqual([idA, idA]);
    expect(idA).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await expect
      .poll(async () =>
        friend.evaluate((key) => (JSON.parse(localStorage.getItem(key) ?? "[]") as { kind: string }[]).length, `bingo.pending.${gameId}`),
      )
      .toBe(2);
    await expect(host.getByTestId("counter-value")).toHaveText("9/15", SYNC);

    // Reload with A still in doubt and B unsent; requests flow normally from now on.
    mode = "pass";
    await friend.reload();
    for (const route of held) await route.abort("internetdisconnected").catch(() => {});
    await expect(friend.getByTestId("board-grid")).toBeVisible();

    await expectSettled([host, friend], 10);
    await expect.poll(serverCount).toBe(10);
    // A came back as "already counted" (same id); B counted once.
    const idB = sentIds.find((id) => id !== idA);
    expect(idB).toBeTruthy();
    expect(answers).toEqual([
      { actionId: idA, applied: false, count: 9 },
      { actionId: idB, applied: true, count: 10 },
    ]);
    expect(new Set(sentIds)).toEqual(new Set([idA, idB]));
    await expect
      .poll(() => friend.evaluate((key) => localStorage.getItem(key), `bingo.pending.${gameId}`))
      .toBeNull();
    await friend.unroute(RPC);

    await host.waitForTimeout(2_000);
    await expectSettled([host, friend], 10);
    await expect(host.getByTestId("counter-value")).toHaveText("10/15");
  });

  await close();
});
