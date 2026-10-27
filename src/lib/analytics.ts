// Lightweight product analytics (PostHog free tier). No personal data: no names,
// join codes, game/user ids, square text, URLs or free text ever leave the device.
//
// - Off (every call a no-op, `posthog-js` never imported) unless NEXT_PUBLIC_POSTHOG_KEY is
//   set, and off for browsers that send Do Not Track or Global Privacy Control.
// - `posthog-js` is loaded lazily (dynamic import) on first use, in the browser only.
// - Only the events and properties in `EVENT_SCHEMA` are sent; anything else is dropped here
//   and again inside PostHog (`sanitize_properties` + `before_send`), which also strip the
//   SDK's own URL / referrer / title / person properties.
// - No cookies or localStorage identifiers (`persistence: "memory"`): a fresh anonymous id
//   per page load. `identify` is never called.

import type { PostHog, PostHogConfig, CaptureResult, Properties } from "posthog-js";

export type AnalyticsEvent =
  | "game_created"
  | "player_joined"
  | "game_started"
  | "square_completed"
  | "media_uploaded"
  | "game_ended"
  | "recap_viewed"
  | "play_again";

export type AnalyticsProps = Record<string, string | number | boolean>;

type PropRule =
  | { type: "boolean" }
  /** A non-negative count / duration, rounded to a whole number. */
  | { type: "count" }
  | { type: "enum"; values: readonly string[] };

const bool = { type: "boolean" } as const;
const count = { type: "count" } as const;
const oneOf = (...values: string[]): PropRule => ({ type: "enum", values });

/** The only events and properties that may ever be sent. */
export const EVENT_SCHEMA: Readonly<Record<AnalyticsEvent, Readonly<Record<string, PropRule>>>> = {
  game_created: { pack: oneOf("night-out", "day-adventure", "blank"), free_center: bool },
  player_joined: { late_join: bool },
  game_started: { player_count: count, counter_squares: count },
  square_completed: { counter: bool, total_completed: count },
  media_uploaded: { kind: oneOf("photo", "video") },
  game_ended: {
    squares_completed: count,
    lines: count,
    blackout: bool,
    duration_min: count,
    player_count: count,
    // host: end_game; auto: the deadline passed; blackout: the 25th square ended it on the server.
    by: oneOf("host", "auto", "blackout"),
  },
  recap_viewed: { media_count: count },
  play_again: { source: oneOf("recap") },
};

/**
 * Properties PostHog itself adds that may stay: what ingestion needs (token, the per-page-load
 * anonymous id, library, timestamps) and coarse device info. Everything else the SDK adds
 * (`$current_url`, `$pathname`, `$host`, `$referrer`, `$referring_domain`, `$initial_*`,
 * `title`, user agent, language, time zone, session ids, ...) is deleted.
 */
