/**
 * Entry-Point Reachability Spec — LIVE run (gh-1697 Part 2).
 *
 * Runs the exact same spec as playwright.smoke.config.ts
 * (entry-point-reachability.spec.ts, unchanged) against the deployed site
 * instead of a local static server. Part 1 (playwright.smoke.config.ts, run
 * pre-merge in e2e-smoke.yml) proves the CODE is operable; this proves the
 * bytes Netlify actually served are. See .github/workflows/
 * entry-point-reachability-live.yml for the deployment_status trigger.
 *
 * baseURL defaults to production (https://otterquote.com) and can be
 * overridden via the LIVE_BASE_URL env var (e.g. to point at a preview
 * deploy's URL from the deployment_status payload).
 *
 * admin-payouts.html is excluded here (grepInvert) -- verified empirically
 * (curl -L https://otterquote.com/admin-payouts.html -> 200 from
 * /login.html?reason=admin_required) that production edge/CDN-redirects an
 * unauthenticated request for that page to the login page BEFORE any client
 * JS runs, unlike contractor-opportunities.html and bids.html, which do not
 * edge-gate and only check auth client-side (which is what lets
 * forceDemoMode()'s config.js patch work for them at all). This matches the
 * gh-1697 issue text's own scoping for Part 2: "the public surfaces that
 * need no session" -- admin-payouts.html was never in scope for the LIVE
 * run; it stays covered by Part 1 (pre-merge, local) only.
 */
import { defineConfig, devices } from '@playwright/test';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.LIVE_BASE_URL || 'https://otterquote.com';

// gh-2064: this config's whole reason to exist is hitting the REAL deployed
// production site (see module docstring above) -- exactly the kind of
// automated walk that was being counted as a visitor in GA4, Meta and
// Clarity. Pre-seeding the oq_internal cookie via storageState means every
// context this config creates already carries it on its very first
// request, before the first page.goto() -- js/internal-traffic.js only
// needs the cookie OR the query param, and a pre-set cookie covers every
// PAGE constant in entry-point-reachability.spec.ts without editing each
// spec's own page.goto() call individually.
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
  testDir: __dirname,
  // Only the reachability spec runs against the live site -- pages.spec.ts
  // and recruit-routing.spec.ts stay scoped to the local-static-server smoke
  // config (playwright.smoke.config.ts); running them here would duplicate
  // effort and, for recruit-routing.spec.ts, mock a network route that
  // doesn't apply the same way against a real deployed origin.
  testMatch: 'entry-point-reachability.spec.ts',
  grepInvert: /admin-payouts\.html/,
  timeout: 20_000,
  expect: { timeout: 8_000 },
  retries: 1, // one retry only -- a real network hop against production, unlike the local smoke config
  workers: 3,
  fullyParallel: true,
  reporter: [['list']],

  use: {
    baseURL: BASE_URL,
    headless: true,
    actionTimeout: 8_000,
    navigationTimeout: 15_000,
    // gh-2064: opt this live run out of GA4/Meta/Clarity counting.
    storageState: INTERNAL_TRAFFIC_STORAGE_STATE,
  },

  // No webServer block -- the target is already deployed and live.

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
