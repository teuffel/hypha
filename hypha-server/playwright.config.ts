/**
 * Playwright config for the headless-auth smoke test.
 *
 * This config is intentionally minimal — Playwright is used here as a single
 * end-to-end smoke gate, NOT as a general E2E framework. See
 * hypha-server/test/headless-auth.spec.ts for the test surface.
 *
 * The test self-bootstraps the hypha-server + a mock /sync upstream inside a
 * Playwright globalSetup hook (see test/playwright/global-setup.ts), so we do
 * not declare a `webServer` block here.
 *
 * Browser install is operator-driven via:
 *   pnpm --dir hypha-server test:install-browsers
 * before the first run. CI installs as part of the workflow.
 */

import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  testDir: resolve(here, "test", "playwright"),
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  globalSetup: resolve(here, "test", "playwright", "global-setup.ts"),
  globalTeardown: resolve(here, "test", "playwright", "global-teardown.ts"),
  use: {
    // baseURL is injected via the BASE_URL env var by global-setup.
    baseURL: process.env.HYPHA_BASE_URL,
    headless: true,
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
