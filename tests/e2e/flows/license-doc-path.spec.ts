/**
 * 86e1nyc60 follow-through - License document storage path RLS regression lock
 *
 * Invariant (D-220 UID-first convention, same family as ADR-012): the
 * contractor-documents INSERT policy admits only paths whose FIRST segment
 * equals auth.uid(). License documents therefore upload to
 * `${uid}/licenses/<ts>-<name>`.
 *
 * The legacy path `licenses/${uid}/...` (shipped in D-218 PR 2) put the
 * literal 'licenses' in segment 1, so every license upload was RLS-rejected
 * and - because the failure was swallowed as non-fatal - every
 * contractor_licenses row was saved with license_document_url = null and no
 * document ever reached storage (verified live 2026-07-12: 0 objects under
 * licenses/%, 0 rows with a non-null doc URL).
 *
 * Tests (probe via the page's live `sb` client, mirroring coi-upload-identity):
 *   LIC-1  upload to `${uid}/licenses/...` succeeds (fix-path invariant)
 *   LIC-2  upload to legacy `licenses/${uid}/...` is RLS-rejected (locks the
 *          policy reality that makes UID-first mandatory)
 */

import { test, expect } from '@playwright/test';
import {
  generateMagicLink,
  getTestState,
  createAdminClient,
  type TestState,
} from '../helpers/auth.js';

const BUCKET = 'contractor-documents';
const LIC_EMAIL = 'test-license-path@otterquote-internal.test';
const PROBE_FILENAME = 'license-path-probe.pdf';

let state: TestState;
let licUserId: string;

test.beforeAll(async () => {
  state = getTestState();
  const admin = createAdminClient();

  // Find or create the test auth user. createUser-first to avoid listUsers
  // full-scan (mirrors coi-upload-identity.spec.ts / seed.mjs 23e58af).
  const { data: createData, error: createErr } = await admin.auth.admin.createUser({
    email: LIC_EMAIL,
    email_confirm: true,
    user_metadata: { role: 'contractor' },
  });

  let existing: { id: string } | null = createData?.user ?? null;
  if (createErr) {
    if (createErr.status !== 422) {
      throw new Error(`createUser(${LIC_EMAIL}) failed: ${createErr.message ?? JSON.stringify(createErr)}`);
    }
    const supabaseUrl = process.env.SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const lookupUrl =
      `${supabaseUrl}/auth/v1/admin/users` +
      `?filter=${encodeURIComponent(LIC_EMAIL)}&page=1&per_page=1`;
    const lookupResp = await fetch(lookupUrl, {
      headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
    });
    if (!lookupResp.ok) {
      throw new Error(
        `getUserByEmail(${LIC_EMAIL}) HTTP ${lookupResp.status}: ${await lookupResp.text()}`
      );
    }
    const body = (await lookupResp.json()) as { users?: Array<{ id: string }> };
    existing = body.users?.[0] ?? null;
    if (!existing) {
      throw new Error(`getUserByEmail(${LIC_EMAIL}): user not found after 422 on createUser`);
    }
  }
  licUserId = existing!.id;

  // Clean contractors row at onboarding_step 1 so the wizard renders.
  await admin.from('contractors').delete().eq('user_id', licUserId);
  const { error: insertErr } = await admin.from('contractors').insert({
    user_id: licUserId,
    email: LIC_EMAIL,
    company_name: 'Test License Path Co (E2E)',
    contact_name: 'Test License Contractor',
    is_test: true, // #689: harness must stamp every row it creates, contractors included
    status: 'pending_approval',
    onboarding_step: 1,
    agreement_accepted_at: new Date().toISOString(),
    agreement_version: 'v1-2026-04',
  });
  if (insertErr) throw new Error(`contractors insert failed: ${insertErr.message}`);

  // Pre-clean probe objects from prior runs (both path shapes).
  await admin.storage.from(BUCKET).remove([
    `${licUserId}/licenses/${PROBE_FILENAME}`,
    `licenses/${licUserId}/${PROBE_FILENAME}`,
  ]);
});

test.afterAll(async () => {
  const admin = createAdminClient();
  await admin.storage.from(BUCKET).remove([
    `${licUserId}/licenses/${PROBE_FILENAME}`,
    `licenses/${licUserId}/${PROBE_FILENAME}`,
  ]);
  await admin.from('contractors').delete().eq('user_id', licUserId);
  await admin.auth.admin.deleteUser(licUserId);
});

/** Sign in via magic link and wait for the live sb session to settle. */
async function signInAndSettle(page: import('@playwright/test').Page): Promise<void> {
  const magicLink = await generateMagicLink(
    LIC_EMAIL,
    state.baseUrl + '/contractor-pre-approval.html'
  );
  await page.goto(magicLink);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#panelWizard')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(
    async (uid: string) => {
      const sbClient = (window as any).sb; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (!sbClient) return false;
      const { data } = await sbClient.auth.getSession();
      return data?.session?.user?.id === uid;
    },
    licUserId,
    { timeout: 10_000 }
  );
}

/** Upload a small probe file to the given path via the page's live sb client. */
async function probeUpload(
  page: import('@playwright/test').Page,
  path: string
): Promise<{ uploadedPath: string | null; uploadError: string | null }> {
  return page.evaluate(
    async ({ uploadPath, probe, bucket }) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const sbClient = (window as any).sb;
      if (!sbClient) return { uploadedPath: null, uploadError: 'sb not found' };
      const probeFile = new File(['probe-content'], probe, { type: 'application/pdf' });
      const { data, error } = await sbClient.storage
        .from(bucket)
        .upload(uploadPath, probeFile, { upsert: true });
      return {
        uploadedPath: data?.path ?? null,
        uploadError: error ? error.message : null,
      };
    },
    { uploadPath: path, probe: PROBE_FILENAME, bucket: BUCKET }
  );
}

// ---------------------------------------------------------------------------
// LIC-1: Positive path - UID-first license path uploads successfully
// ---------------------------------------------------------------------------
test('LIC-1: license doc upload to ${uid}/licenses/... succeeds', async ({ page }) => {
  await signInAndSettle(page);

  const result = await probeUpload(page, `${licUserId}/licenses/${PROBE_FILENAME}`);

  expect(result.uploadError).toBeNull();
  expect(result.uploadedPath).not.toBeNull();
  // D-220 / ADR-012 family invariant: first path segment is the auth uid.
  expect(result.uploadedPath!.split('/')[0]).toBe(licUserId);
});

// ---------------------------------------------------------------------------
// LIC-2: Negative control - legacy licenses/-prefixed path is RLS-rejected
// ---------------------------------------------------------------------------
test('LIC-2: license doc upload to legacy licenses/${uid}/... is RLS-rejected', async ({ page }) => {
  await signInAndSettle(page);

  const result = await probeUpload(page, `licenses/${licUserId}/${PROBE_FILENAME}`);

  // The pre-fix path must stay rejected; if this ever starts succeeding the
  // storage policy changed and the UID-first convention needs re-review.
  expect(result.uploadedPath).toBeNull();
  expect(result.uploadError).not.toBeNull();
  expect(result.uploadError!).toMatch(/row-level security|violates|Unauthorized/i);
});
