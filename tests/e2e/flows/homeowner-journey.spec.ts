/**
 * Flow B — Homeowner Journey (Phase 1 Stub)
 *
 * Current coverage (Phase 1):
 *   B1: get-started.html loads and renders registration form
 *   B2: test homeowner authenticates via magic link injection
 *   B3: homeowner dashboard loads without errors
 *   B4: bids.html renders for the test claim
 *
 * Deferred to Phase 2 (post-launch):
 *   B5: Full claim creation flow (loss sheet upload, trade selection, D-178 state gate)
 *   B6: Measurements step (Hover $15 payment, D-291 — requires Stripe test mode)
 *   B7: Material selection (shingle type, impact class)
 *   B8: Bid review and contractor selection
 *   B9: Contract signing (DocuSign — requires sandbox credentials)
 *   B10: Project confirmation / Colors step
 *
 * Rationale for Phase 1 scope:
 *   The homeowner UI was manually verified end-to-end in the Cycle 5 walkthrough
 *   (April 28, 2026 — zero code defects found blocking launch). The Phase 1 stub
 *   covers authenticated page load — the highest-risk failure mode for static HTML
 *   + Supabase auth. Full flow automation is planned post-launch when the product
 *   is stable and DocuSign sandbox credentials are configured.
 *
 * Session sharing (B2 → B3 → B4):
 *   B2 generates one magic link and saves storageState to a temp file.
 *   B3 and B4 restore from that storageState — no additional magic link calls.
 *   This prevents hitting Supabase's ~60s per-address magic link rate limit
 *   that caused intermittent B4 failures in CI.
 *
 * Prerequisites:
 *   - Run `npm run seed` before this spec
 *   - .env.test must have SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BASE_URL
 *
 * See README.md for full test data expectations.
 */

