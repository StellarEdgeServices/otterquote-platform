import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '.env.test') });
const BASE_URL = process.env.BASE_URL || 'https://staging--jade-alpaca-b82b5e.netlify.app';

/**
 * Sandbox-specific Playwright config for running E2E tests in the Cowork bash sandbox.
 *
 * Key differences from playwright.config.ts:
 *   - timeout: 35_000 (sandbox 45s limit; A8 form submission needs ~20s)
 *   - retries: 0 (faster iteration; use main config for stability runs)
 *   - reporter: dot only (html reporter hangs on Windows bindfs mount)
 *   - launchOptions: --no-sandbox required for sandboxed Linux environments
 *
 * Usage: run from /tmp/e2e/ (NOT from the Windows mount -- Playwright hangs on bindfs paths)
 *   rsync -a --exclude node_modules --exclude playwright-report tests/e2e/ /tmp/e2e/
 *   cd /tmp/e2e && npm ci && node seed/seed.mjs
 *   npx playwright test --config=pw-sandbox.config.ts
 */
export default defineConfig({
  testDir: './flows',
  timeout: 35_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['dot']],
  use: {
    baseURL: BASE_URL,
    headless: true,
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      launchOptions: {
        // Required for sandboxed Linux environments (Cowork bash sandbox, CI containers)
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      },
    },
  }],
});
