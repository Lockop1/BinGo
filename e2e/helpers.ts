import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from "@playwright/test";

/**
 * Shared two-phone setup for the live-board specs. The local backend never
 * delivers Realtime events, so everything that crosses phones travels over
 * the resync poll (NEXT_PUBLIC_SYNC_POLL_MS=1500 in playwright.config.ts).
 */

export const LIVE = { timeout: 3_000 };

export type Pack = "night-out" | "day-adventure" | "blank";

export type TwoPhones = {
  hostContext: BrowserContext;
  friendContext: BrowserContext;
  host: Page;
  friend: Page;
  gameName: string;
  gameId: string;
  code: string;
  close: () => Promise<void>;
};

export type TwoPhoneOptions = {
  /** Shown in the game name (`E2E <prefix> <random>`). */
  prefix?: string;
  pack?: Pack;
  /** A deadline preset to pick on the create form (default: leave Tonight, the form's default). */
  deadline?: "tonight" | "day" | "weekend";
  host?: BrowserContextOptions;
  friend?: BrowserContextOptions;
  /** Runs on each context before its first page opens (e.g. addInitScript). */
  prepare?: (context: BrowserContext) => Promise<void>;
};

/** Host creates a game, a friend joins via the link, both tap Ready: Start is enabled on the host. */
export async function twoPhonesInLobby(browser: Browser, options: TwoPhoneOptions = {}): Promise<TwoPhones> {
  const gameName = `E2E ${options.prefix ?? "Board"} ${Date.now().toString(36)}`;
  const hostContext = await browser.newContext(options.host);
  const friendContext = await browser.newContext(options.friend);
  if (options.prepare) {
    await options.prepare(hostContext);
    await options.prepare(friendContext);
  }
  const host = await hostContext.newPage();
  const friend = await friendContext.newPage();

  await host.goto("/new");
  await host.waitForLoadState("networkidle");
  const create = host.getByTestId("create-game");
  await expect(async () => {
    await host.getByTestId("game-name").fill(gameName);
    await host.getByTestId("host-name").fill("Hosty");
    await expect(create).toBeEnabled({ timeout: 1_000 });
  }).toPass();
  await host.getByTestId(`pack-${options.pack ?? "night-out"}`).click();
  if (options.deadline) {
    await host.getByTestId(`deadline-option-${options.deadline}`).click();
    await expect(host.getByTestId("deadline-picker")).toHaveAttribute("data-selected", options.deadline);
  }
  await create.click();
  await expect(host).toHaveURL(/\/game\/[0-9a-f-]{36}$/);
  const gameId = new URL(host.url()).pathname.split("/").pop()!;
  const code = (await host.getByTestId("invite-code").getAttribute("data-code"))!;

  await friend.goto(`/g/${code}`);
  await friend.getByTestId("join-name").fill("Friendo");
  await friend.getByTestId("join-game").click();
  await expect(friend.getByTestId("lobby")).toBeVisible();
  await expect(host.getByTestId("player")).toHaveCount(2, LIVE);

  await host.getByTestId("ready-toggle").click();
  await friend.getByTestId("ready-toggle").click();
  await expect(host.getByTestId("start-game")).toBeEnabled(LIVE);

  return {
    hostContext,
    friendContext,
    host,
    friend,
    gameName,
    gameId,
    code,
    close: async () => {
      await hostContext.close();
      await friendContext.close();
    },
  };
}

/** The host taps Start; resolves once both phones show the live board. */
export async function startGame(phones: Pick<TwoPhones, "host" | "friend">): Promise<void> {
  await phones.host.getByTestId("start-game").click();
  for (const page of [phones.host, phones.friend]) {
    await expect(page.getByTestId("game-screen")).toHaveAttribute("data-status", "active", { timeout: 5_000 });
    await expect(page.getByTestId("board-grid")).toBeVisible();
  }
}

/** Two phones that have reached an active game (Night Out pack unless told otherwise). */
export async function twoPhonesInActiveGame(browser: Browser, options: TwoPhoneOptions = {}): Promise<TwoPhones> {
  const phones = await twoPhonesInLobby(browser, options);
  await startGame(phones);
  return phones;
}