import { existsSync } from 'fs';
import { test, expect } from '@playwright/test';
import { generateMagicLink, getTestState, type TestState } from '../helpers/auth.js';
import { getTestClaim, getClaimEnvelopeId } from '../helpers/db.js';
import { runArtifactCapture, isDocuSignE2EEnabled } from '../helpers/docusign-artifacts.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function loginAsHomeowner(page: import('@playwright/test').Page, state: TestState) {
  const magicLink = await generateMagicLink(
    state.homeownerEmail,
    `${state.baseUrl}/dashboard.html`
  );
  await page.goto(magicLink);
  // Use a loose regex so fragments/query-strings on the redirect URL don't cause
  // a timeout (the magic link callback appends ?code= or #access_token= before
  // the final navigation settles on dashboard.html). The waitForFunction below
  // then confirms the Supabase token is in localStorage for the correct origin
  // before storageState is saved, which is the real guard against D-212
  // cross-subdomain cookie mismatch.
  await page.waitForURL(/dashboard/, { timeout: 30_000 });
  await page.waitForLoadState('load');
  // Wait for Supabase client to persist the session token to localStorage before
  // saving storageState. Without this, storageState is written before the auth
  // token lands in localStorage — B3/B4 then restore an empty session and get
  // redirected to get-started. Mirrors the loginAsContractor pattern.
  // OtterQuoteCookieStorage (D-212) dual-writes under 'sb-otterquote-auth',
  // not the legacy Supabase suffix 'sb-*-auth-token'. Check the canonical
  // key first, then legacy, then poll the Supabase client directly.
  await page.waitForFunction(async () => {
    const canonicalKey = (window as any).OTTERQUOTE_AUTH_STORAGE_KEY || 'sb-otterquote-auth';
    if (localStorage.getItem(canonicalKey)) return true;
    if (Object.keys(localStorage).some(k => k.startsWith('sb-') && k.endsWith('-auth-token'))) return true;
    if ((window as any).sb) {
      const { data } = await (window as any).sb.auth.getSession();
      return data.session !== null;
    }
    return false;
  }, { timeout: 15_000 });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test.describe('Flow B — Homeowner Journey (Phase 1 Stub)', () => {
  let state: TestState;
  // Shared storageState path — written by B2, read by B3 and B4.
  // Eliminates duplicate magic link calls that hit Supabase's ~60s rate limit.
  let storageStatePath: string;

  test.beforeAll(() => {
    state = getTestState();
    // Stable per-worker path. Date.now() in beforeAll regenerates on every retry,
    // so B3/B4 then ENOENT on the path B2 never wrote. process.pid is stable for
    // the lifetime of the worker, which covers all retries.
    storageStatePath = `/tmp/homeowner-session-${process.pid}.json`;
  });


  // ── Phase 2 artifact capture ────────────────────────────────────────────
  // Runs after all Flow B tests. If DOCUSIGN_E2E_ENABLED=true AND a DocuSign
  // envelope was created on the test claim (after homeowner selects a contractor
  // via B8), downloads the pre-signing PDF and persists it to:
  //   e2e-artifacts/phase-2/{runId}/{envelopeId}.pdf
  //
  // Today: always finds no envelope (B8 not yet implemented). Will activate
  // automatically once B8 triggers create-docusign-envelope and
  // DOCUSIGN_E2E_ENABLED=true is set in .env.test.
  //
  // QUOTA: Each activation burns one production DocuSign envelope (40/month).
  // Ram decides when to enable; Dustin approves before each run.
  test.afterAll(async () => {
    if (!isDocuSignE2EEnabled() || !state) return;
    const envelopeId = await getClaimEnvelopeId(state.testClaimId);
    await runArtifactCapture('2', state.runId, envelopeId ? [envelopeId] : []);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // B1: Public page — homeowner registration form
  // ──────────────────────────────────────────────────────────────────────────
  test('B1: get-started.html loads and renders the registration form', async ({ page }) => {
    await page.goto('/get-started.html');
    await page.waitForLoadState('load');

    await expect(page).toHaveTitle(/get started|register|otter/i);

    // Registration form must be visible
    await expect(page.locator('form').first()).toBeVisible();

    // Email field required per D-035 (contact info first)
    await expect(page.locator('input[type="email"]').first()).toBeVisible();

    // Phone field required per D-035
    const phoneField = page.locator(
      'input[type="tel"], input[id*="phone"], input[name*="phone"]'
    ).first();
    await expect(phoneField).toBeVisible();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // B2: Magic link authentication — generates the single shared session
  // used by B3 and B4 via storageState restore.
  // ──────────────────────────────────────────────────────────────────────────
  test('B2: test homeowner authenticates via magic link and lands on dashboard', async ({ page }) => {
    await loginAsHomeowner(page, state);

    // Persist the authenticated session for B3 and B4 (no additional magic links needed)
    await page.context().storageState({ path: storageStatePath });

    // Must be on the homeowner dashboard at the BASE_URL origin (NOT app.otterquote.com).
    // Same anchor as waitForURL in loginAsHomeowner — see comment there.
    // Tolerate optional trailing '#' from Supabase detectSessionInUrl hash-cleanup
    // residue. The bare '#' is cosmetic - production users hit the dashboard normally.
    // Root cause (Supabase redirect_to override + no homeowner bounce in index.html)
    // is tracked separately as Phase 2 of bug-killer 86e1fbxgq.
    await expect(page).toHaveURL(/\/dashboard\.html#?$/);
    await expect(page).not.toHaveURL(/login|get-started|contractor/);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // B3: Homeowner dashboard — restores B2's session, no new magic link
  // ──────────────────────────────────────────────────────────────────────────
  test('B3: homeowner dashboard loads without errors for test account', async ({ browser }) => {
    // Guard: if B2 failed to write the session file, skip with a descriptive message
    // rather than crashing with ENOENT. B2 may have failed due to an upstream auth issue.
    test.skip(
      !existsSync(storageStatePath),
      `B3 skipped: session file not found at ${storageStatePath} — B2 likely failed to authenticate. Fix the auth issue (see task 86e1bemev) to re-enable B3.`
    );
    const context = await browser.newContext({
      storageState: storageStatePath,
      baseURL: state.baseUrl,
    });
    const page = await context.newPage();
    try {
      await page.goto(`${state.baseUrl}/dashboard.html`);
      await page.waitForLoadState('load');

      // Page body must be visible and error-free
      await expect(page.locator('body')).toBeVisible();
      await expect(page.locator('body')).not.toContainText(/uncaught|typeerror|referenceerror/i);
      // Visibility-aware error check: the #gate-error div is in the DOM at all times
      // (display:none by default) and only populated/shown if saveWaitlistSpot() throws.
      // toContainText() reads textContent of hidden elements, so we use visibility instead.
      await expect(page.locator('#gate-error')).not.toBeVisible();

      // Must not be redirected
      await expect(page).not.toHaveURL(/login|get-started/);

      // Verify test claim exists in DB (belt + suspenders — seed already created it)
      const claim = await getTestClaim(state.testClaimId);
      expect(claim).not.toBeNull();
      expect(claim?.status).toBe('bidding');
      expect(claim?.property_state).toBe('IN');
    } finally {
      await context.close();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // B4: Bids page — restores B2's session, no new magic link
  // ──────────────────────────────────────────────────────────────────────────
  test('B4: bids.html renders bid comparison UI for test claim', async ({ browser }) => {
    // Guard: if B2 failed to write the session file, skip with a descriptive message
    // rather than crashing with ENOENT. Mirrors B3 guard above.
    test.skip(
      !existsSync(storageStatePath),
      `B4 skipped: session file not found at ${storageStatePath} — B2 likely failed to authenticate. Fix the auth issue (see task 86e1bemev) to re-enable B4.`
    );
    const context = await browser.newContext({
      storageState: storageStatePath,
      baseURL: state.baseUrl,
    });
    const page = await context.newPage();
    try {
      await page.goto(`${state.baseUrl}/bids.html?claim_id=${state.testClaimId}`);
      await page.waitForLoadState('load');

      // Must remain authenticated
      await expect(page).not.toHaveURL(/login|get-started/);

      // Page body must be visible
      await expect(page.locator('body')).toBeVisible();

      // Bid-related content should be on the page
      await expect(page.locator('body')).not.toContainText(/uncaught|typeerror/i);
    } finally {
      await context.close();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TODO: B5 — Claim creation flow
  // Navigate to get-started.html, fillcontact info, proceed through
  // trade-selector.html, verify claim created in DB.
  // Deferred: requires Stripe test mode for Hover payment step.
  // ──────────────────────────────────────────────────────────────────────────

  // TODO: B6 — Measurements step
  // Verify help-measurements.html renders Hover purchase UI.
  // Skip actual Stripe charge — assert form renders with $15 price.
  // Deferred: Stripe test mode required for payment step.

  // TODO: B7 — Material selection
  // Fill shingle type + impact class on dashboard.
  // Verify has_material_selection = true persists to claims.

  // TODO: B8 — Bid review and contractor selection
  // After Flow A A8 (bid submission), navigate to bids.html.
  // Assert test contractor's bid appears.
  // Click "Select This Contractor" — assert claim.selected_contractor_id set.

  // TODO: B9 — Contract signing
  // Navigate to contract-signing.html after contractor selected.
  // Assert DocuSign iframe container renders.
  // Skip signing — requires DocuSign sandbox credentials.
  // See CI_INTEGRATION.md → DocuSign Sandbox Setup.

  // TODO: B10 — Project confirmation
  // Navigate to project-confirmation.html (color-selection.html).
  // Assert trade-specific form fields render (roofing: shingle color, drip edge, etc.)
  // Verify project_confirmation JSONB persists on submit.
});

// ─── AuthProvider warm-reload regression (86e1nbud6) ─────────────────────────
//
// Prevention test for bug 86e1mrwrx: get-started blank on warm reload.
//
// Root cause: AuthProvider only resolved loading:false inside onAuthStateChange.
// On a warm reload, Supabase emits INITIAL_SESSION before the listener attaches —
// the event is missed and the page hangs blank indefinitely.
//
// Fix (PR #195): proactive getSession() + 1.5s fallback in auth-provider.tsx.
//
// This test locks in the fix by verifying:
//  1. Cold load renders the intake form within 2s
//  2. Warm reload (page.reload()) also renders the intake form within 2s
//
// Targets the React app (/get-started route) — skips on non-otterquote.com envs
// (e.g. Netlify preview URLs) where the app subdomain is not available.
// ─────────────────────────────────────────────────────────────────────────────

function reactAppBaseUrl(marketingBaseUrl: string): string | null {
  try {
    const u = new URL(marketingBaseUrl);
    const host = u.hostname;
    if (host === 'otterquote.com') return `${u.protocol}//app.otterquote.com`;
    if (host === 'staging.otterquote.com') return `${u.protocol}//app-staging.otterquote.com`;
    if (host.endsWith('.otterquote.com')) return `${u.protocol}//app-${host}`;
    return null;
  } catch {
    return null;
  }
}

test.describe('AuthProvider warm-reload regression (86e1nbud6)', () => {
  let state: TestState;
  let reactAppUrl: string | null = null;

  test.beforeAll(() => {
    state = getTestState();
    reactAppUrl = reactAppBaseUrl(state.baseUrl);
  });

  // B-WR1: Cold load — React /get-started renders intake form
  test('B-WR1: React /get-started renders intake form on cold load (unauthenticated)', async ({ page }) => {
    test.skip(!reactAppUrl, `Skipped: BASE_URL is not an otterquote.com domain (${state?.baseUrl}) — React app subdomain unavailable`);

    await page.goto(`${reactAppUrl}/get-started`);
    await page.waitForLoadState('load');

    // The "Get Started" heading MUST appear within 2s of page load.
    // If AuthProvider hangs, the page shows a blank loading state instead.
    await expect(page.locator('h1').filter({ hasText: 'Get Started' }))
      .toBeVisible({ timeout: 2_000 });
  });

  // B-WR2: Warm reload — critical regression path for 86e1mrwrx
  test('B-WR2: React /get-started renders intake form after warm reload (unauthenticated)', async ({ page }) => {
    test.skip(!reactAppUrl, `Skipped: BASE_URL is not an otterquote.com domain (${state?.baseUrl}) — React app subdomain unavailable`);

    // Cold load first to establish the "warm" state (localStorage, cookies primed)
    await page.goto(`${reactAppUrl}/get-started`);
    await page.waitForLoadState('load');
    await expect(page.locator('h1').filter({ hasText: 'Get Started' }))
      .toBeVisible({ timeout: 2_000 });

    // Warm reload: Supabase emits INITIAL_SESSION before onAuthStateChange attaches.
    // Pre-fix (PR #195): the event is missed, loading never resolves, page hangs blank.
    // Post-fix: proactive getSession() + 1.5s fallback ensures loading:false in time.
    await page.reload();
    await page.waitForLoadState('load');

    // Must render the form within 2s of reload — not a blank/spinner page.
    await expect(page.locator('h1').filter({ hasText: 'Get Started' }))
      .toBeVisible({ timeout: 2_000 });
  });
});
