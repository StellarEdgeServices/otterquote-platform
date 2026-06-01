/**
 * Flow E — D-210 Document Gate (Contractor Pre-Approval)
 *
 * Tests the D-210 contractor pre-approval document gate: contractors must
 * complete the pre-approval wizard (contractor-pre-approval.html) and be
 * approved (status = 'active') before they can access opportunities or bid
 * on claims.
 *
 * Coverage (17 tests):
 *   Gate enforcement:
 *   E1:  Pending contractor is blocked from contractor-opportunities.html
 *   E2:  Redirect from opportunities includes msg=pending_approval
 *   E3:  Pending contractor is blocked from contractor-bid-form.html
 *   E4:  Setting status='active' in DB grants opportunities access
 *
 *   Pre-approval wizard — page load & routing:
 *   E5:  Pre-approval page loads wizard panel for a pending contractor
 *   E6:  Active contractor is immediately redirected to dashboard
 *   E7:  Wizard shows step 1 as complete (dot1 has class "done")
 *   E8:  Step 2 label reads "License & Insurance"
 *   E15: Contractor with onboarding_step >= 4 sees panelSubmitted
 *
 *   Pre-approval wizard — Step 2 validation:
 *   E9:  step2-advance-btn is disabled by default (no docs filled)
 *   E10: Profile card: phone number field is present and required
 *   E11: Profile card: trade checkboxes are present and selectable
 *   E12: Profile card: service counties field is present
 *   E13: COI card: file upload and expiry date field are present
 *   E14: WC cert card: shows two paths (upload cert OR WCE-1 exemption)
 *   E16: License card: "No license required" checkbox is present
 *   E17: License card: "Add License" button is present for manual entry
 *
 * Prerequisites:
 *   - Run `npm run seed` before this spec
 *   - .env.test must have SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BASE_URL
 *   - staging--jade-alpaca-b82b5e.netlify.app in Supabase Auth redirect allowlist
 *
 * Test strategy:
 *   - beforeAll: save contractor's original status, set status = 'pending_approval'
 *     and onboarding_step = 2 for gate-enforcement tests.
 *   - afterAll: restore original status and onboarding_step.
 *   - E4 temporarily sets status = 'active', verifies access, then restores.
 *   - E6 and E15 temporarily flip status/onboarding_step, verify, then restore.
 *   - Tests run serially (workers: 1) to avoid DB state races.
 *
 * See README.md for full test data expectations.
 */

import { test, expect } from '@playwright/test';
import {
  generateMagicLink,
  getTestState,
  type TestState,
  createAdminClient,
} from '../helpers/auth.js';

// --- DB Helpers ---

interface ContractorStatusSnapshot {
  status: string;
  onboarding_step: number;
}

/** Reads the contractor's current status + onboarding_step from the DB. */
async function getContractorSnapshot(contractorId: string): Promise<ContractorStatusSnapshot> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('contractors')
    .select('status, onboarding_step')
    .eq('id', contractorId)
    .single();
  if (error || !data) {
    throw new Error(`getContractorSnapshot failed: ${error?.message ?? 'no data'}`);
  }
  return { status: data.status, onboarding_step: data.onboarding_step ?? 1 };
}

/** Updates the contractor's status and/or onboarding_step. */
async function setContractorState(
  contractorId: string,
  patch: Partial<ContractorStatusSnapshot>
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from('contractors')
    .update(patch)
    .eq('id', contractorId);
  if (error) {
    throw new Error(`setContractorState failed: ${error.message}`);
  }
}

// --- Auth Helper ---

async function loginAsContractor(
  page: import('@playwright/test').Page,
  state: TestState
) {
  const magicLink = await generateMagicLink(
    state.contractorEmail,
    `${state.baseUrl}/contractor-dashboard.html`
  );
  await page.goto(magicLink);
  await page.waitForURL(/contractor-dashboard/, { timeout: 30_000 });
  await page.waitForLoadState('load');
  await page.waitForFunction(
    async () => {
      const canonicalKey =
        (window as any).OTTERQUOTE_AUTH_STORAGE_KEY || 'sb-otterquote-auth';
      if (localStorage.getItem(canonicalKey)) return true;
      if (
        Object.keys(localStorage).some(
          (k) => k.startsWith('sb-') && k.endsWith('-auth-token')
        )
      )
        return true;
      if ((window as any).sb) {
        const { data } = await (window as any).sb.auth.getSession();
        return data.session !== null;
      }
      return false;
    },
    { timeout: 15_000 }
  );
  // Allow pending XHR/fetch calls to settle so Auth.getSession() fast-path
  // finds the session token before contractor-pre-approval.html's init() runs.
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
}

