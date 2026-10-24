import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVE_GAME_KEY,
  HOME_GUARD_SCRIPT,
  LAST_ENDED_KEY,
  LAST_ENDED_MAX_AGE_MS,
  LOBBY_RECORD_MAX_AGE_MS,
  STAY_HOME_KEY,
  clearActiveGame,
  clearStayHome,
  consumeLastEnded,
  decideOpen,
  goHomeOnPurpose,
  isFreshOpen,
  isGameSnapshot,
  isRecapDue,
  isReturnable,
  isStayHome,
  leaveToHome,
  noteGameEnded,
  noteGameScreenShown,
  parseActiveGame,
  parseLastEnded,
  readActiveGame,
  readActiveGameFor,
  readLastEnded,
  saveActiveGame,
  toActiveGameRecord,
  type ActiveGameRecord,
  type LastEndedRecord,
  type OpenInput,
} from "@/lib/game/activeGame";
import type { GameSnapshot } from "@/lib/game/realtime";
import { GAME_ID, board, completedBy } from "@/lib/game/testFixtures";
import type { Game, Media, Player } from "@/lib/game/types";

const NOW = Date.parse("2026-10-23T22:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

function game(overrides: Partial<Game> = {}): Game {
  return {
    id: GAME_ID,
    join_code: "ABCD2345",
    name: "Friday night",
    host_user_id: "user-host",
    status: "active",
    free_center: true,
    created_at: iso(NOW - 2 * HOUR),
    started_at: iso(NOW - HOUR),
    ended_at: null,
    auto_end_at: iso(NOW + 23 * HOUR),
    expires_at: iso(NOW + 30 * 24 * HOUR),
    ...overrides,
  };
}

const players: Player[] = [
  {
    id: "player-host",
    game_id: GAME_ID,
    user_id: "user-host",
    display_name: "Hosty",
    color: 0,
    is_ready: true,
    joined_at: iso(NOW - 2 * HOUR),
  },
  {
    id: "player-me",
    game_id: GAME_ID,
    user_id: "user-me",
    display_name: "Friendo",
    color: 1,
    is_ready: true,
    joined_at: iso(NOW - 2 * HOUR + 1000),
  },
];

const media: Media[] = [
  {
    id: "m1",
    game_id: GAME_ID,
    square_id: "sq-0",
    player_id: "player-me",
    storage_path: `${GAME_ID}/0/a.jpg`,
    kind: "photo",
    created_at: iso(NOW - 10_000),
  },
];

function snapshot(overrides: Partial<Game> = {}): GameSnapshot {
  return { game: game(overrides), players, squares: board({ 0: completedBy("player-me", 3) }), media };
}

function record(overrides: Partial<Game> = {}, at = NOW): ActiveGameRecord {
  const made = toActiveGameRecord(snapshot(overrides), "user-me", new Date(at));
  if (!made) throw new Error("fixture game is ended");
  return made;
}

function ended(gameId = GAME_ID, at = NOW - HOUR, consumed = false): LastEndedRecord {
  return { gameId, endedAt: iso(at), consumed };
}

// ---------------------------------------------------------------------------
// A minimal browser for the storage helpers (vitest runs in node).

class MemoryStorage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  getItem(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value));
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  clear() {
    this.data.clear();
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
}

let local: MemoryStorage;
let session: MemoryStorage;
let location: { pathname: string; search: string; href: string; origin: string };

