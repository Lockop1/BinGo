import { gunzipSync } from "node:zlib";
import { expect, test, type BrowserContext, type Page, type Request } from "@playwright/test";
import { LIVE, startGame, twoPhonesInLobby } from "./helpers";

/**
 * Product analytics (src/lib/analytics.ts) end to end. Needs a dev server started with
 *   NEXT_PUBLIC_POSTHOG_KEY=phc_test NEXT_PUBLIC_POSTHOG_HOST=http://127.0.0.1:<port>/__ph
 * (skipped otherwise). Every request to that host is answered here and decoded, so we can
 * check exactly which events left each phone and that none of them carries a name, join
 * code, game id or app URL.
 */

const HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "";
test.skip(!/\/__ph\/?$/.test(HOST), "needs NEXT_PUBLIC_POSTHOG_KEY / NEXT_PUBLIC_POSTHOG_HOST=<app>/__ph");

/**
 * posthog-js drops events from what looks like a bot: a "HeadlessChrome" user agent or
 * client-hint brand, or `navigator.webdriver`. Every phone here presents a regular mobile
 * Chrome instead (test-only; the app never changes this).
 */
const PHONE = {
  userAgent:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
};

async function looksLikeAPhone(context: BrowserContext) {
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false, configurable: true });
    Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => undefined, configurable: true });
    // Routing requests disables the HTTP cache, which makes `next dev` show its "Cache disabled"
    // badge right over the lobby's Ready button: hide the dev overlay (dev-only element).
    new MutationObserver(() => {
      for (const el of document.querySelectorAll<HTMLElement>("nextjs-portal")) {
        if (el.style.display !== "none") el.style.setProperty("display", "none", "important");
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

type SentEvent = { event: string; properties: Record<string, unknown> };
type Capture = { raw: string[]; events: SentEvent[] };

/** What PostHog may add itself (mirrors SDK_KEYS in src/lib/analytics.ts). */
const SDK_KEYS = new Set([
  "token",
  "distinct_id",
  "$lib",
  "$lib_version",
  "$insert_id",
  "$time",
  "$is_identified",
  "$process_person_profile",
  "$os",
  "$browser",
  "$device_type",
  "$screen_height",
  "$screen_width",
  "$viewport_height",
  "$viewport_width",
]);

function decodeBody(request: Request): string {
  const body = request.postDataBuffer();
  if (!body || body.length === 0) return "";
  const compression = new URL(request.url()).searchParams.get("compression");
  if (compression?.startsWith("gzip") || (body[0] === 0x1f && body[1] === 0x8b)) return gunzipSync(body).toString("utf8");
  let text = body.toString("utf8");
  if (compression === "base64" || text.startsWith("data=")) {
    const data = new URLSearchParams(text).get("data") ?? text;
    text = Buffer.from(data, "base64").toString("utf8");
  }
  return text;
}

function eventsIn(text: string): SentEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { batch?: unknown }).batch)
      ? (parsed as { batch: unknown[] }).batch
      : [parsed];
  return list.filter(
    (e): e is SentEvent => !!e && typeof e === "object" && typeof (e as SentEvent).event === "string",
  );
}

/** Answers every analytics request from this phone and records the decoded payloads. */
async function captureAnalytics(context: BrowserContext): Promise<Capture> {
  await looksLikeAPhone(context);
  const capture: Capture = { raw: [], events: [] };
  await context.route("**/__ph/**", async (route) => {
    const request = route.request();
    const text = decodeBody(request);
    capture.raw.push(request.url(), text);
    capture.events.push(...eventsIn(text));
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"status":1}' });
  });
  return capture;
}

function named(capture: Capture, event: string): SentEvent[] {
  return capture.events.filter((e) => e.event === event);
}

/** The event's own (non-SDK) property names, sorted. */
function ownKeys(event: SentEvent): string[] {
  for (const key of Object.keys(event.properties)) {
    expect(SDK_KEYS.has(key) || !key.startsWith("$"), `unexpected SDK property ${key} on ${event.event}`).toBe(true);
  }
  return Object.keys(event.properties)
    .filter((key) => !SDK_KEYS.has(key))
    .sort();
}

async function waitFor(capture: Capture, event: string, count = 1) {
  await expect.poll(() => named(capture, event).length, { timeout: 15_000, message: `${event} sent` }).toBe(count);
}

async function completeSquare(page: Page, position: number) {
  await page.getByTestId(`cell-${position}`).click();
  await expect(page.getByTestId("square-sheet-body")).toHaveAttribute("data-position", String(position));
  await page.getByTestId("complete-hold").click();
  await page.getByTestId("complete-confirm").click();
  await expect(page.getByTestId("square-sheet")).toBeHidden();
  await expect(page.getByTestId(`cell-${position}`)).toHaveAttribute("data-completed", "true");
}

