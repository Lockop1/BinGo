import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { LIVE, expectPageFitsWidth, publicSupabaseEnv, rpcAs, selectAs, twoPhonesInActiveGame } from "./helpers";

/**
 * "Play again" on the recap: a quiet text link at the very bottom of the
 * ended screen (below "Back to home") starts a new lobby with the same name
 * and board (`play_again`),
 * and every other phone on the recap gets "A new game is ready · Join", one
 * tap into that lobby under the name it already had. The local backend never
 * delivers Realtime events: the old game's rematch pointer reaches the other
 * phone through the recap's fast poll right after the end (1.5 s in e2e).
 *
 * Also checks `peek_game_public` the way a link-preview crawler calls it:
 * plain `fetch` with only the anon `apikey` header, no session at all.
 */

type SquareRow = {
  position: number;
  label: string;
  details: string;
  target_count: number;
  current_count: number;
  completed_at: string | null;
  completed_by_player_id: string | null;
};
type GameRow = { id: string; join_code: string; name: string; free_center: boolean; next_game_id: string | null; next_join_code: string | null };

const SQUARE_COLUMNS = "position,label,details,target_count,current_count,completed_at,completed_by_player_id";
const GAME_URL = /\/game\/[0-9a-f-]{36}$/;

async function style(locator: Locator) {
  return locator.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      tag: el.tagName,
      color: s.color,
      background: s.backgroundColor,
      backgroundImage: s.backgroundImage,
      boxShadow: s.boxShadow,
      borderTop: s.borderTopWidth,
      fontSize: Number.parseFloat(s.fontSize),
      decoration: s.textDecorationLine,
    };
  });
}

/**
 * Where the rematch link sits among everything else drawn on the page: the
 * lowest bottom edge of any other visible in-flow element (ancestors of the link,
 * its own contents and fixed overlays such as the dev tools badge are skipped).
 */
async function rematchPlacement(page: Page, linkTestId: string) {
  return page.evaluate((testId) => {
    const link = document.querySelector(`[data-testid="${testId}"]`);
    const home = document.querySelector('[data-testid="back-home"]');
    if (!link || !home) throw new Error("rematch link or back-home missing");
    const inFixed = (el: Element) => {
      for (let node: Element | null = el; node; node = node.parentElement) {
        if (getComputedStyle(node).position === "fixed") return true;
      }
      return false;
    };
    const y = window.scrollY;
    const linkBox = link.getBoundingClientRect();
    let lowest = -Infinity;
    let lowestWhat = "";
    for (const el of document.body.querySelectorAll("*")) {
      if (el.contains(link) || link.contains(el)) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
      if (inFixed(el)) continue;
      if (box.bottom + y > lowest) {
        lowest = box.bottom + y;
        lowestWhat = `${el.tagName.toLowerCase()}[data-testid=${el.getAttribute("data-testid") ?? ""}]`;
      }
    }
    const homeBox = home.getBoundingClientRect();
    return {
      linkTop: linkBox.top + y,
      linkBottom: linkBox.bottom + y,
      linkCenterX: linkBox.left + linkBox.width / 2,
      homeBottom: homeBox.bottom + y,
      homeCenterX: homeBox.left + homeBox.width / 2,
      otherLowest: lowest,
      otherLowestWhat: lowestWhat,
    };
  }, linkTestId);
}

