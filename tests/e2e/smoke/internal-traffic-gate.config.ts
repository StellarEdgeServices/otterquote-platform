/**
 * Internal-Traffic Opt-Out Gate — regression config (gh-2064 round 2).
 *
 * Deliberately its own config, separate from playwright.smoke.config.ts:
 * that config's projects use no special Chromium launch args, and this
 * spec needs `--host-resolver-rules` (see internal-traffic-gate.spec.ts's
 * module docstring for why: js/ga-gate.js / js/meta-pixel-gate.js only run
 * their real code path on an ALLOWED_HOSTS hostname, never on
 * 127.0.0.1/localhost). Serves the site locally with the same plain static
 * file server pattern as playwright.smoke.config.ts, on a different port so
 * the two can run concurrently without colliding, then maps
 * otterquote.com -> 127.0.0.1 for Chromium's DNS resolution only (nothing
 * external is contacted; the tracking-host requests this spec watches for
 * are asserted via Playwright's own request listener, which sees the
 * attempt before the network layer would actually resolve
 * googletagmanager.com/connect.facebook.net/clarity.ms -- none of those
 * need to succeed, or even be reachable, for this test to be meaningful).
 */
import { defineConfig, devices } from '@playwright/test';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 4174;
const BASE_URL = `http://otterquote.com:${PORT}`;

export default defineConfig({
  testDir: __dirname,
  testMatch: 'internal-traffic-gate.spec.ts',
  timeout: 15_000,
  expect: { timeout: 5_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],

  use: {
    baseURL: BASE_URL,
    headless: true,
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
  },

  // Repo root is three levels up from tests/e2e/smoke/, same as
  // playwright.smoke.config.ts.
  webServer: {
    command: `python3 -m http.server ${PORT} --directory ../../..`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          // This sandbox's Playwright browser cache only has the full
          // Chromium build, not the separate headless-shell binary Playwright
          // defaults to since v1.45 -- point at it explicitly rather than
          // depend on the environment shipping both.
          executablePath: process.env.PW_CHROMIUM_PATH || undefined,
          args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            // Makes window.location.hostname === 'otterquote.com' resolve to
            // this local server, so both gates' ALLOWED_HOSTS check passes
            // and their real gtag.js/fbevents.js/Clarity load path runs
            // instead of bailing out on host mismatch (which would make
            // this test pass for the wrong reason).
            `--host-resolver-rules=MAP otterquote.com 127.0.0.1`,
          ],
        },
      },
    },
  ],
});