test("product events carry only allow-listed counts, never personal data", async ({ browser }) => {
  const captures: Capture[] = [];
  const phones = await twoPhonesInLobby(browser, {
    prefix: "Analytics",
    host: PHONE,
    friend: PHONE,
    prepare: async (context) => {
      captures.push(await captureAnalytics(context));
    },
  });
  const [hostCap, friendCap] = captures;
  const { host, friend, code, gameId, gameName } = phones;

  // Create: exactly one game_created with only pack + free_center.
  await waitFor(hostCap, "game_created");
  const [created] = named(hostCap, "game_created");
  expect(ownKeys(created)).toEqual(["free_center", "pack"]);
  expect(created.properties).toMatchObject({ pack: "night-out", free_center: true });

  // Join (lobby): player_joined, not late.
  await waitFor(friendCap, "player_joined");
  expect(ownKeys(named(friendCap, "player_joined")[0])).toEqual(["late_join"]);
  expect(named(friendCap, "player_joined")[0].properties.late_join).toBe(false);
  expect(named(hostCap, "player_joined")).toHaveLength(0);

  // Start: from the host's phone only.
  await startGame(phones);
  await waitFor(hostCap, "game_started");
  const [started] = named(hostCap, "game_started");
  expect(ownKeys(started)).toEqual(["counter_squares", "player_count"]);
  expect(started.properties.player_count).toBe(2);
  expect(started.properties.counter_squares).toBeGreaterThanOrEqual(1); // Night Out has counter squares

  // A late joiner mid-game.
  const lateContext = await browser.newContext(PHONE);
  const lateCap = await captureAnalytics(lateContext);
  const late = await lateContext.newPage();
  await late.goto(`/g/${code}`);
  await late.getByTestId("join-name").fill("Latecomer");
  await late.getByTestId("join-game").click();
  await expect(late.getByTestId("game-screen")).toHaveAttribute("data-status", "active");
  await waitFor(lateCap, "player_joined");
  expect(named(lateCap, "player_joined")[0].properties.late_join).toBe(true);

  // Complete a square on the host's phone.
  await completeSquare(host, 0);
  await waitFor(hostCap, "square_completed");
  const [completed] = named(hostCap, "square_completed");
  expect(ownKeys(completed)).toEqual(["counter", "total_completed"]);
  expect(completed.properties).toMatchObject({ counter: false, total_completed: 2 }); // square 0 + FREE

  // End the game (host).
  await host.getByTestId("players-button").click();
  await host.getByTestId("end-game").click();
  await host.getByTestId("end-game-confirm").click();
  await expect(host.getByTestId("game-screen")).toHaveAttribute("data-status", "ended", LIVE);
  await waitFor(hostCap, "game_ended");
  const [ended] = named(hostCap, "game_ended");
  expect(ownKeys(ended)).toEqual(["blackout", "by", "duration_min", "lines", "player_count", "squares_completed"]);
  expect(ended.properties).toMatchObject({
    by: "host",
    blackout: false,
    lines: 0,
    squares_completed: 2,
    player_count: 3,
    duration_min: 0,
  });
  await expect(friend.getByTestId("game-screen")).toHaveAttribute("data-status", "ended", LIVE);

  // Let any trailing batch flush, then check every phone's traffic as a whole.
  await host.waitForTimeout(3_500);
  expect(named(hostCap, "game_created")).toHaveLength(1);
  expect(named(hostCap, "game_started")).toHaveLength(1);
  for (const cap of [friendCap, lateCap]) {
    expect(named(cap, "game_started")).toHaveLength(0);
    expect(named(cap, "game_ended")).toHaveLength(0);
    expect(named(cap, "game_created")).toHaveLength(0);
  }
  const allowed = new Set([
    "game_created",
    "player_joined",
    "game_started",
    "square_completed",
    "media_uploaded",
    "game_ended",
    "recap_viewed",
    "play_again",
  ]);
  const everything = [...hostCap.raw, ...friendCap.raw, ...lateCap.raw];
  expect(everything.length).toBeGreaterThan(0);
  for (const cap of [hostCap, friendCap, lateCap]) {
    for (const event of cap.events) {
      expect(allowed.has(event.event), `unexpected event ${event.event}`).toBe(true);
      expect(event).not.toHaveProperty("$set");
      expect(event).not.toHaveProperty("$set_once");
    }
  }
  const secrets = [code, gameId, gameName, "Hosty", "Friendo", "Latecomer", "/g/", "/game/", "127.0.0.1:"];
  for (const text of everything) {
    // The request URL itself is the analytics host; only its query string is checked.
    const haystack = text.startsWith("http") ? new URL(text).search : text;
    for (const secret of secrets) expect(haystack, `payload leaks ${secret}`).not.toContain(secret);
  }

  await lateContext.close();
  await phones.close();
});
