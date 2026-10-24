// Lightweight product analytics (PostHog free tier). No personal data: no names,
// join codes, user ids, URLs or free text ever leave the device. `track()` is a
// no-op until the provider initialises with NEXT_PUBLIC_POSTHOG_KEY.

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

// Stub: replaced by the analytics implementation. Keep the signature.
export function track(_event: AnalyticsEvent, _props?: AnalyticsProps): void {
  void _event;
  void _props;
}
