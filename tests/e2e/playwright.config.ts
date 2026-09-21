import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '.env.test') });

const BASE_URL =
  process.env.BASE_URL || 'https://staging--jade-alpaca-b82b5e.netlify.app';

// gh-2064: BASE_URL defaults to staging (already outside js/ga-gate.js's/
// GA4Gate's ALLOWED_HOSTS, so no GA4/Meta/Clarity load there today), but can
// be pointed at production (BASE_URL=https://otterquote.com) for a manual
// run. Pre-seeding the oq_internal cookie via storageState means that run
// is never counted as a visitor either -- harmless no-op when BASE_URL is
// staging, since a `.otterquote.com`-scoped cookie is never sent to a
// *.netlify.app origin.
const INTERNAL_TRAFFIC_STORAGE_STATE = {
  cookies: [
    {
      name: 'oq_internal',
      value: '1',
      domain: '.otterquote.com',
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365,
      httpOnly: false,
      secure: true,
      sameSite: 'Lax' as const,
    },
  ],
  origins: [],
};

export default defineConfig({
  testDir: './flows',
  timeout: 60_000,
  expect: { timeout: 15_000 },

  // Re-run each test up to 2 times on failure before marking it flaky
  retries: 2,

  // Run tests serially -- test accounts share DB state
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
    // gh-2064: opt this suite out of GA4/Meta/Clarity counting whenever it
    // runs against production.
    storageState: INTERNAL_TRAFFIC_STORAGE_STATE,
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          // Required for sandboxed Linux environments (Cowork bash sandbox, CI containers)
          args: ['--no-sandbox', '--disable-dev-shm-usage'],
        },
      },
    },
  ],
});
