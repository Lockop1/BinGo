"use client";

import { useEffect, type ReactNode } from "react";
import { initAnalytics } from "@/lib/analytics";

/**
 * Starts product analytics once on mount (see lib/analytics.ts). Without
 * NEXT_PUBLIC_POSTHOG_KEY, or with Do Not Track / Global Privacy Control on,
 * it does nothing and `posthog-js` is never loaded. Renders children unchanged.
 */
export function AnalyticsProvider({ children }: { children?: ReactNode }) {
  useEffect(() => {
    void initAnalytics();
  }, []);
  return <>{children}</>;
}
