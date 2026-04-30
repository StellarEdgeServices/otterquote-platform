import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '.env.test') });

const BASE_URL =
  process.env.BASE_URL || 'https://staging--jade-alpaca-b82b5e.netlify.app';

export default defineConfig({
  testDir: './flows',
  timeout: 60_000,
  expect: { timeout: 15_000 },

  // Re-run each test up to 2 times on failure before marking it flaky
  retries: 2,

  // Run tests serially — test accounts share DB state
  workers: 1,
  fullyParallel: false,

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],

  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
