/**
 * AR-5 — Auth.getSession() fast-path identity reconciliation
 *
 * Regression lock for 86e1p4n2k (D-212 fast-path identity bleed fix).
 *
 * Problem: Auth.getSession() had a fast-path that decoded the domain-wide
 * sb-otterquote-at cookie locally and returned it without reconciling against
 * the live sb client session. When a different account was previously active
 * (e.g. operator/admin, or the PFW harness), the stale cookie uid was returned
 * while the live client held a different user. This caused RLS violations on
 * any storage path that used Auth.getSession() to derive the upload path
 * (ADR-012 / pfw-1780341475 COI upload 400).
 *
 * Fix: fast-path now calls sb.auth.getSession() for reconciliation before
 * returning. On uid mismatch: prefer live session and clear stale cookies.
 *
 * Test: sign in as B, overwrite sb-otterquote-at with a synthetic stale token
 * whose sub != B's uid, then assert Auth.getSession() returns B's live uid.
 */

import { test, expect } from '@playwright/test';
import {
  generateMagicLink,
  getTestState,
  createAdminClient,
  type TestState,
} from '../helpers/auth.js';

const B_EMAIL = 'test-auth-reconcile-b@otterquote-internal.test';

let state: TestState;
let bUserId: string;

test.beforeAll(async () => {
  state = getTestState();
  const admin = createAdminClient();

  const { data: listData, error: listErr } =
    await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listErr) throw new Error(`listUsers failed: ${listErr.message}`);

  let existingB = listData?.users?.find((u) => u.email === B_EMAIL);
  if (!existingB) {
    const { data, error } = await admin.auth.admin.createUser({
      email: B_EMAIL,
      email_confirm: true,
      user_metadata: { role: 'contractor' },
    });
    if (error) throw new Error(`createUser(B) failed: ${error.message}`);
    existingB = data.user!;
  }
  bUserId = existingB.id;

  // Ensure B has a contractors row so the pre-approval wizard renders
  await admin.from('contractors').delete().eq('user_id', bUserId);
  const { error: insertErr } = await admin.from('contractors').insert({
    user_id: bUserId,
    email: B_EMAIL,
    company_name: 'Test Auth Reconcile Co (E2E)',
    contact_name: 'Test AR-5 Contractor',
    status: 'pending_approval',
    onboarding_step: 1,
    agreement_accepted_at: new Date().toISOString(),
    agreement_version: 'v1-2026-04',
  });
  if (insertErr) throw new Error(`B contractors insert failed: ${insertErr.message}`);
});

test.afterAll(async () => {
  const admin = createAdminClient();
  await admin.from('contractors').delete().eq('user_id', bUserId);
  await admin.auth.admin.deleteUser(bUserId);
});

// ---------------------------------------------------------------------------
// AR-5: Fast-path reconciliation — live session uid wins over stale cookie
// ---------------------------------------------------------------------------
test('AR-5: Auth.getSession() returns live uid when sb-otterquote-at cookie has stale identity', async ({
  page,
}) => {
  // Step 1: Sign in as A (seed contractor) to plant A's session cookies in this
  //         browser context. This simulates a prior session from a different account.
  const aMagicLink = await generateMagicLink(
    state.contractorEmail,
    state.baseUrl + '/contractor-dashboard.html'
  );
  await page.goto(aMagicLink);
  await page.waitForLoadState('networkidle');

  // Step 2: Sign in as B in the same browser context — Supabase updates the live
  //         client session to B and rewrites the domain cookies with B's tokens.
  const bMagicLink = await generateMagicLink(
    B_EMAIL,
    state.baseUrl + '/contractor-pre-approval.html'
  );
  await page.goto(bMagicLink);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#panelWizard')).toBeVisible({ timeout: 15_000 });

  // Verify the live sb client session is B's before we plant the stale cookie.
  const liveBUid: string | null = await page.evaluate(async () => {
    const r = await (window as any).sb.auth.getSession();
    return r?.data?.session?.user?.id ?? null;
  });
  expect(liveBUid).toBe(bUserId);

  // Step 3: Overwrite sb-otterquote-at with a synthetic stale token whose sub is A's uid.
  //
  // This reproduces the ADR-012 failure mode: a domain-wide cookie carrying a
  // foreign identity survives a new sign-in on a different subdomain or via a
  // race between cookie writes. The token has exp in the future so the
  // fast-path *would* return it without reconciliation (the pre-fix behavior).
  const staleUid = state.contractorUserId; // A's uid
  const staleExp = Math.floor(Date.now() / 1000) + 3600;

  await page.evaluate(
    ({ staleUid, staleExp }) => {
      const h = btoa('{"alg":"HS256","typ":"JWT"}');
      const p = btoa(
        JSON.stringify({
          sub: staleUid,
          exp: staleExp,
          aud: 'authenticated',
          role: 'authenticated',
          email: 'stale-cookie@test.com',
        })
      );
      const staleJwt = h + '.' + p + '.fake_signature_for_test_only';
      const domain =
        window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1'
          ? ''
          : '; Domain=.otterquote.com';
      document.cookie =
        'sb-otterquote-at=' +
        encodeURIComponent(staleJwt) +
        '; Path=/' + domain +
        '; SameSite=Lax; Max-Age=3600';
    },
    { staleUid, staleExp }
  );

  // Step 4: Call Auth.getSession() — the reconciliation must detect the mismatch
  // (stale cookie sub ≠ live session uid) and return the live session.
  const result: {
    uid: string | null;
    warnFired: boolean;
  } = await page.evaluate(async () => {
    let warnFired = false;
    const origWarn = console.warn.bind(console);
    (console as any).warn = (...args: unknown[]) => {
      if (String(args[0]).includes('[Auth.getSession] identity mismatch')) warnFired = true;
      origWarn(...args);
    };
    const session = await (window as any).Auth.getSession();
    (console as any).warn = origWarn;
    return { uid: session?.user?.id ?? null, warnFired };
  });

  // Must return B's uid from the live session — not the stale A uid from the cookie
  expect(result.uid).toBe(bUserId);
  expect(result.uid).not.toBe(staleUid);

  // Reconciliation code must have fired (confirms the fast-path exercised the new check)
  expect(result.warnFired).toBe(true);
});
