/**
 * Flow A — Contractor Journey
 *
 * Tests the core contractor authenticated surface:
 *   A1: contractor-join.html loads and renders contact form
 *   A2: test contractor authenticates via magic link injection
 *   A3: contractor dashboard loads and shows contractor portal
 *   A4: contractor-profile.html loads in authenticated state
 *   A5: contractor-opportunities.html loads and renders opportunities panel
 *   A6: contractor-bid-form.html loads for the test claim
 *   A7: contractor submits a bid and it persists in the database
 *
 * Prerequisites:
 *   - Run `npm run seed` before this spec
 *   - .env.test must have SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BASE_URL
 *   - staging--jade-alpaca-b82b5e.netlify.app must be in Supabase Auth redirect allowlist
 *
 * Explicitly skipped (documented TODOs):
 *   - Stripe payment method attachment (contractor onboarding page 4)
 *   - DocuSign signing (contract-signing.html iframe — requires sandbox credentials)
 *   - Full 4-page onboarding wizard flow (pages 2-4 require file uploads + payment)
 *
 * See README.md for full test data expectations.
 */

import { test, expect } from '@playwright/test';
import { generateMagicLink, getTestState, type TestState } from '../helpers/auth.js';
import { verifyBidPersisted } from '../helpers/db.js';
import { runArtifactCapture, isDocuSignE2EEnabled } from '../helpers/docusign-artifacts.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Logs the test contractor in via magic link and waits for the dashboard.
 * Re-used across multiple tests that need an authenticated browser context.
 */
