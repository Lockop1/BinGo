import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for posthog-js: counts how often the module is loaded, records init / capture.
const ph = vi.hoisted(() => ({ imports: 0, init: vi.fn(), capture: vi.fn(), identify: vi.fn() }));
vi.mock("posthog-js", () => {
  ph.imports++;
  return { default: { init: ph.init, capture: ph.capture, identify: ph.identify } };
});

import {
  EVENT_SCHEMA,
  __resetAnalyticsForTests,
  analyticsEnabled,
  beforeSend,
  initAnalytics,
  posthogOptions,
  sanitizeEventProps,
  sanitizeOutgoingProperties,
  track,
  type AnalyticsEvent,
} from "@/lib/analytics";

function browser(nav: Record<string, unknown> = {}) {
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", nav);
}

/** Lets the dynamic import and its `.then` run. */
async function settle() {
  await initAnalytics();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  __resetAnalyticsForTests();
  ph.init.mockClear();
  ph.capture.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("sanitizeEventProps", () => {
  it("keeps only the allow-listed props with valid values", () => {
    expect(
      sanitizeEventProps("game_created", {
        pack: "night-out",
        free_center: true,
        name: "Friday on Main St",
        join_code: "ABCD2345",
      }),
    ).toEqual({ pack: "night-out", free_center: true });
  });

  it("drops values of the wrong type or outside the enum", () => {
    expect(sanitizeEventProps("game_created", { pack: "my custom pack", free_center: "yes" })).toEqual({});
    expect(sanitizeEventProps("media_uploaded", { kind: "audio" })).toEqual({});
    expect(sanitizeEventProps("game_ended", { by: "someone", lines: -1, squares_completed: Number.NaN })).toEqual({});
    expect(sanitizeEventProps("play_again", { source: "home" })).toEqual({});
  });

  it("rounds counts to whole numbers", () => {
    expect(sanitizeEventProps("game_ended", { duration_min: 92.6, lines: 2 })).toEqual({ duration_min: 93, lines: 2 });
  });

  it("rejects unknown events", () => {
    expect(sanitizeEventProps("$pageview", {})).toBeNull();
    expect(sanitizeEventProps("game_renamed", { name: "x" })).toBeNull();
    expect(sanitizeEventProps("toString", {})).toBeNull();
  });

  it("has an allow-list for every event and no free-text props", () => {
    const events: AnalyticsEvent[] = [
      "game_created",
      "player_joined",
      "game_started",
      "square_completed",
      "media_uploaded",
      "game_ended",
      "recap_viewed",
      "play_again",
    ];
    expect(Object.keys(EVENT_SCHEMA).sort()).toEqual([...events].sort());
    for (const schema of Object.values(EVENT_SCHEMA)) {
      for (const rule of Object.values(schema)) expect(["boolean", "count", "enum"]).toContain(rule.type);
    }
  });
});

describe("outgoing PostHog payload", () => {
  const sdkProps = {
    token: "phc_test",
    distinct_id: "0192-anon",
    $lib: "web",
    $lib_version: "1.0.0",
    $os: "Android",
    $browser: "Chrome",
    $device_type: "Mobile",
    $screen_width: 375,
    $current_url: "https://bingo.example/game/1b6c4e1a-0000-4000-8000-000000000000",
    $pathname: "/g/ABCD2345",
    $host: "bingo.example",
    $referrer: "https://chat.example/thread",
    $referring_domain: "chat.example",
    $initial_current_url: "https://bingo.example/g/ABCD2345",
    $initial_referrer: "$direct",
    title: "Friday on Main St",
    $raw_user_agent: "Mozilla/5.0",
    $session_id: "s",
    $timezone: "America/New_York",
  };

  it("strips URLs, referrers, title and anything not allow-listed", () => {
    const out = sanitizeOutgoingProperties({ ...sdkProps, late_join: true, display_name: "Jake" }, "player_joined");
    expect(out).toEqual({
      token: "phc_test",
      distinct_id: "0192-anon",
      $lib: "web",
      $lib_version: "1.0.0",
      $os: "Android",
      $browser: "Chrome",
      $device_type: "Mobile",
      $screen_width: 375,
      late_join: true,
    });
  });

  it("sends nothing for PostHog's own events", () => {
    expect(sanitizeOutgoingProperties(sdkProps, "$pageview")).toEqual({});
    expect(sanitizeOutgoingProperties({ $initial_current_url: "x" }, "$set_once")).toEqual({});
  });

  it("before_send drops unknown events and person properties", () => {
    expect(beforeSend({ uuid: "u", event: "$pageview", properties: sdkProps })).toBeNull();
    expect(beforeSend(null)).toBeNull();
    const kept = beforeSend({
      uuid: "u",
      event: "media_uploaded",
      properties: { ...sdkProps, kind: "photo", storage_path: "g/1/x.jpg" },
      $set: { name: "Jake" },
      $set_once: { $initial_current_url: "https://bingo.example/g/ABCD2345" },
    });
    expect(kept?.properties).toMatchObject({ kind: "photo" });
    expect(JSON.stringify(kept)).not.toMatch(/ABCD2345|Jake|\/game\/|\/g\/|storage_path|bingo\.example/);
    expect(kept).not.toHaveProperty("$set");
    expect(kept).not.toHaveProperty("$set_once");
  });
});

// Order matters: the "off" cases run before anything loads the mocked module.
describe("when analytics is off", () => {
  it("never imports posthog-js without a key", async () => {
    browser();
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
    expect(analyticsEnabled()).toBe(false);
    track("game_created", { pack: "blank", free_center: false });
    await settle();
    expect(ph.imports).toBe(0);
    expect(ph.init).not.toHaveBeenCalled();
  });

  it("is a no-op with Do Not Track", async () => {
    browser({ doNotTrack: "1" });
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    expect(analyticsEnabled()).toBe(false);
    track("player_joined", { late_join: false });
    await settle();
    expect(ph.imports).toBe(0);
  });

  it("is a no-op with Global Privacy Control", async () => {
    browser({ globalPrivacyControl: true });
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    expect(analyticsEnabled()).toBe(false);
    track("player_joined", { late_join: false });
    await settle();
    expect(ph.imports).toBe(0);
  });

  it("is a no-op outside the browser", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    vi.stubGlobal("window", undefined);
    expect(analyticsEnabled()).toBe(false);
    track("player_joined", { late_join: false });
    await settle();
    expect(ph.imports).toBe(0);
  });
});

