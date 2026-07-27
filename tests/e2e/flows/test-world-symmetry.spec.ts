/**
 * #564 regression — test-world symmetry (bid-flow visibility, both directions).
 *
 * Guards the v96 claims-RLS carve-out (CEO Option A, decision comment
 * 2026-07-13 on #564):
 *
 *   S1 (test world flows):  the seeded test contractor (contractors.is_test
 *       = true) SEES the seeded test claim (claims.is_test = true) on
 *       contractor-opportunities — the exact visibility that PFW run
 *       pfw-1783974479 Stage 7 proved impossible pre-v96.
 *
 *   S2 (real world sealed): a real-flagged contractor (contractors.is_test
 *       = false) does NOT see any test claim. The spec-scoped contractor row
 *       uses an @otterquote-internal.test email, so the #543 matching
 *       exclusion still keeps it out of real-claim fan-out; RLS classifies
 *       it as real (flag-based), which is exactly what S2 needs.
 *
 * Notification symmetry (test claims notify test contractors only; real
 * claims notify real contractors only) is unit-tested at the fan-out
 * selection layer — supabase/functions/notify-contractors/
 * test-exclusion.test.ts — because invoking the live EF from CI would send
 * real email. The live wiring was verified once via a dry invocation at v70
 * deploy time (see #564 closure evidence).
 *
 * Fills the "no bid-flow spec in current main E2E set" gap documented in
 * #564 evidence item 6.
 */

import { test, expect } from '@playwright/test';
import {
  generateMagicLink,
  getTestState,
  createAdminClient,
  type TestState,
} from '../helpers/auth.js';

// Spec-scoped real-side contractor (S2). Internal-domain email keeps the
// #543 fan-out exclusion; is_test=false makes RLS treat it as real.
const REAL_SIDE_EMAIL = 'real-side-564@otterquote-internal.test';
const SEED_ADDRESS_MARKER = '100 E Test St';

/** Magic-link login + session-persisted wait. Mirrors contractor-journey.spec.ts. */
async function loginViaMagicLink(
  page: import('@playwright/test').Page,
  email: string,
  baseUrl: string
) {
  const magicLink = await generateMagicLink(email, `${baseUrl}/contractor-dashboard.html`);
  await page.goto(magicLink);
  await page.waitForURL(/contractor-dashboard/, { timeout: 30_000 });
  await page.waitForLoadState('load');
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
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {
    // Non-fatal — token is in storage, proceed.
  });
}

/** Opens contractor-opportunities and waits for the panel to actually render. */
async function openOpportunities(page: import('@playwright/test').Page) {
  await page.goto('/contractor-opportunities.html');
  await page.waitForLoadState('load');
  await expect(page).not.toHaveURL(/login|get-started/);
  // Panel must render before any absence assertion is meaningful.
  await expect(page.locator('body')).toContainText(/opportunit/i);
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
}

test.describe('Flow S — #564 test-world symmetry', () => {
  let state: TestState;
  let realSideUserId: string | null = null;

  test.beforeAll(async () => {
    state = getTestState();
    const admin = createAdminClient();

    // Preconditions — fail loudly if the world isn't shaped as v96 expects.
    const { data: claim } = await admin
      .from('claims')
      .select('is_test, ready_for_bids, status')
      .eq('id', state.testClaimId)
      .single();
    if (!claim || claim.is_test !== true) {
      throw new Error(
        `Precondition failed: seeded claim ${state.testClaimId} must be is_test=true ` +
          `(got ${JSON.stringify(claim)}). Re-run npm run seed (post-#564 seed stamps claims).`
      );
    }
    const { data: contractor } = await admin
      .from('contractors')
      .select('is_test, status')
      .eq('id', state.contractorId)
      .single();
    if (!contractor || contractor.is_test !== true || contractor.status !== 'active') {
      throw new Error(
        `Precondition failed: seeded contractor ${state.contractorId} must be active + is_test=true ` +
          `(got ${JSON.stringify(contractor)}).`
      );
    }

    // S2 fixture: real-flagged contractor, spec-scoped, cleaned in afterAll.
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: REAL_SIDE_EMAIL,
      email_confirm: true,
      user_metadata: { role: 'contractor' },
    });
    if (createErr) {
      if (createErr.status !== 422) {
        throw new Error(`createUser(${REAL_SIDE_EMAIL}) failed: ${createErr.message}`);
      }
      // Already exists from a previous interrupted run — targeted lookup.
      const resp = await fetch(
        `${process.env.SUPABASE_URL}/auth/v1/admin/users?filter=${encodeURIComponent(REAL_SIDE_EMAIL)}&page=1&per_page=1`,
        {
          headers: {
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
          },
        }
      );
      const body = await resp.json();
      realSideUserId = body.users?.[0]?.id ?? null;
      if (!realSideUserId) throw new Error(`Lookup after 422 found no user for ${REAL_SIDE_EMAIL}`);
    } else {
      realSideUserId = created.user.id;
    }

    const { error: profErr } = await admin.from('profiles').upsert(
      {
        id: realSideUserId,
        full_name: 'Real-Side Probe (E2E #564)',
        email: REAL_SIDE_EMAIL,
        phone: '317-555-0564',
        role: 'contractor',
        is_test: true, // profile flagged test — only the CONTRACTORS flag drives claims RLS
      },
      { onConflict: 'id' }
    );
    if (profErr) throw new Error(`Real-side profile upsert failed: ${profErr.message}`);

    const { data: existing } = await admin
      .from('contractors')
      .select('id')
      .eq('user_id', realSideUserId)
      .maybeSingle();
    const payload = {
      user_id: realSideUserId,
      status: 'active',
      // The point of S2: RLS must treat this contractor as REAL.
      is_test: false,
      company_name: 'Real-Side Probe Roofing (E2E #564)',
      contact_name: 'Real-Side Probe',
      email: REAL_SIDE_EMAIL, // internal domain — #543 keeps it out of real-claim fan-out
      phone: '317-555-0564',
      trades: ['roofing'],
      service_counties: ['IN:*'],
      address_state: 'IN',
    };
    const { error: upErr } = existing
      ? await admin.from('contractors').update(payload).eq('id', existing.id)
      : await admin.from('contractors').insert(payload);
    if (upErr) throw new Error(`Real-side contractor upsert failed: ${upErr.message}`);
  });

  test.afterAll(async () => {
    if (!realSideUserId) return;
    const admin = createAdminClient();
    await admin.from('contractors').delete().eq('user_id', realSideUserId);
    await admin.from('profiles').delete().eq('id', realSideUserId);
    await admin.auth.admin.deleteUser(realSideUserId);
  });

  // ──────────────────────────────────────────────────────────────────────────
  test('S1: test contractor SEES the test claim in opportunities (v96 carve-out)', async ({ page }) => {
    await loginViaMagicLink(page, state.contractorEmail, state.baseUrl);
    await openOpportunities(page);

    // The seeded test claim (is_test=true, roofing released, IN) must render.
    await expect(page.locator('body')).toContainText(SEED_ADDRESS_MARKER, { timeout: 15_000 });
  });

  // ──────────────────────────────────────────────────────────────────────────
  test('S2: real contractor sees NO test claims (#543 exposure stays closed)', async ({ page }) => {
    await loginViaMagicLink(page, REAL_SIDE_EMAIL, state.baseUrl);
    await openOpportunities(page);

    // No seed-corpus / E2E claim may render for a real-flagged contractor —
    // the #564 secondary finding ("fake opportunities") must stay dead.
    await expect(page.locator('body')).not.toContainText(SEED_ADDRESS_MARKER);
  });
});