test("play again: a quiet link on the recap starts a rematch lobby with the same board; the other phone joins in one tap", async ({
  browser,
}) => {
  const env = publicSupabaseEnv();
  test.skip(env === null, "needs NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY");
  test.setTimeout(150_000);
  const { host, friend, hostContext, friendContext, gameId, gameName, code, close } = await twoPhonesInActiveGame(browser, {
    prefix: "Again",
  });

  // Some play to reset: the friend completes square 0 (with a photo, so the
  // recap has Watch / Download all) and taps the counter square once.
  const oldSquaresBefore = await selectAs<SquareRow>(friendContext, `squares?game_id=eq.${gameId}&select=${SQUARE_COLUMNS}&order=position`);
  const counter = oldSquaresBefore.find((s) => s.target_count > 1);
  expect(counter, "Night Out has a counter square").toBeTruthy();
  await rpcAs(friendContext, "complete_square", { game_id: gameId, position: 0 });
  await rpcAs(friendContext, "register_media", {
    game_id: gameId,
    position: 0,
    storage_path: `${gameId}/0/e2e-${Date.now().toString(36)}.jpg`,
    kind: "photo",
  });
  await rpcAs(friendContext, "increment_square", { game_id: gameId, position: counter!.position, action_id: randomUUID() });
  await expect(host.getByTestId("cell-0")).toHaveAttribute("data-completed", "true", LIVE);

  const [oldGame] = await selectAs<GameRow>(hostContext, `games?id=eq.${gameId}&select=*`);
  const oldSquares = await selectAs<SquareRow>(friendContext, `squares?game_id=eq.${gameId}&select=${SQUARE_COLUMNS}&order=position`);
  expect(oldSquares.filter((s) => s.completed_at !== null).length, "played squares").toBeGreaterThanOrEqual(2);

  await test.step("the host ends the game: both recaps, nothing rematch-y but a small link", async () => {
    await host.getByTestId("players-button").click();
    await host.getByTestId("end-game").click();
    await host.getByTestId("end-game-confirm").click();
    for (const page of [host, friend]) {
      await expect(page.getByTestId("recap-summary")).toBeVisible(LIVE);
      await expect(page.getByTestId("recap-download-all")).toBeVisible();
      await expect(page.getByTestId("play-again")).toHaveText("Play again");
    }
  });

  await test.step("on the friend's recap, Play again is the lowest thing on the page: plain muted text under Back to home", async () => {
    const ended = friend.getByTestId("game-ended");
    await expect(ended.locator(":scope > *").last()).toHaveAttribute("data-testid", "rematch");
    const link = friend.getByTestId("play-again");
    await expect(link).toBeVisible();

    for (const colorScheme of ["light", "dark"] as const) {
      await friend.emulateMedia({ colorScheme });
      await link.scrollIntoViewIfNeeded();
      expect(friend.viewportSize()?.width, "phone width").toBe(375);

      const look = await style(link);
      const muted = await style(friend.getByTestId("recap-download-note"));
      const body = await style(friend.getByTestId("recap-expiry"));
      expect(look.tag, "a plain button element").toBe("BUTTON");
      expect(look.background, "no fill").toBe("rgba(0, 0, 0, 0)");
      expect(look.backgroundImage).toBe("none");
      expect(look.boxShadow, "no shadow").toBe("none");
      expect(look.borderTop, "no border").toBe("0px");
      expect(look.decoration, "underlined like a link").toContain("underline");
      expect(look.color, `the muted ink colour (${colorScheme})`).toBe(muted.color);
      expect(look.fontSize, "smaller than the summary text").toBeLessThan(body.fontSize);
      // Not a popup or overlay: it sits in the page's flow, after Back to home.
      expect(await link.evaluate((el) => getComputedStyle(el.parentElement!).position)).toBe("static");

      const at = await rematchPlacement(friend, "play-again");
      expect(at.linkTop, `below Back to home (${colorScheme})`).toBeGreaterThanOrEqual(at.homeBottom);
      expect(
        at.linkBottom,
        `the lowest element on the page (${colorScheme}); next lowest: ${at.otherLowestWhat}`,
      ).toBeGreaterThanOrEqual(at.otherLowest);
      expect(Math.abs(at.linkCenterX - at.homeCenterX), "centred under Back to home").toBeLessThanOrEqual(2);
      expect(at.linkBottom - at.linkTop, "still a comfortable tap target").toBeGreaterThanOrEqual(44);
      await expectPageFitsWidth(friend, `on the recap with the rematch link (${colorScheme})`);
    }
    await friend.emulateMedia({ colorScheme: null });
  });

  let newId = "";
  let newCode = "";

  await test.step("the friend taps Play again: a new lobby they host, same name, same board, counts reset", async () => {
    await friend.getByTestId("play-again").click();
    await expect(friend).toHaveURL(GAME_URL);
    await expect(friend).not.toHaveURL(new RegExp(gameId));
    newId = new URL(friend.url()).pathname.split("/").pop()!;
    await expect(friend.getByTestId("lobby")).toBeVisible();
    await expect(friend.getByTestId("lobby-title")).toHaveText(gameName);
    // Host controls: End game, no Leave. Only the friend so far, under their name, not ready.
    await expect(friend.getByTestId("lobby-end-game")).toBeVisible();
    await expect(friend.getByTestId("leave-lobby")).toHaveCount(0);
    await expect(friend.getByTestId("player")).toHaveCount(1);
    await expect(friend.getByTestId("player-name")).toHaveText(/Friendo/);
    await expect(friend.getByTestId("ready-toggle")).toHaveAttribute("data-ready", "false");
    newCode = (await friend.getByTestId("invite-code").getAttribute("data-code"))!;
    expect(newCode).not.toBe(code);

    const [newGame] = await selectAs<GameRow>(friendContext, `games?id=eq.${newId}&select=*`);
    expect(newGame.name).toBe(oldGame.name);
    expect(newGame.free_center).toBe(oldGame.free_center);
    expect(newGame.join_code).toBe(newCode);

    const newSquares = await selectAs<SquareRow>(friendContext, `squares?game_id=eq.${newId}&select=${SQUARE_COLUMNS}&order=position`);
    expect(newSquares).toHaveLength(25);
    for (const old of oldSquares) {
      const next = newSquares[old.position];
      const label = old.position === 12 && oldGame.free_center && old.label === "FREE" ? "" : old.label;
      expect({ position: next.position, label: next.label, details: next.details, target: next.target_count }).toEqual({
        position: old.position,
        label,
        details: old.details,
        target: old.target_count,
      });
      expect({ count: next.current_count, at: next.completed_at, by: next.completed_by_player_id }).toEqual({
        count: 0,
        at: null,
        by: null,
      });
    }
    // The lobby draws the same board: square labels, the counter badge, the free center.
    await expect(friend.getByTestId("square-0")).toContainText(oldSquares[0].label);
    await expect(friend.getByTestId(`square-${counter!.position}`).getByTestId("counter-badge")).toHaveText(
      `×${counter!.target_count}`,
    );
    await expect(friend.getByTestId("square-12")).toHaveAttribute("data-free", String(oldGame.free_center));
  });

  await test.step("the old game points at the rematch for its members; the new game stays private until they join", async () => {
    const [old] = await selectAs<GameRow>(hostContext, `games?id=eq.${gameId}&select=next_game_id,next_join_code`);
    expect(old).toEqual({ next_game_id: newId, next_join_code: newCode });
    expect(await selectAs(hostContext, `games?id=eq.${newId}&select=id`)).toEqual([]);
  });

  await test.step("the host's recap shows the join link within seconds; one tap joins under their existing name", async () => {
    const join = host.getByTestId("join-next");
    await expect(join).toHaveText("A new game is ready · Join", { timeout: 10_000 });
    await expect(host.getByTestId("game-ended").locator(":scope > *").last()).toHaveAttribute("data-testid", "rematch");
    const at = await rematchPlacement(host, "join-next");
    expect(at.linkTop, "below Back to home").toBeGreaterThanOrEqual(at.homeBottom);
    expect(at.linkBottom, `the lowest element; next lowest: ${at.otherLowestWhat}`).toBeGreaterThanOrEqual(at.otherLowest);
    await expect(host.getByTestId("play-again")).toHaveCount(0);
    await join.click();
    await expect(host).toHaveURL(new RegExp(`/game/${newId}$`));
    await expect(host.getByTestId("lobby")).toBeVisible();
    await expect(host.getByTestId("lobby-title")).toHaveText(gameName);
    // A player now, not the host.
    await expect(host.getByTestId("leave-lobby")).toBeVisible();
    await expect(host.getByTestId("lobby-end-game")).toHaveCount(0);
    for (const page of [host, friend]) {
      await expect(page.getByTestId("player")).toHaveCount(2, LIVE);
      await expect(page.getByTestId("player-count")).toHaveText("2/10");
      // In join order: the rematch's host first, then the old host under the name they had.
      await expect(page.getByTestId("player-name")).toHaveText(["Friendo", "Hosty"]);
    }
  });

  await test.step("back on the old recap, the friend (in the rematch) gets Go to it", async () => {
    await friend.goBack();
    await expect(friend).toHaveURL(new RegExp(`/game/${gameId}$`));
    const go = friend.getByTestId("go-next");
    await expect(go).toHaveText("You started a new game · Go to it", LIVE);
    await go.click();
    await expect(friend).toHaveURL(new RegExp(`/game/${newId}$`));
    await expect(friend.getByTestId("lobby")).toBeVisible();
  });

  await test.step("peek_game_public answers a session-less fetch with only the anon apikey", async () => {
    const peek = (value: string) =>
      fetch(`${env!.url}/rest/v1/rpc/peek_game_public`, {
        method: "POST",
        headers: { apikey: env!.anonKey, "Content-Type": "application/json" },
        body: JSON.stringify({ code: value }),
      });
    const ok = await peek(`${newCode.slice(0, 4).toLowerCase()}-${newCode.slice(4)}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ name: gameName, status: "lobby", player_count: 2, free_center: oldGame.free_center });
    const ended = await peek(code);
    expect(ended.status).toBe(200);
    expect(((await ended.json()) as { status: string }).status).toBe("ended");
    const bogus = await peek("ZZZZZZZZ");
    expect(bogus.ok).toBe(false);
    expect(((await bogus.json()) as { message: string }).message).toBe("game_not_found");
    // Still nothing else for anon: a table read without a session is refused.
    const table = await fetch(`${env!.url}/rest/v1/games?select=id&limit=1`, { headers: { apikey: env!.anonKey } });
    expect(table.ok).toBe(false);
  });

  await test.step("once the rematch has ended, the old recap offers nothing (play_again would only hand it back)", async () => {
    await rpcAs(friendContext, "end_game", { game_id: newId });
    // The host is a player of the rematch, so the link looks it up by a member select.
    const lookup = host.waitForResponse(
      (r) => r.url().includes("/rest/v1/games") && r.url().includes(`id=eq.${newId}`) && r.url().includes("auto_end_at"),
    );
    await host.goto(`/game/${gameId}`);
    await expect(host.getByTestId("recap-summary")).toBeVisible(LIVE);
    await expect(host.getByTestId("back-home")).toBeVisible();
    await lookup;
    // Give the answer a moment to render, then make sure no rematch link of any kind shows.
    await host.waitForTimeout(500);
    await expect(host.getByTestId("rematch")).toHaveCount(0);
    await expect(host.getByTestId("game-ended").locator(":scope > *").last()).toHaveAttribute("data-testid", "back-home");
  });

  await close();
});