describe("with a key", () => {
  beforeEach(() => {
    browser({ doNotTrack: "unspecified", globalPrivacyControl: false });
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
  });

  it("initialises once with the privacy options frozen", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://eu.i.posthog.com");
    expect(analyticsEnabled()).toBe(true);
    await Promise.all([initAnalytics(), initAnalytics()]);
    expect(ph.imports).toBe(1);
    expect(ph.init).toHaveBeenCalledTimes(1);
    const [key, options] = ph.init.mock.calls[0];
    expect(key).toBe("phc_test");
    expect(options).toMatchObject({
      api_host: "https://eu.i.posthog.com",
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      disable_surveys: true,
      persistence: "memory",
      person_profiles: "identified_only",
    });
    expect(typeof options.sanitize_properties).toBe("function");
    expect(typeof options.before_send).toBe("function");
  });

  it("defaults the host to PostHog US", () => {
    expect(posthogOptions().api_host).toBe("https://us.i.posthog.com");
  });

  it("queues events until loaded, then sends only allow-listed props", async () => {
    track("game_started", { player_count: 4, counter_squares: 1, game_id: "secret" } as never);
    track("nope" as AnalyticsEvent, { x: 1 });
    expect(ph.capture).not.toHaveBeenCalled();
    await settle();
    expect(ph.capture).toHaveBeenCalledTimes(1);
    expect(ph.capture).toHaveBeenCalledWith("game_started", { player_count: 4, counter_squares: 1 });

    track("square_completed", { counter: false, total_completed: 3, label: "Skyline Chili" });
    expect(ph.capture).toHaveBeenLastCalledWith("square_completed", { counter: false, total_completed: 3 });
  });

  it("never calls identify", async () => {
    track("play_again", { source: "recap" });
    await settle();
    expect(ph.capture).toHaveBeenCalledWith("play_again", { source: "recap" });
    expect(ph.identify).not.toHaveBeenCalled();
  });
});
