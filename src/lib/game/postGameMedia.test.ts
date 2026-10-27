import { describe, expect, it } from "vitest";
import { POST_GAME_MEDIA_GRACE_MS, gameEndedAt, mediaGate, ownCompletedSquares } from "@/lib/game/postGameMedia";

const NOW = Date.parse("2026-10-27T23:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

const live = {
  status: "active" as const,
  deadline_at: iso(NOW + 60 * MIN),
  ended_at: null,
  expires_at: iso(NOW + 30 * 24 * 60 * MIN),
};
const endedAgo = (ms: number) => ({ ...live, status: "ended" as const, ended_at: iso(NOW - ms) });
const mine = { completed_at: iso(NOW - 90 * MIN), completed_by_player_id: "me" };
const jakes = { completed_at: iso(NOW - 90 * MIN), completed_by_player_id: "jake" };
const free = { completed_at: iso(NOW - 120 * MIN), completed_by_player_id: null };
const open = { completed_at: null, completed_by_player_id: null };
const at = new Date(NOW);

describe("mediaGate", () => {
  it("live: any completed square, by anyone", () => {
    expect(mediaGate(live, mine, "me", at)).toBe("ok");
    expect(mediaGate(live, jakes, "me", at)).toBe("ok");
    expect(mediaGate(live, free, "me", at)).toBe("ok");
    expect(mediaGate(live, open, "me", at)).toBe("not_done");
    expect(mediaGate({ ...live, status: "lobby" }, mine, "me", at)).toBe("lobby");
  });

  it("after the end: own squares always, others only within the 10-minute grace", () => {
    expect(mediaGate(endedAgo(MIN), jakes, "me", at)).toBe("ok");
    expect(mediaGate(endedAgo(POST_GAME_MEDIA_GRACE_MS), jakes, "me", at)).toBe("ok");
    expect(mediaGate(endedAgo(POST_GAME_MEDIA_GRACE_MS + 1), jakes, "me", at)).toBe("not_yours");
    expect(mediaGate(endedAgo(POST_GAME_MEDIA_GRACE_MS + 1), free, "me", at)).toBe("not_yours");
    expect(mediaGate(endedAgo(5 * 24 * 60 * MIN), mine, "me", at)).toBe("ok");
    expect(mediaGate(endedAgo(5 * 24 * 60 * MIN), jakes, null, at)).toBe("not_yours");
  });

  it("a live game past its deadline counts as ended at the deadline", () => {
    const overdue = { ...live, deadline_at: iso(NOW - 11 * MIN) };
    expect(gameEndedAt(overdue, at)).toBe(iso(NOW - 11 * MIN));
    expect(mediaGate(overdue, jakes, "me", at)).toBe("not_yours");
    expect(mediaGate({ ...overdue, deadline_at: iso(NOW - 9 * MIN) }, jakes, "me", at)).toBe("ok");
    expect(mediaGate(overdue, mine, "me", at)).toBe("ok");
    expect(gameEndedAt(live, at)).toBeNull();
  });

  it("past the album expiry nothing goes", () => {
    expect(mediaGate({ ...endedAgo(MIN), expires_at: iso(NOW) }, mine, "me", at)).toBe("expired");
  });
});

describe("ownCompletedSquares", () => {
  it("lists what this player crossed off, in board order", () => {
    const squares = [
      { position: 7, ...mine },
      { position: 2, ...mine },
      { position: 3, ...jakes },
      { position: 12, ...free },
      { position: 4, ...open },
    ];
    expect(ownCompletedSquares(squares, "me").map((s) => s.position)).toEqual([2, 7]);
    expect(ownCompletedSquares(squares, null)).toEqual([]);
  });
});
