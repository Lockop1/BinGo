import { defineConfig, devices } from "@playwright/test";

// Overridable so a second dev server (e.g. port 3200) can be tested next to the default one.
const port = process.env.E2E_PORT ?? "3000";
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${port}`;

/**
 * End-to-end tests against `npm run dev` (which reads .env.local; locally that
 * points at the stand-in backend from `npm run backend:start`).
 * Chromium only; browsers come from PLAYWRIGHT_BROWSERS_PATH (preinstalled).
 */
export default defineConfig({
  testDir: "./e2e",
  // Fails fast if the local backend is down or its schema drifted from supabase/migrations.
  globalSetup: "./e2e/global-setup.ts",
  // Kept inside a gitignored directory so runs leave the tree clean.
  outputDir: "node_modules/.cache/playwright-results",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL,
    viewport: { width: 375, height: 812 },
    // The app-shell service worker (public/sw.js) must run; e2e/pwa.spec.ts tests it.
    serviceWorkers: "allow",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 } },
    },
  ],
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
    // Fast resync poll so cross-phone changes show up without Realtime events
    // (the local backend's Realtime stub never delivers any). Code default: 15000.
    // NEXT_PUBLIC_ENABLE_SW=1 registers the service worker in dev too, so every spec runs
    // with it (it never caches API / Supabase calls).
    env: { NEXT_PUBLIC_SYNC_POLL_MS: "1500", NEXT_PUBLIC_ENABLE_SW: "1" },
  },
});