function stubBrowser() {
  local = new MemoryStorage();
  session = new MemoryStorage();
  location = { pathname: "/", search: "", href: "http://app.test/", origin: "http://app.test" };
  vi.stubGlobal("window", {
    localStorage: local,
    sessionStorage: session,
    location,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
}

describe("record shape", () => {
  it("builds a versioned record from a lobby or active snapshot", () => {
    const r = record();
    expect(r).toMatchObject({
      version: 1,
      gameId: GAME_ID,
      joinCode: "ABCD2345",
      name: "Friday night",
      status: "active",
      autoEndAt: iso(NOW + 23 * HOUR),
      expiresAt: iso(NOW + 30 * 24 * HOUR),
      savedAt: iso(NOW),
      userId: "user-me",
    });
    expect(r.snapshot.squares).toHaveLength(25);
    expect(record({ status: "lobby", started_at: null, auto_end_at: null }).status).toBe("lobby");
  });

  it("never builds a record for an ended game, including one past auto_end_at", () => {
    expect(toActiveGameRecord(snapshot({ status: "ended", ended_at: iso(NOW) }), "user-me", new Date(NOW))).toBeNull();
    expect(toActiveGameRecord(snapshot({ auto_end_at: iso(NOW - 1) }), "user-me", new Date(NOW))).toBeNull();
  });

  it("round-trips through JSON and validates every row", () => {
    const r = record();
    expect(parseActiveGame(JSON.parse(JSON.stringify(r)))).toEqual(r);
    expect(isGameSnapshot(r.snapshot, GAME_ID)).toBe(true);
    expect(isGameSnapshot(r.snapshot, "another-game")).toBe(false);
  });

  it("rejects old versions, junk and snapshots that do not belong to the game", () => {
    const r = record();
    const tamper = (fn: (x: Record<string, unknown>) => void) => {
      const copy = JSON.parse(JSON.stringify(r)) as Record<string, unknown>;
      fn(copy);
      return parseActiveGame(copy);
    };
    expect(parseActiveGame(null)).toBeNull();
    expect(parseActiveGame("bingo")).toBeNull();
    expect(parseActiveGame([r])).toBeNull();
    expect(tamper((x) => (x.version = 2))).toBeNull();
    expect(tamper((x) => delete x.gameId)).toBeNull();
    expect(tamper((x) => (x.status = "ended"))).toBeNull();
    expect(tamper((x) => (x.gameId = "another-game"))).toBeNull();
    expect(tamper((x) => ((x.snapshot as GameSnapshot).squares[3].position = 30))).toBeNull();
    expect(tamper((x) => ((x.snapshot as GameSnapshot).players[0].game_id = "another-game"))).toBeNull();
    expect(tamper((x) => ((x.snapshot as GameSnapshot).media = "none" as unknown as Media[]))).toBeNull();
    expect(tamper((x) => ((x.snapshot as { game: unknown }).game = null))).toBeNull();
  });

  it("parses lastEnded strictly", () => {
    expect(parseLastEnded(ended())).toEqual(ended());
    expect(parseLastEnded({ gameId: GAME_ID, endedAt: iso(NOW) })).toBeNull();
    expect(parseLastEnded("x")).toBeNull();
  });
});

describe("rules", () => {
  it("an active record is returnable until auto_end_at and the 30-day expiry", () => {
    const r = record();
    expect(isReturnable(r, NOW)).toBe(true);
    expect(isReturnable(r, NOW + 23 * HOUR - 1)).toBe(true);
    expect(isReturnable(r, NOW + 23 * HOUR)).toBe(false);
    expect(isReturnable(record({ expires_at: iso(NOW - 1) }), NOW)).toBe(false);
  });

  it("a lobby record is returnable for a day after it was last saved", () => {
    const lobby = record({ status: "lobby", started_at: null, auto_end_at: null });
    expect(isReturnable(lobby, NOW + LOBBY_RECORD_MAX_AGE_MS - 1)).toBe(true);
    expect(isReturnable(lobby, NOW + LOBBY_RECORD_MAX_AGE_MS)).toBe(false);
  });

  it("the recap is due once, for a day", () => {
    expect(isRecapDue(ended(GAME_ID, NOW - HOUR), NOW)).toBe(true);
    expect(isRecapDue(ended(GAME_ID, NOW - LAST_ENDED_MAX_AGE_MS), NOW)).toBe(false);
    expect(isRecapDue(ended(GAME_ID, NOW - HOUR, true), NOW)).toBe(false);
    expect(isRecapDue({ gameId: GAME_ID, endedAt: "soon", consumed: false }, NOW)).toBe(false);
  });

  describe("decideOpen", () => {
    const open = (input: Partial<OpenInput>) =>
      decideOpen({ active: null, lastEnded: null, freshOpen: true, stay: false, now: NOW, ...input });

    it("an open jumps to a live board", () => {
      expect(open({ active: record() })).toEqual({ kind: "game", gameId: GAME_ID, via: "active" });
    });

    it("a lobby, a deliberate Home visit or in-app navigation shows home with the Back row", () => {
      const lobby = record({ status: "lobby", started_at: null, auto_end_at: null });
      expect(open({ active: lobby })).toEqual({ kind: "home", back: lobby });
      expect(open({ active: record(), stay: true })).toEqual({ kind: "home", back: record() });
      expect(open({ active: record(), freshOpen: false })).toEqual({ kind: "home", back: record() });
    });

    it("a record past auto_end_at neither jumps nor offers the row", () => {
      expect(open({ active: record(), now: NOW + 24 * HOUR })).toEqual({ kind: "home", back: null });
    });

    it("without a live game, a game seen ending in the last day opens its recap", () => {
      expect(open({ lastEnded: ended() })).toEqual({ kind: "game", gameId: GAME_ID, via: "ended" });
      expect(open({ lastEnded: ended(GAME_ID, NOW - HOUR, true) })).toEqual({ kind: "home", back: null });
      expect(open({ lastEnded: ended(GAME_ID, NOW - 25 * HOUR) })).toEqual({ kind: "home", back: null });
      expect(open({ lastEnded: ended(), stay: true })).toEqual({ kind: "home", back: null });
      expect(open({ lastEnded: ended(), freshOpen: false })).toEqual({ kind: "home", back: null });
    });

    it("a live game wins over an older recap; a record of the game that ended is stale", () => {
      expect(open({ active: record(), lastEnded: ended("old-game") })).toMatchObject({ kind: "game", via: "active" });
      expect(open({ active: record(), lastEnded: ended(GAME_ID) })).toEqual({ kind: "game", gameId: GAME_ID, via: "ended" });
    });
  });
});

describe("storage", () => {
  beforeEach(stubBrowser);
  afterEach(() => {
    noteGameScreenShown(GAME_ID); // reset the per-load suppression
    vi.unstubAllGlobals();
  });

  it("saves, reads back and clears only its own game's record", () => {
    const r = record();
    saveActiveGame(r);
    expect(readActiveGame()).toEqual(r);
    expect(readActiveGameFor(GAME_ID)).toEqual(r);
    expect(readActiveGameFor("another-game")).toBeNull();
    clearActiveGame("another-game");
    expect(readActiveGame()).toEqual(r);
    clearActiveGame(GAME_ID);
    expect(local.getItem(ACTIVE_GAME_KEY)).toBeNull();
  });

  it("ignores (and clears) corrupt stored JSON", () => {
    local.setItem(ACTIVE_GAME_KEY, "{not json");
    expect(readActiveGame()).toBeNull();
    local.setItem(ACTIVE_GAME_KEY, JSON.stringify({ version: 1, gameId: GAME_ID }));
    expect(readActiveGame()).toBeNull();
    clearActiveGame(GAME_ID);
    expect(local.getItem(ACTIVE_GAME_KEY)).toBeNull();
    local.setItem(LAST_ENDED_KEY, "[1,2");
    expect(readLastEnded()).toBeNull();
  });

  it("a game ending clears its record and makes the recap due once", () => {
    saveActiveGame(record());
    noteGameEnded(GAME_ID, new Date(NOW));
    expect(readActiveGame()).toBeNull();
    expect(readLastEnded()).toEqual({ gameId: GAME_ID, endedAt: iso(NOW), consumed: false });
    consumeLastEnded("another-game");
    expect(readLastEnded()?.consumed).toBe(false);
    consumeLastEnded(GAME_ID);
    expect(readLastEnded()?.consumed).toBe(true);
  });

  it("opening the game's screen consumes its due recap", () => {
    noteGameEnded(GAME_ID, new Date(NOW));
    noteGameScreenShown(GAME_ID);
    expect(readLastEnded()?.consumed).toBe(true);
  });

  it("Leave forgets the game, keeps a scheduled save from bringing it back, and stays home", () => {
    const r = record();
    saveActiveGame(r);
    leaveToHome(GAME_ID);
    expect(readActiveGame()).toBeNull();
    saveActiveGame(r); // a debounced save firing after the tap
    expect(readActiveGame()).toBeNull();
    expect(isStayHome()).toBe(true);
    // Back on the game's screen: saving works again.
    noteGameScreenShown(GAME_ID);
    saveActiveGame(r);
    expect(readActiveGame()).toEqual(r);
  });

  it("Home on purpose keeps the record; from the recap it also consumes the due recap", () => {
    saveActiveGame(record());
    goHomeOnPurpose(GAME_ID);
    expect(readActiveGame()).not.toBeNull();
    expect(session.getItem(STAY_HOME_KEY)).toBe("1");
    clearStayHome();
    expect(isStayHome()).toBe(false);
    noteGameEnded(GAME_ID, new Date(NOW));
    goHomeOnPurpose(GAME_ID, { ended: true });
    expect(readLastEnded()?.consumed).toBe(true);
    expect(isStayHome()).toBe(true);
  });

  it("?stay=1 also means stay", () => {
    expect(isStayHome("?stay=1")).toBe(true);
    expect(isStayHome("?x=1")).toBe(false);
  });

  it("an open is a page load that started at / (and has not shown a game yet)", async () => {
    vi.resetModules(); // a fresh page load: nothing shown yet
    const fresh = await import("@/lib/game/activeGame");
    vi.stubGlobal("performance", { getEntriesByType: () => [{ name: "http://app.test/" }] });
    expect(fresh.isFreshOpen()).toBe(true);
    fresh.noteGameScreenShown(GAME_ID);
    expect(fresh.isFreshOpen()).toBe(false);

    vi.resetModules();
    const elsewhere = await import("@/lib/game/activeGame");
    vi.stubGlobal("performance", { getEntriesByType: () => [{ name: "http://app.test/g/ABCD2345" }] });
    expect(elsewhere.isFreshOpen()).toBe(false);
    // The module this file imported has shown a game already.
    expect(isFreshOpen()).toBe(false);
  });
});

describe("home guard script", () => {
  function runGuard(items: Record<string, string>): string | undefined {
    const style: { visibility?: string } = {};
    const storage = { getItem: (k: string) => (k in items ? items[k] : null) };
    runInNewContext(HOME_GUARD_SCRIPT, {
      document: { currentScript: { parentElement: { style } } },
      localStorage: storage,
      JSON,
    });
    return style.visibility;
  }

  it("hides home before paint when there is a game record or a recap due", () => {
    expect(runGuard({ [ACTIVE_GAME_KEY]: JSON.stringify(record()) })).toBe("hidden");
    expect(runGuard({ [LAST_ENDED_KEY]: JSON.stringify(ended()) })).toBe("hidden");
  });

  it("leaves home alone otherwise, and never throws on junk", () => {
    expect(runGuard({})).toBeUndefined();
    expect(runGuard({ [LAST_ENDED_KEY]: JSON.stringify(ended(GAME_ID, NOW, true)) })).toBeUndefined();
    expect(runGuard({ [LAST_ENDED_KEY]: "{oops" })).toBeUndefined();
    expect(() => runInNewContext(HOME_GUARD_SCRIPT, { document: {}, JSON })).not.toThrow();
  });
});
