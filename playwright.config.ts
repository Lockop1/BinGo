import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against `npm run dev` (which reads .env.local; locally that
 * points at the stand-in backend from `npm run backend:start`).
 * Chromium only; browsers come from PLAYWRIGHT_BROWSERS_PATH (preinstalled).
 */
export default defineConfig({
  testDir: "./e2e",
  // Kept inside a gitignored directory so runs leave the tree clean.
  outputDir: "node_modules/.cache/playwright-results",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3000",
    viewport: { width: 375, height: 812 },
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 } },
    },
  ],
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3000",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
