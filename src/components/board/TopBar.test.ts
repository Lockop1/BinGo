import { describe, expect, it } from "vitest";
import { syncMarkFor } from "@/components/board/TopBar";

const base = { syncState: "live" as const, online: true, pendingCount: 0, syncingLong: false };

describe("syncMarkFor", () => {
  it("shows nothing when live", () => {
    expect(syncMarkFor(base)).toBe("none");
  });

  it("shows the soft dot only once syncing has lasted past the delay", () => {
    expect(syncMarkFor({ ...base, syncState: "syncing" })).toBe("none");
    expect(syncMarkFor({ ...base, syncState: "syncing", syncingLong: true })).toBe("syncing");
  });

  it("shows offline when the last resync failed or the browser is offline", () => {
    expect(syncMarkFor({ ...base, syncState: "offline" })).toBe("offline");
    expect(syncMarkFor({ ...base, online: false })).toBe("offline");
    expect(syncMarkFor({ ...base, syncState: "syncing", syncingLong: true, online: false })).toBe("offline");
    expect(syncMarkFor({ ...base, syncState: "offline", pendingCount: 2 })).toBe("offline");
  });

  it("waiting taps show as sending, over the syncing dot", () => {
    expect(syncMarkFor({ ...base, pendingCount: 1 })).toBe("pending");
    expect(syncMarkFor({ ...base, pendingCount: 1, syncState: "syncing", syncingLong: true })).toBe("pending");
  });
});