/** The page never scrolls sideways and the grid's right edge stays on screen. */
export async function expectFitsWidth(page: Page, label = "") {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, `scrollWidth ${label} on ${page.url()}`).toBeLessThanOrEqual(innerWidth);
  const grid = await page.getByTestId("board-grid").boundingBox();
  expect(grid, "board grid").not.toBeNull();
  expect(grid!.x, `grid left ${label}`).toBeGreaterThanOrEqual(0);
  expect(grid!.x + grid!.width, `grid right ${label}`).toBeLessThanOrEqual(innerWidth + 0.5);
}

/** The page never scrolls sideways (for screens without the board grid, e.g. the recap). */
export async function expectPageFitsWidth(page: Page, label = "") {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, `scrollWidth ${label} on ${page.url()}`).toBeLessThanOrEqual(innerWidth);
}

/** NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY from the environment or .env.local (what `npm run dev` reads). */
export function publicSupabaseEnv(): { url: string; anonKey: string } | null {
  let url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  let anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    try {
      const text = readFileSync(join(process.cwd(), ".env.local"), "utf8");
      for (const line of text.split("\n")) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (!m) continue;
        const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
        if (m[1] === "NEXT_PUBLIC_SUPABASE_URL") url ??= value;
        if (m[1] === "NEXT_PUBLIC_SUPABASE_ANON_KEY") anonKey ??= value;
      }
    } catch {
      return null;
    }
  }
  return url && anonKey ? { url, anonKey } : null;
}

/** The anonymous session's access token from @supabase/ssr's (possibly chunked) auth cookie. */
export async function accessToken(context: BrowserContext): Promise<string> {
  const parts = (await context.cookies())
    .map((c) => ({ c, m: /^sb-.+-auth-token(?:\.(\d+))?$/.exec(c.name) }))
    .filter((x) => x.m !== null)
    .sort((a, b) => Number(a.m![1] ?? 0) - Number(b.m![1] ?? 0))
    .map((x) => x.c.value);
  expect(parts.length, "auth cookie").toBeGreaterThan(0);
  let raw = decodeURIComponent(parts.join(""));
  if (raw.startsWith("base64-")) raw = Buffer.from(raw.slice("base64-".length), "base64url").toString("utf8");
  const token = (JSON.parse(raw) as { access_token?: string }).access_token;
  expect(token, "access token").toBeTruthy();
  return token!;
}

/**
 * Calls an RPC as the given phone's anonymous user (same RLS / security
 * definer checks as the app). Used where the app's own path can't finish
 * locally, e.g. `register_media` after an upload (local Storage is a stub).
 */