const SDK_KEYS: ReadonlySet<string> = new Set([
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

export function isAnalyticsEvent(event: unknown): event is AnalyticsEvent {
  return typeof event === "string" && Object.prototype.hasOwnProperty.call(EVENT_SCHEMA, event);
}

function cleanValue(rule: PropRule, value: unknown): string | number | boolean | undefined {
  switch (rule.type) {
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "count":
      return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
    case "enum":
      return typeof value === "string" && rule.values.includes(value) ? value : undefined;
  }
}

/**
 * The event's own properties, reduced to its allow-list with valid values. `null` for an
 * event that is not on the list (it must not be sent at all).
 */
export function sanitizeEventProps(event: string, props: unknown): AnalyticsProps | null {
  if (!isAnalyticsEvent(event)) return null;
  const schema = EVENT_SCHEMA[event];
  const out: AnalyticsProps = {};
  if (props === null || typeof props !== "object") return out;
  for (const [key, rule] of Object.entries(schema)) {
    if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
    const value = cleanValue(rule, (props as Record<string, unknown>)[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Everything PostHog is about to send for one event: the SDK keys on `SDK_KEYS` plus the
 * event's allow-listed props; the rest is removed. Unknown events (incl. PostHog's own
 * `$pageview`, `$set_once`, ...) come back empty.
 */
export function sanitizeOutgoingProperties(properties: Properties, event: string): Properties {
  const own = sanitizeEventProps(event, properties);
  if (own === null) return {};
  const out: Properties = {};
  for (const key of Object.keys(properties)) {
    if (SDK_KEYS.has(key)) out[key] = properties[key];
  }
  return { ...out, ...own };
}

/** Last line of defence: drop any event that is not ours and strip person properties. */
export function beforeSend(result: CaptureResult | null): CaptureResult | null {
  if (!result || !isAnalyticsEvent(result.event)) return null;
  const clean: CaptureResult = { ...result, properties: sanitizeOutgoingProperties(result.properties ?? {}, result.event) };
  delete clean.$set;
  delete clean.$set_once;
  return clean;
}

const DEFAULT_HOST = "https://us.i.posthog.com";

/** Read at call time (Next inlines the NEXT_PUBLIC_ values into the client bundle). */
function analyticsKey(): string | null {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim();
  return key ? key : null;
}

function analyticsHost(): string {
  return process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim() || DEFAULT_HOST;
}

type PrivacyNavigator = { doNotTrack?: string | null; globalPrivacyControl?: boolean };

function optedOut(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & PrivacyNavigator;
  return nav.doNotTrack === "1" || nav.globalPrivacyControl === true;
}

/** True when events would be sent: in a browser, with a key, and no DNT / GPC signal. */
export function analyticsEnabled(): boolean {
  return typeof window !== "undefined" && analyticsKey() !== null && !optedOut();
}

/** The PostHog options (exported for the unit test that freezes them). */
export function posthogOptions(): Partial<PostHogConfig> {
  return {
    api_host: analyticsHost(),
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_surveys_automatic_display: true,
    disable_product_tours: true,
    disable_conversations: true,
    disable_web_experiments: true,
    disable_external_dependency_loading: true,
    advanced_disable_flags: true,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    capture_exceptions: false,
    capture_performance: false,
    rageclick: false,
    save_referrer: false,
    save_campaign_params: false,
    disable_scroll_properties: true,
    mask_personal_data_properties: true,
    persistence: "memory",
    person_profiles: "identified_only",
    respect_dnt: true,
    sanitize_properties: sanitizeOutgoingProperties,
    before_send: beforeSend,
  };
}

type Queued = { event: AnalyticsEvent; props: AnalyticsProps };
const MAX_QUEUED = 50;

let client: PostHog | null = null;
let loading: Promise<void> | null = null;
let queued: Queued[] = [];

/**
 * Loads and starts PostHog once (no-op when analytics is off). Events tracked before it is
 * ready wait in memory and go out once it is.
 */
export function initAnalytics(): Promise<void> {
  if (!analyticsEnabled()) return Promise.resolve();
  if (loading) return loading;
  const key = analyticsKey()!;
  loading = import("posthog-js")
    .then((mod) => {
      const posthog = mod.default;
      posthog.init(key, posthogOptions());
      client = posthog;
      const pending = queued;
      queued = [];
      for (const { event, props } of pending) posthog.capture(event, props);
    })
    .catch(() => {
      // Analytics must never break the app (e.g. the chunk failed to load offline): stay quiet,
      // allow a later attempt.
      loading = null;
    });
  return loading;
}

/**
 * Records one product event with only its allow-listed properties. Fire-and-forget; call it
 * after the action succeeded. A no-op when analytics is off or the event is unknown.
 */
export function track(event: AnalyticsEvent, props?: AnalyticsProps): void {
  if (!analyticsEnabled()) return;
  const clean = sanitizeEventProps(event, props ?? {});
  if (clean === null) return;
  try {
    if (client) {
      client.capture(event, clean);
      return;
    }
    if (queued.length < MAX_QUEUED) queued.push({ event, props: clean });
    void initAnalytics();
  } catch {
    // Never let analytics throw into a game action.
  }
}

/** Test-only: forget the loaded client and anything queued. */
export function __resetAnalyticsForTests(): void {
  client = null;
  loading = null;
  queued = [];
}
