/**
 * 5-Page Revenue-Path Smoke Check (gh-1261, D-... CEO ruling 2026-08-26: `strip`).
 *
 * Deliberately independent of ../playwright.config.ts: that config points
 * baseURL at BASE_URL (staging/prod) and drives the full authenticated
 * flows/ suite. This one serves the site locally with a plain static file
 * server so the smoke gate never depends on staging being up, and stays
 * fast enough to run on every PR without seeded test-project fixtures.
 */
import { defineConfig, devices } from '@playwright/test';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: __dirname,
  timeout: 15_000,
  expect: { timeout: 5_000 },
  retries: 0,
  workers: 5,
  fullyParallel: true,
  reporter: [['list']],

  use: {
    baseURL: BASE_URL,
    headless: true,
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
  },

  // Repo root is three levels up from tests/e2e/smoke/. Playwright runs
  // webServer.command with this config file's directory as cwd.
  webServer: {
    command: `python3 -m http.server ${PORT} --directory ../../..`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--no-sandbox', '--disable-dev-shm-usage'],
        },
      },
    },
  ],
});