export async function rpcAs<T>(context: BrowserContext, name: string, args: Record<string, unknown>): Promise<T> {
  const env = publicSupabaseEnv();
  if (!env) throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY not set");
  const token = await accessToken(context);
  const res = await context.request.post(`${env.url}/rest/v1/rpc/${name}`, {
    headers: { apikey: env.anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: args,
  });
  expect(res.ok(), `${name}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

export type SquareRow = { current_count: number; target_count: number; completed_at: string | null };

/** The server's copy of one square, read through PostgREST as the given phone (RLS: members only). */
export async function squareAs(context: BrowserContext, gameId: string, position: number): Promise<SquareRow> {
  const env = publicSupabaseEnv();
  if (!env) throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY not set");
  const token = await accessToken(context);
  const res = await context.request.get(
    `${env.url}/rest/v1/squares?game_id=eq.${gameId}&position=eq.${position}&select=current_count,target_count,completed_at`,
    { headers: { apikey: env.anonKey, Authorization: `Bearer ${token}` } },
  );
  expect(res.ok(), `squares: ${res.status()} ${await res.text()}`).toBe(true);
  const rows = (await res.json()) as SquareRow[];
  expect(rows, "square row").toHaveLength(1);
  return rows[0];
}

/** Another phone joins by the invite link and lands in the lobby (or on the live board, for a late join). */
export async function joinPhone(
  browser: Browser,
  code: string,
  name: string,
  options?: BrowserContextOptions,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.goto(`/g/${code}`);
  await page.getByTestId("join-name").fill(name);
  await page.getByTestId("join-game").click();
  await expect(page.getByTestId("game-screen")).toBeVisible();
  return { context, page };
}

/** Rows from a PostgREST table path (e.g. `games?id=eq.<id>&select=*`), read as the given phone (RLS applies). */
export async function selectAs<T>(context: BrowserContext, path: string): Promise<T[]> {
  const env = publicSupabaseEnv();
  if (!env) throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY not set");
  const token = await accessToken(context);
  const res = await context.request.get(`${env.url}/rest/v1/${path}`, {
    headers: { apikey: env.anonKey, Authorization: `Bearer ${token}` },
  });
  expect(res.ok(), `${path}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T[];
}

/** Calls an RPC as the given phone and returns the raw answer (for expected errors: `body.message` is the code). */
export async function rpcRawAs(
  context: BrowserContext,
  name: string,
  args: Record<string, unknown>,
): Promise<{ status: number; body: { code?: string; message?: string } & Record<string, unknown> }> {
  const env = publicSupabaseEnv();
  if (!env) throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY not set");
  const token = await accessToken(context);
  const res = await context.request.post(`${env.url}/rest/v1/rpc/${name}`, {
    headers: { apikey: env.anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: args,
  });
  return { status: res.status(), body: (await res.json()) as { code?: string; message?: string } };
}

/** The local backend's database (`npm run backend:status`); override with BINGO_LOCAL_DB_URL. */
const LOCAL_DB_URL = process.env.BINGO_LOCAL_DB_URL ?? "postgresql://postgres@127.0.0.1:54329/bingo_local";

/**
 * Time travel for the deadline specs: sets a game's `deadline_at` straight in
 * the local database (as postgres), for the "passed" / "about to pass" cases
 * the RPCs refuse. `created_at` / `started_at` move back when needed so the
 * table's checks (deadline after creation) still hold. Local backend only.
 */
export function setDeadlineViaDb(gameId: string, iso: string): void {
  if (!/^[0-9a-f-]{36}$/.test(gameId)) throw new Error(`bad game id ${gameId}`);
  if (Number.isNaN(Date.parse(iso))) throw new Error(`bad deadline ${iso}`);
  const sql = `
    update public.games g
    set created_at = case when g.created_at >= :'at'::timestamptz then :'at'::timestamptz - interval '1 hour' else g.created_at end,
        started_at = case
          when g.started_at is not null and g.started_at >= :'at'::timestamptz then :'at'::timestamptz - interval '1 hour'
          else g.started_at
        end,
        deadline_at = :'at'::timestamptz
    where g.id = :'id'::uuid
    returning g.id;
  `;
  const out = execSync(`psql "${LOCAL_DB_URL}" -X -q -At -v ON_ERROR_STOP=1 -v id=${gameId} -v at=${iso}`, {
    input: sql,
    encoding: "utf8",
  });
  expect(out.trim(), `setDeadlineViaDb(${gameId})`).toBe(gameId);
}

/**
 * A fresh anonymous user straight from the auth server, with no browser or page load: the
 * cheap way to fill a game with players (e.g. ten for a full game). Needs anonymous sign-ins
 * enabled, as the app itself does.
 */
export async function anonUser(request: APIRequestContext): Promise<{ token: string; userId: string }> {
  const env = publicSupabaseEnv();
  if (!env) throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY not set");
  const res = await request.post(`${env.url}/auth/v1/signup`, {
    headers: { apikey: env.anonKey, "Content-Type": "application/json" },
    data: {},
  });
  expect(res.ok(), `anonymous sign-in: ${res.status()} ${await res.text()}`).toBe(true);
  const body = (await res.json()) as { access_token?: string; user?: { id?: string } };
  expect(body.access_token, "access token").toBeTruthy();
  return { token: body.access_token!, userId: body.user?.id ?? "" };
}

/** Calls an RPC with a bare access token (from `anonUser`); same RLS / security definer checks as the app. */
export async function rpcWithToken<T>(
  request: APIRequestContext,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const env = publicSupabaseEnv();
  if (!env) throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY not set");
  const res = await request.post(`${env.url}/rest/v1/rpc/${name}`, {
    headers: { apikey: env.anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: args,
  });
  expect(res.ok(), `${name}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}