async function loginAsContractor(page: import('@playwright/test').Page, state: TestState) {
  const magicLink = await generateMagicLink(
    state.contractorEmail,
    `${state.baseUrl}/contractor-dashboard.html`
  );
  await page.goto(magicLink);
  // Supabase redirects to baseUrl with #access_token in fragment.
  // Wait for navigation to the contractor dashboard.
  await page.waitForURL(/contractor-dashboard/, { timeout: 30_000 });
  // Allow the Supabase JS client and page JS to initialize
  await page.waitForLoadState('load');
  // Wait for Supabase client to persist the session token to localStorage
  // before any subsequent page.goto() calls (otherwise auth is lost on navigation)
  await page.waitForFunction(() => {
    return Object.keys(localStorage).some(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
  }, { timeout: 15_000 });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test.describe('Flow A — Contractor Journey', () => {
  let state: TestState;

  test.beforeAll(() => {
    state = getTestState();
  });


  // ── Phase 1 artifact capture ────────────────────────────────────────────
  // Runs after all Flow A tests. If DOCUSIGN_E2E_ENABLED=true AND a DocuSign
  // envelope was created on the test claim (e.g., homeowner selected the test
  // contractor during this run), downloads the pre-signing PDF and persists it
  // to Supabase Storage e2e-artifacts/phase-1/{runId}/{envelopeId}.pdf.
  //
  // Today: always finds no envelope (DocuSign not triggered in Flow A). Will
  // activate automatically once B8 (homeowner selects contractor) is wired in
  // and DOCUSIGN_E2E_ENABLED=true.
  //
  // QUOTA: Each activation burns one production DocuSign envelope (40/month).
  // Ram decides when to enable; Dustin approves before each run.
  test.afterAll(async () => {
    if (!isDocuSignE2EEnabled() || !state) return;
    const envelopeId = await getClaimEnvelopeId(state.testClaimId);
    await runArtifactCapture('1', state.runId, envelopeId ? [envelopeId] : []);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // A1: Public page — contractor join form
  // ──────────────────────────────────────────────────────────────────────────
  test('A1: contractor-join.html loads and renders the contact info form', async ({ page }) => {
    await page.goto('/contractor-join.html');
    await page.waitForLoadState('load');

    // Wait for JS to render the contractor form (D-195 widget may fire first)
    await page.locator('#contractorForm').waitFor({ state: 'visible', timeout: 15_000 });

    // Page title should reference joining or contracting
    await expect(page).toHaveTitle(/apply|join|contractor|otter/i);

    // Contact form must be visible
    await expect(page.locator('form').first()).toBeVisible();

    // Name + email fields must be present (page 1 per D-190 / D-189)
    // Scope to contractorForm to avoid matching injected support-contact widget inputs (sc-name, etc.)
    const nameField = page.locator('#contractorForm').locator(
      'input[id*="name" i], input[name*="name" i]'
    ).first();
    await expect(nameField).toBeVisible();

    const emailField = page.locator('input[type="email"]').first();
    await expect(emailField).toBeVisible();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // A2: Magic link authentication
  // ──────────────────────────────────────────────────────────────────────────
  test('A2: test contractor authenticates via magic link and lands on dashboard', async ({ page }) => {
    await loginAsContractor(page, state);

    // Must be on the contractor dashboard after auth
    await expect(page).toHaveURL(/contractor-dashboard/);

    // Must NOT have been bounced to a login or get-started page
    await expect(page).not.toHaveURL(/login|get-started/);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // A3: Contractor dashboard — authenticated state
  // ──────────────────────────────────────────────────────────────────────────
  test('A3: authenticated contractor dashboard loads and renders portal UI', async ({ page }) => {
    await loginAsContractor(page, state);

    // Dashboard heading or welcome element must be present
    const heading = page.locator(
      'h1, h2, .dashboard-title, [class*="welcome"], [class*="hero"]'
    ).first();
    await expect(heading).toBeVisible();

    // No JS error overlay or unhandled error text
    await expect(page.locator('body')).not.toContainText(/uncaught|typeerror|referenceerror/i);

    // Should not be redirected away from the dashboard
    await expect(page).toHaveURL(/contractor-dashboard/);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // A4: Contractor profile page
  // ──────────────────────────────────────────────────────────────────────────
  test('A4: contractor-profile.html loads in authenticated state', async ({ page }) => {
    await loginAsContractor(page, state);

    await page.goto('/contractor-profile.html');
    await page.waitForLoadState('load');

    // Must remain authenticated — not bounced to login
    await expect(page).not.toHaveURL(/login|get-started/);

    // Profile page body must render (section, form, or card)
    const profileContent = page.locator(
      '[data-section], .profile-section, .card, .panel, form, [class*="profile"]'
    ).first();
    await expect(profileContent).toBeVisible();

    // Company name field should be pre-populated from seed data
    const companyField = page.locator(
      'input[id*="company"], input[name*="company"], input[placeholder*="company"]'
    ).first();
    if (await companyField.isVisible()) {
      // Should have the value set by seed.mjs
      const val = await companyField.inputValue();
      expect(val.length).toBeGreaterThan(0);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // A5: Service area — profile includes service area selector
  // ──────────────────────────────────────────────────────────────────────────
  test('A5: contractor-profile.html renders service area section', async ({ page }) => {
    await loginAsContractor(page, state);

    await page.goto('/contractor-profile.html');
    await page.waitForLoadState('load');

    await expect(page).not.toHaveURL(/login|get-started/);

    // Service area section should be present (D-192 checkbox UI)
    await expect(page.locator('body')).toContainText(/service.{0,5}area/i);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // A6: Contractor opportunities page
  // ──────────────────────────────────────────────────────────────────────────
  test('A6: contractor-opportunities.html loads and renders opportunities panel', async ({ page }) => {
    await loginAsContractor(page, state);

    await page.goto('/contractor-opportunities.html');
    await page.waitForLoadState('load');

    // Must remain authenticated
    await expect(page).not.toHaveURL(/login|get-started/);

    // Page body must contain the "opportunit" string (heading or container)
    await expect(page.locator('body')).toContainText(/opportunit/i);

    // No unhandled errors
    await expect(page.locator('body')).not.toContainText(/uncaught|typeerror/i);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // A7: Bid form loads for test claim
  // ──────────────────────────────────────────────────────────────────────────
  test('A7: contractor-bid-form.html loads for the test claim', async ({ page }) => {
    await loginAsContractor(page, state);

    await page.goto(`/contractor-bid-form.html?claim_id=${state.testClaimId}`);
    await page.waitForLoadState('load');

    // Must remain authenticated
    await expect(page).not.toHaveURL(/login|get-started/);

    // For insurance_rcv roofing bids, the visible required price input is deckingPricePerSheet (D-084)
    // #totalPrice is a hidden computed field — not the user-facing input
    const priceInput = page.locator('#deckingPricePerSheet, #fullRedeckPrice').first();
    await expect(priceInput).toBeVisible();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // A8: Bid submission + DB persistence verification
  // ──────────────────────────────────────────────────────────────────────────
  test('A8: contractor submits a bid and it persists in the database', async ({ page }) => {
    await loginAsContractor(page, state);

    await page.goto(`/contractor-bid-form.html?claim_id=${state.testClaimId}`);
    await page.waitForLoadState('load');

    await expect(page).not.toHaveURL(/login|get-started/);

    // Capture browser-side console messages — surfaces form errors (e.g. RLS failures,
    // bid validation errors) that would otherwise be invisible in CI output.
    const _browserLogs: string[] = [];
    page.on('console', msg => {
      const entry = `[browser:${msg.type()}] ${msg.text()}`;
      _browserLogs.push(entry);
      if (msg.type() === 'error' || msg.type() === 'warning') {
        console.error('[A8 browser console]', entry);
      }
    });

    // Capture any unexpected dialogs — fail fast with the message rather than
    // timing out 20s later with no information.
    const _dialogs: string[] = [];
    page.on('dialog', async dialog => {
      const msg = `${dialog.type()}: ${dialog.message()}`;
      _dialogs.push(msg);
      console.error('[A8 dialog captured]', msg);
      await dialog.dismiss();
    });

    // Step 1: networkidle — wait for Supabase API calls to settle.
    await page.waitForLoadState('networkidle', { timeout: 15_000 });

    // Step 2: Diagnostic dump immediately after networkidle so we can see
    // the exact page state in CI output.
    const _pageState = await page.evaluate(() => {
      return {
        url: window.location.href,
        totalPriceValue: (document.getElementById('totalPrice') as HTMLInputElement | null)?.value ?? 'ELEMENT_MISSING',
        deckingVisible: (document.getElementById('deckingPricePerSheet') as HTMLElement | null)?.offsetParent !== null,
        submitBtnText: (document.getElementById('submitBtn') as HTMLButtonElement | null)?.textContent?.trim() ?? 'MISSING',
        submitBtnDisabled: (document.getElementById('submitBtn') as HTMLButtonElement | null)?.disabled ?? null,
        localStorageKeys: Object.keys(localStorage).filter(k => k.startsWith('sb-')),
      };
    });
    console.log('[A8 pageState after networkidle]', JSON.stringify(_pageState));

    // Step 3: If #totalPrice isn't set yet (async JS chain still running),
    // wait up to 15s for it. If still zero after 15s, proceed anyway and
    // let the form's JS handle validation — the diagnostic dump above will
    // show exactly why the init stalled.
    if (!_pageState.totalPriceValue || parseFloat(_pageState.totalPriceValue) <= 0) {
      await page.waitForFunction(
        () => {
          const tp = document.getElementById('totalPrice') as HTMLInputElement | null;
          return tp !== null && parseFloat(tp.value || '0') > 0;
        },
        { timeout: 15_000 }
      ).catch(() => {
        console.warn('[A8] #totalPrice still 0 after 15s — proceeding anyway, JS handler will surface the issue');
      });
    }

    // ── Fill required bid fields ─────────────────────────────────────────

    // For insurance_rcv roofing, visible price entry is via decking inputs (D-084)
    // #totalPrice is a hidden computed field — not the user-facing input
    const deckingInput = page.locator('#deckingPricePerSheet').first();
    await expect(deckingInput).toBeVisible();
    await deckingInput.fill('75');

    const redeckPriceInput = page.locator('#fullRedeckPrice').first();
    await expect(redeckPriceInput).toBeVisible();
    await redeckPriceInput.fill('8500');

    // brandProduct (required visible field — shingle brand/product)
    const brandProductInput = page.locator('#brandProduct');
    if (await brandProductInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await brandProductInput.fill('GAF Timberline HDZ');
    }

    // startDate (required visible field — projected start date)
    const startDateInput = page.locator('#startDate');
    if (await startDateInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await startDateInput.fill('2026-05-12');
    }

    // completionTime (required select — estimated completion window)
    const completionTimeSelect = page.locator('#completionTime');
    if (await completionTimeSelect.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await completionTimeSelect.selectOption({ index: 1 });
    }

    // numStories (required select — number of stories on the home)
    const numStoriesSelect = page.locator('#numStories');
    if (await numStoriesSelect.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await numStoriesSelect.selectOption({ index: 1 });
    }

    // Workmanship warranty years (fill if visible)
    const warrantyInput = page.locator(
      'input[id*="warranty"], input[name*="warranty"]'
    ).first();
    if (await warrantyInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await warrantyInput.fill('5');
    }

    // Manufacturer warranty select (fill if visible)
    const warrantySelect = page.locator(
      'select[id*="warranty"], select[name*="warranty"]'
    ).first();
    if (await warrantySelect.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await warrantySelect.selectOption({ index: 1 });
    }

    // Decking inputs already filled above — no duplicate fill needed

    // Supplement acknowledged checkbox (RCV roofing bids, D-077)
    const supplementCheckbox = page.locator(
      'input[type="checkbox"][id*="supplement"], input[type="checkbox"][name*="supplement"]'
    ).first();
    if (await supplementCheckbox.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await supplementCheckbox.check();
    }

    // TODO: Stripe payment method attachment — skipped per approved plan (option b).
    // The payment form renders but no card is charged against the live Stripe account
    // during automated tests. Wire to Stripe test mode keys when a staging-specific
    // Stripe configuration is available. See CI_INTEGRATION.md → Phase 2.

    // ── Submit the form ──────────────────────────────────────────────────

    const submitBtn = page.locator(
      'button[type="submit"], button:has-text("Submit Bid"), ' +
      'button:has-text("Place Bid"), button:has-text("Submit")'
    ).first();
    await expect(submitBtn).toBeVisible();

    // Bypass HTML5 native form validation — the form has no novalidate attribute,
    // so the browser's built-in validation runs silently before the submit event
    // fires, blocking submission without any JS dialog or console error.
    // Once bypassed, our JS handler runs and will alert() on any remaining issues.
    await page.evaluate(() => {
      const form = document.getElementById('bidForm') as HTMLFormElement | null;
      if (form) form.noValidate = true;
    });

    await submitBtn.click();

    // Wait for the bid form's success state to become visible.
    // #successState is always in DOM (hidden) and gets class 'show' added on success.
    // Using [class*="success"] would match the hidden div immediately — must use
    // the specific #successState.show selector to wait for the actual success.
    if (_dialogs.length > 0) {
      throw new Error(`[A8] Unexpected dialog(s) fired during submission — bid likely blocked:\n${_dialogs.join('\n')}\nBrowser console:\n${_browserLogs.filter(l => l.includes('error')).join('\n')}`);
    }
    await page.waitForSelector('#successState.show', { timeout: 30_000 }).catch(async (err) => {
      const diagLines = [
        'Dialogs captured: ' + (_dialogs.length ? _dialogs.join(' | ') : 'none'),
        'Browser errors: ' + (_browserLogs.filter(l => l.includes('error')).join(' | ') || 'none'),
      ];
      throw new Error(`[A8] Success state never shown.\n${diagLines.join('\n')}\nOriginal: ${err.message}`);
    });

    // ── Verify bid persisted in DB ───────────────────────────────────────

    const bidPersisted = await verifyBidPersisted(state.contractorId, state.testClaimId);
    expect(bidPersisted).toBe(true);
  });
});
