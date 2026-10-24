import { describe, expect, it } from "vitest";
import { createdRematch, lateJoin, rematchKind, type NextGameInfo } from "@/components/recap/rematch";

const pointer = { nextGameId: "g2", nextCode: "ABCDEFGH" };
const info = (over: Partial<NextGameInfo> = {}): NextGameInfo => ({
  id: "g2",
  readable: false,
  hostUserId: null,
  status: "lobby",
  ...over,
});

describe("rematchKind", () => {
  it("offers Play again while the old game points nowhere", () => {
    expect(rematchKind({ nextGameId: null, nextCode: null }, null)).toBe("play");
    expect(rematchKind({ nextGameId: "g2", nextCode: null }, null)).toBe("play");
    expect(rematchKind({ nextGameId: null, nextCode: "ABCDEFGH" }, info())).toBe("play");
  });

  it("shows nothing while the rematch is still being looked up (or the answer is for an older pointer)", () => {
    expect(rematchKind(pointer, null)).toBe("none");
    expect(rematchKind(pointer, info({ id: "g1" }))).toBe("none");
  });

  it("joins an open rematch this phone is not in, and goes to one it is in", () => {
    expect(rematchKind(pointer, info())).toBe("join");
    expect(rematchKind(pointer, info({ status: "active" }))).toBe("join");
    expect(rematchKind(pointer, info({ readable: true, hostUserId: "u1" }))).toBe("go");
    expect(rematchKind(pointer, info({ readable: true, status: "active" }))).toBe("go");
  });

  it("shows nothing once the rematch has ended, whether readable or not", () => {
    expect(rematchKind(pointer, info({ status: "ended" }))).toBe("none");
    expect(rematchKind(pointer, info({ status: "ended", readable: true, hostUserId: "u1" }))).toBe("none");
  });

  it("still offers Join when the status lookup failed (join_game decides)", () => {
    expect(rematchKind(pointer, info({ status: null }))).toBe("join");
  });
});

describe("createdRematch", () => {
  const returned = (host: string) => ({ id: "g2", host_user_id: host });

  it("counts play_again only when this call created the rematch", () => {
    expect(createdRematch({ knownNextGameId: null, returned: returned("me"), myUserId: "me" })).toBe(true);
  });

  it("does not count losing the race to someone else's rematch", () => {
    expect(createdRematch({ knownNextGameId: null, returned: returned("them"), myUserId: "me" })).toBe(false);
  });

  it("does not count getting an already-known rematch back, even this phone's own", () => {
    expect(createdRematch({ knownNextGameId: "g2", returned: returned("me"), myUserId: "me" })).toBe(false);
    expect(createdRematch({ knownNextGameId: "g2", returned: returned("them"), myUserId: "me" })).toBe(false);
  });
});

describe("lateJoin", () => {
  it("is a late join only into a live rematch", () => {
    expect(lateJoin("active")).toBe(true);
    expect(lateJoin("lobby")).toBe(false);
    expect(lateJoin(null)).toBe(false);
  });
});