// --- Tests ---

test.describe('Flow E -- D-210 Document Gate (Contractor Pre-Approval)', () => {
  let state: TestState;

  test.beforeAll(async () => {
    state = getTestState();
    const snap = await getContractorSnapshot(state.contractorId);
    console.log(
      `  Contractor ${state.contractorId} entering D-210 tests with status=${snap.status} onboarding_step=${snap.onboarding_step}`
    );
    // onboarding_step is the LAST COMPLETED step: contractor-pre-approval.html
    // resumes at Math.max(2, onboarding_step + 1). A pending contractor still
    // filling out the step-2 doc cards has completed only step 1, so seed it to
    // 1 — seeding 2 resumes the wizard at step 3 and hides every step-2 card.
    await setContractorState(state.contractorId, {
      status: 'pending_approval',
      onboarding_step: 1,
    });
    console.log(
      `  Contractor ${state.contractorId} set to pending_approval for D-210 tests`
    );
  });

  // Always restore to seed state (active/4) — never restore to whatever state
  // we found on entry, which may itself be contaminated (e.g. pending_approval
  // left over from a previous failed run). Retail-siding tests that follow
  // require status=active to pass.
  test.afterAll(async () => {
    await setContractorState(state.contractorId, { status: 'active', onboarding_step: 4 });
    console.log(
      `  Contractor ${state.contractorId} restored to status=active onboarding_step=4 (seed state)`
    );
  });

  test('E1: pending contractor is redirected away from contractor-opportunities.html', async ({ page }) => {
    await loginAsContractor(page, state);
    await page.goto('/contractor-opportunities.html');
    await page.waitForLoadState('load');
    await page.waitForFunction(
      () => !window.location.pathname.includes('contractor-opportunities'),
      { timeout: 10_000 }
    );
    await expect(page).not.toHaveURL(/contractor-opportunities/);
    console.log('  E1 pass: pending contractor blocked from opportunities');
  });

  test('E2: redirect from opportunities includes msg=pending_approval query param', async ({ page }) => {
    await loginAsContractor(page, state);
    await page.goto('/contractor-opportunities.html');
    await page.waitForFunction(
      () =>
        window.location.href.includes('msg=pending_approval') ||
        (window.location.href.includes('contractor-dashboard') &&
          !window.location.href.includes('contractor-opportunities')),
      { timeout: 10_000 }
    );
    const url = page.url();
    expect(url).toMatch(/contractor-dashboard/);
    expect(url).toContain('pending_approval');
    console.log('  E2 pass: redirect URL contains msg=pending_approval');
  });

  test('E3: pending contractor is redirected away from contractor-bid-form.html', async ({ page }) => {
    await loginAsContractor(page, state);
    await page.goto(`/contractor-bid-form.html?claim=${state.testClaimId}`);
    await page.waitForLoadState('load');
    await page.waitForFunction(
      () =>
        !window.location.pathname.includes('contractor-bid-form') ||
        (document.body.textContent || '').toLowerCase().includes('pending') ||
        (document.body.textContent || '').toLowerCase().includes('approval'),
      { timeout: 10_000 }
    ).catch(() => {});
    const isOnBidForm = page.url().includes('contractor-bid-form');
    if (isOnBidForm) {
      const bodyText = await page.locator('body').textContent();
      const isGated =
        (bodyText || '').toLowerCase().includes('pending') ||
        (bodyText || '').toLowerCase().includes('approval') ||
        (bodyText || '').toLowerCase().includes('pre-approv');
      expect(isGated).toBeTruthy();
    } else {
      await expect(page).not.toHaveURL(/contractor-bid-form/);
    }
    console.log('  E3 pass: pending contractor blocked from bid form');
  });

  test('E4: setting contractor status=active in DB grants opportunities access', async ({ page }) => {
    await setContractorState(state.contractorId, { status: 'active' });
    try {
      await loginAsContractor(page, state);
      await page.goto('/contractor-opportunities.html');
      await page.waitForLoadState('load');
      await page
        .waitForFunction(
          () => !window.location.pathname.includes('contractor-dashboard'),
          { timeout: 10_000 }
        )
        .catch(() => {});
      const currentUrl = page.url();
      const wasGated =
        currentUrl.includes('contractor-dashboard') &&
        currentUrl.includes('pending_approval');
      expect(wasGated).toBeFalsy();
      console.log('  E4 pass: active contractor can access opportunities');
    } finally {
      await setContractorState(state.contractorId, {
        status: 'pending_approval',
        onboarding_step: 1,
      });
    }
  });

  test('E5: contractor-pre-approval.html loads and shows wizard panel for pending contractor', async ({ page }) => {
    await loginAsContractor(page, state);
    await page.goto('/contractor-pre-approval.html');
    await page.waitForLoadState('load');
    const wizardPanel = page.locator('#panelWizard');
    await expect(wizardPanel).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#panelLoading')).toBeHidden();
    console.log('  E5 pass: wizard panel visible for pending contractor');
  });

  test('E6: active contractor visiting pre-approval is redirected to contractor-dashboard.html', async ({ page }) => {
    await setContractorState(state.contractorId, { status: 'active' });
    try {
      await loginAsContractor(page, state);
      await page.goto('/contractor-pre-approval.html');
      await page.waitForURL(/contractor-dashboard/, { timeout: 15_000 });
      await expect(page).toHaveURL(/contractor-dashboard/);
      console.log('  E6 pass: active contractor redirected from pre-approval');
    } finally {
      await setContractorState(state.contractorId, {
        status: 'pending_approval',
        onboarding_step: 1,
      });
    }
  });

  test('E7: progress indicator shows step 1 as already completed (dot1 class=done)', async ({ page }) => {
    await loginAsContractor(page, state);
    await page.goto('/contractor-pre-approval.html');
    await page.waitForLoadState('load');
    await expect(page.locator('#panelWizard')).toBeVisible({ timeout: 15_000 });
    const dot1 = page.locator('#dot1');
    await expect(dot1).toHaveClass(/done/);
    console.log('  E7 pass: step 1 dot marked as done');
  });

  test('E8: step 2 label shows "License & Insurance"', async ({ page }) => {
    await loginAsContractor(page, state);
    await page.goto('/contractor-pre-approval.html');
    await page.waitForLoadState('load');
    await expect(page.locator('#panelWizard')).toBeVisible({ timeout: 15_000 });
    const lbl2 = page.locator('#lbl2');
    await expect(lbl2).toBeVisible();
    const labelText = await lbl2.textContent();
    expect((labelText || '').toLowerCase()).toContain('license');
    expect((labelText || '').toLowerCase()).toContain('insurance');
    console.log('  E8 pass: step 2 label reads "License & Insurance"');
  });

  test('E9: step2-advance-btn is disabled before any documents are filled', async ({ page }) => {
    await loginAsContractor(page, state);
    await page.goto('/contractor-pre-approval.html');
    await page.waitForLoadState('load');
    await expect(page.locator('#panelWizard')).toBeVisible({ timeout: 15_000 });
    const advanceBtn = page.locator('#step2-advance-btn');
    await expect(advanceBtn).toBeVisible();
    await expect(advanceBtn).toBeDisabled();
    console.log('  E9 pass: step2-advance-btn is disabled by default');
  });

  test('E10: profile card contains phone number field required for step 2 advance', async ({ page }) => {
    await loginAsContractor(page, state);
    await page.goto('/contractor-pre-approval.html');
    await page.waitForLoadState('load');
    await expect(page.locator('#panelWizard')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#card-profile')).toBeVisible();
    const phoneInput = page.locator('#profile-phone');
    await expect(phoneInput).toBeVisible();
    await expect(phoneInput).toBeEnabled();
    await phoneInput.fill('317-555-9999');
    const value = await phoneInput.inputValue();
    expect(value).toBeTruthy();
    console.log('  E10 pass: profile card phone field present and writable');
  });

  test('E11: profile card shows trade checkboxes that can be selected', async ({ page }) => {
    await loginAsContractor(page, state);
    await page.goto('/contractor-pre-approval.html');
    await page.waitForLoadState('load');
    await expect(page.locator('#panelWizard')).toBeVisible({ timeout: 15_000 });
    const tradesContainer = page.locator('#profile-trades');
    await expect(tradesContainer).toBeVisible();
    const tradeCheckboxes = tradesContainer.locator('input[type="checkbox"]');
    const count = await tradeCheckboxes.count();
    expect(count).toBeGreaterThan(0);
    const firstCheckbox = tradeCheckboxes.first();
    if (!(await firstCheckbox.isChecked())) {
      await firstCheckbox.check({ force: true });
    }
    await expect(firstCheckbox).toBeChecked();
    console.log(`  E11 pass: ${count} trade checkboxes found and selectable`);
  });

  test('E12: profile card contains service counties text field', async ({ page }) => {
    await loginAsContractor(page, state);
    await page.goto('/contractor-pre-approval.html');
    await page.waitForLoadState('load');
    await expect(page.locator('#panelWizard')).toBeVisible({ timeout: 15_000 });
    const countiesInput = page.locator('#profile-counties');
    await expect(countiesInput).toBeVisible();
    await expect(countiesInput).toBeEnabled();
    await countiesInput.fill('Marion-IN, Hamilton-IN');
    const value = await countiesInput.inputValue();
    expect(value).toContain('Marion');
    console.log('  E12 pass: service counties field present and writable');
  });

  test('E13: COI card is visible with file upload input and expiry date field', async ({ page }) => {
    await loginAsContractor(page, state);
    await page.goto('/contractor-pre-approval.html');
    await page.waitForLoadState('load');
    await expect(page.locator('#panelWizard')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#card-coi')).toBeVisible();
    expect(await page.locator('#coi-upload').count()).toBe(1);
    const coiExpiry = page.locator('#coi-expiry');
    await expect(coiExpiry).toBeVisible();
    await expect(coiExpiry).toBeEnabled();
    await coiExpiry.fill('2027-06-30');
    expect(await coiExpiry.inputValue()).toBe('2027-06-30');
    console.log('  E13 pass: COI card file input and expiry date field present');
  });

  test('E14: WC cert card offers two paths: upload WC cert OR WCE-1 exemption', async ({ page }) => {
    await loginAsContractor(page, state);
    await page.goto('/contractor-pre-approval.html');
    await page.waitForLoadState('load');
    await expect(page.locator('#panelWizard')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#card-wc')).toBeVisible();
    expect(await page.locator('#wc-upload').count()).toBe(1);
    expect(await page.locator('#wce1-upload').count()).toBe(1);
    expect(await page.locator('#wce1-expiry').count()).toBe(1);
    console.log('  E14 pass: WC cert card has both cert upload and WCE-1 exemption paths');
  });

  test('E15: contractor with onboarding_step=4 sees panelSubmitted confirmation', async ({ page }) => {
    await setContractorState(state.contractorId, {
      status: 'pending_approval',
      onboarding_step: 4,
    });
    try {
      await loginAsContractor(page, state);
      await page.goto('/contractor-pre-approval.html');
      await page.waitForLoadState('load');
      const submittedPanel = page.locator('#panelSubmitted');
      await expect(submittedPanel).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('#panelWizard')).toBeHidden();
      console.log('  E15 pass: panelSubmitted shown for onboarding_step=4');
    } finally {
      await setContractorState(state.contractorId, {
        status: 'pending_approval',
        onboarding_step: 1,
      });
    }
  });

  test('E16: license card contains a "No license required" checkbox option', async ({ page }) => {
    await loginAsContractor(page, state);
    await page.goto('/contractor-pre-approval.html');
    await page.waitForLoadState('load');
    await expect(page.locator('#panelWizard')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#card-license')).toBeVisible();
    expect(await page.locator('#license-no-license').count()).toBe(1);
    const noLicenseLabel = page.locator('#license-no-license-label');
    if (await noLicenseLabel.isVisible({ timeout: 3_000 }).catch(() => false)) {
      const labelText = await noLicenseLabel.textContent();
      // Shipped copy is "I don't have a license for this work" (.? matches a
      // straight or curly apostrophe); accept that alongside other phrasings.
      expect((labelText || '').toLowerCase()).toMatch(/no license|not required|exempt|don.?t have a license/);
    }
    console.log('  E16 pass: license card contains "No license required" checkbox');
  });

  test('E17: license card "Add License" button opens manual license entry form', async ({ page }) => {
    await loginAsContractor(page, state);
    await page.goto('/contractor-pre-approval.html');
    await page.waitForLoadState('load');
    await expect(page.locator('#panelWizard')).toBeVisible({ timeout: 15_000 });
    const addLicenseBtn = page.locator('#license-add-btn');
    await expect(addLicenseBtn).toBeVisible();
    await addLicenseBtn.click();
    const licenseForm = page.locator('#license-form');
    await expect(licenseForm).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#lic-jurisdiction')).toBeVisible();
    await expect(page.locator('#lic-number')).toBeVisible();
    console.log('  E17 pass: "Add License" button opens license entry form');
  });
});
