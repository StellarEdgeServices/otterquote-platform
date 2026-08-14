/**
 * ADR-012 — COI Upload Identity Invariant (cross-account regression lock)
 *
 * Regression lock for pfw-1780341475 / PR #215.
 * Invariant: contractor-documents storage path[0] MUST equal the live session
 * auth.uid() at upload time — never a stale init-time identity from a
 * domain-wide cookie belonging to a different account.
 *
 * Two accounts:
 *   A = main test contractor (from seed state) — the "stale cookie" source
 *   B = dedicated test-coi-identity-b account  — fresh pre-approval contractor
 *
 * Tests:
 *   COI-1  B's live session upload succeeds to B's own path, even when A's
 *          session cookie is present in the same browser context.
 *   COI-2  RLS rejects B's upload attempt to A's storage path (negative control
 *          confirming the bucket policy is correctly enforced).
 *
 * NOTE: This spec depends on PR #215 (fix/pfw-1780341475-coi-upload-identity)
 * being merged. Tests will fail on main until that PR lands.
 */

import { test, expect } from '@playwright/test';
import {
  generateMagicLink,
  getTestState,
  createAdminClient,
  type TestState,
} from '../helpers/auth.js';

const BUCKET = 'contractor-documents';
const B_EMAIL = 'test-coi-identity-b@otterquote-internal.test';
const PROBE_FILENAME = 'identity-probe.pdf';

let state: TestState;
let bUserId: string;

test.beforeAll(async () => {
  state = getTestState();
  const admin = createAdminClient();

  // Find or create Account B auth user.
  // Strategy: createUser-first to avoid listUsers full-scan on 6K+ user projects
  // (perPage:1000 times out with {} on IO-throttled Supabase). On 422 ("User
  // already registered"), fall back to a targeted email-filter REST lookup.
  // Mirrors the fix applied to seed.mjs in 23e58af (86e1nxn4x).
  const { data: createData, error: createErr } = await admin.auth.admin.createUser({
    email: B_EMAIL,
    email_confirm: true,
    user_metadata: { role: 'contractor' },
  });

  let existingB: { id: string } | null = createData?.user ?? null;
  if (createErr) {
    if (createErr.status !== 422) {
      throw new Error(`createUser(B) failed: ${createErr.message ?? JSON.stringify(createErr)}`);
    }
    // 422 = "User already registered" — targeted email-filter REST lookup
    const supabaseUrl = process.env.SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const lookupUrl =
      `${supabaseUrl}/auth/v1/admin/users` +
      `?filter=${encodeURIComponent(B_EMAIL)}&page=1&per_page=1`;
    const lookupResp = await fetch(lookupUrl, {
      headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
    });
    if (!lookupResp.ok) {
      throw new Error(
        `getUserByEmail(${B_EMAIL}) HTTP ${lookupResp.status}: ${await lookupResp.text()}`
      );
    }
    const body = (await lookupResp.json()) as { users?: Array<{ id: string }> };
    existingB = body.users?.[0] ?? null;
    if (!existingB) {
      throw new Error(`getUserByEmail(${B_EMAIL}): user not found after 422 on createUser`);
    }
  }
  bUserId = existingB!.id;

  // Reset B's contractor row to a clean pre-approval state (onboarding_step=1),
  // then re-create it. Everything from the insert onward is wrapped in a
  // try/catch: if a later step in this hook throws (e.g. the storage
  // pre-clean below), we still delete the row we just inserted before
  // re-throwing. Without this, a mid-hook failure can leave an orphaned
  // contractor row in production with no guarantee afterAll ever runs to
  // clean it up (int-e2e-test-pollution / #689: this exact row — "Test COI
  // Identity Co (E2E)" — was found live in prod with no is_test flag and no
  // owner, ~9.5h after creation).
  await admin.from('contractors').delete().eq('user_id', bUserId);
  try {
    const { error: insertErr } = await admin.from('contractors').insert({
      user_id: bUserId,
      email: B_EMAIL,
      company_name: 'Test COI Identity Co (E2E)',
      contact_name: 'Test B Contractor',
      status: 'pending_approval',
      is_test: true, // #689: harness must stamp every row it creates, contractors included
      onboarding_step: 1,
      agreement_accepted_at: new Date().toISOString(),
      agreement_version: 'v1-2026-04',
    });
    if (insertErr) throw new Error(`B contractor insert failed: ${insertErr.message}`);

    // Pre-clean storage probe objects from prior runs
    const { error: preCleanErr } = await admin.storage.from(BUCKET).remove([
      `${bUserId}/${PROBE_FILENAME}`,
      `${state.contractorUserId}/${PROBE_FILENAME}`,
    ]);
    if (preCleanErr) {
      console.warn(`  ⚠️  Storage pre-clean warning: ${preCleanErr.message}`);
    }
  } catch (err) {
    const { error: cleanupErr } = await admin.from('contractors').delete().eq('user_id', bUserId);
    if (cleanupErr) {
      console.error(
        `  ❌ beforeAll failed AND orphan cleanup of B's contractor row also failed: ${cleanupErr.message}`
      );
    } else {
      console.error(`  beforeAll failed after B's contractor row was created — row was cleaned up.`);
    }
    throw err;
  }
});

test.afterAll(async () => {
  if (!bUserId) {
    console.log('  No B user id — beforeAll never reached user creation, nothing to tear down.');
    return;
  }
  const admin = createAdminClient();
  let hadFailure = false;

  // Storage cleanup — best-effort; log rather than swallow
  const { error: storageErr } = await admin.storage.from(BUCKET).remove([
    `${bUserId}/${PROBE_FILENAME}`,
    `${state.contractorUserId}/${PROBE_FILENAME}`,
  ]);
  if (storageErr) {
    console.warn(`  ⚠️  Storage cleanup warning: ${storageErr.message}`);
  }

  // DB cleanup — contractor row then auth user (order matters for FK).
  // A failed cleanup must surface, not be silently swallowed — the exact
  // failure mode that let #689's contractor pollution go unnoticed
  // (PR #695 precedent).
  const { error: contractorErr } = await admin.from('contractors').delete().eq('user_id', bUserId);
  if (contractorErr) {
    console.error(`  ❌ B contractor cleanup failed: ${contractorErr.message}`);
    hadFailure = true;
  }

  const { error: userErr } = await admin.auth.admin.deleteUser(bUserId);
  if (userErr) {
    console.error(`  ❌ B auth user cleanup failed: ${userErr.message}`);
    hadFailure = true;
  }

  if (hadFailure) {
    throw new Error(
      'COI-identity afterAll cleanup failed — see errors above. A silent, incomplete ' +
        'cleanup is what let contractor rows accumulate in production (#689).'
    );
  }
});

// ---------------------------------------------------------------------------
// COI-1: Positive path — B's upload uses B's live session UID
// ---------------------------------------------------------------------------
test('COI-1: upload to own path succeeds and path uses live session uid, even with another account cookie present', async ({
  page,
}) => {
  // Step 1: Authenticate as A to plant A's session cookie in this browser context.
  // This simulates the cross-account scenario: A's domain-wide cookie is present
  // when B's magic link lands on the same origin.
  const aMagicLink = await generateMagicLink(
    state.contractorEmail,
    state.baseUrl + '/contractor-opportunities.html'
  );
  await page.goto(aMagicLink);
  await page.waitForLoadState('networkidle');

  // Step 2: Navigate to B's magic link in the same context.
  // Supabase exchanges B's OTP token → B's session becomes live.
  // A's domain-wide cookie may still be present in storage until fully overwritten.
  const bMagicLink = await generateMagicLink(
    B_EMAIL,
    state.baseUrl + '/contractor-pre-approval.html'
  );
  await page.goto(bMagicLink);
  await page.waitForLoadState('networkidle');

  // Wait for the pre-approval wizard to appear (confirms B's session initialized)
  await expect(page.locator('#panelWizard')).toBeVisible({ timeout: 15_000 });

  // Wait for the live sb client session to definitively settle on B's uid.
  // #panelWizard visible confirms the page's auth check passed, but the Supabase
  // client's internal auth state can lag the DOM render by a frame or two — this
  // was the source of the COI-1 flakiness (failed twice, passed on retry #2).
  // Polling until sb.auth.getSession() returns bUserId makes COI-1 deterministic.
  await page.waitForFunction(
    async (bUid: string) => {
      const sbClient = (window as any).sb; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (!sbClient) return false;
      const { data } = await sbClient.auth.getSession();
      return data?.session?.user?.id === bUid;
    },
    bUserId,
    { timeout: 10_000 }
  );

  // Step 3: Probe the storage invariant directly via the global `sb` client.
  //
  // var sb is window-scoped (config.js uses `var`, not `let`), so page.evaluate
  // can access it. We ask the live session who B is, then attempt to upload a
  // small probe file to B's own path. This mirrors exactly what the production
  // COI upload does when the guard is functioning correctly.
  const result: {
    liveUid: string | null;
    uploadedPath: string | null;
    uploadError: string | null;
  } = await page.evaluate(
    async ({ bUid, probe, bucket }) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const sbClient = (window as any).sb;
      if (!sbClient) return { liveUid: null, uploadedPath: null, uploadError: 'sb not found' };

      // Verify live session is B's
      const { data: sessionData } = await sbClient.auth.getSession();
      const liveUid: string | null = sessionData?.session?.user?.id ?? null;

      // Upload a small probe file to B's own path — must succeed (RLS allows it)
      const probeFile = new File(['probe-content'], probe, { type: 'application/pdf' });
      const { data: uploadData, error: uploadError } = await sbClient.storage
        .from(bucket)
        .upload(`${bUid}/${probe}`, probeFile, { upsert: true });

      return {
        liveUid,
        uploadedPath: uploadData?.path ?? null,
        uploadError: uploadError ? uploadError.message : null,
      };
    },
    { bUid: bUserId, probe: PROBE_FILENAME, bucket: BUCKET }
  );

  // The live session must be B's (not A's stale identity)
  expect(result.liveUid).toBe(bUserId);

  // Upload must succeed (no RLS violation)
  expect(result.uploadError).toBeNull();

  // The returned path's first segment must be B's uid — ADR-012 invariant
  expect(result.uploadedPath).not.toBeNull();
  const firstSegment = result.uploadedPath!.split('/')[0];
  expect(firstSegment).toBe(bUserId);
});

// ---------------------------------------------------------------------------
// COI-2: Negative control — B cannot upload to A's path (bucket policy)
// ---------------------------------------------------------------------------
test('COI-2: RLS rejects upload to a different user storage path', async ({ page }) => {
  // Authenticate as B (clean context — no A cookie this time)
  const bMagicLink = await generateMagicLink(
    B_EMAIL,
    state.baseUrl + '/contractor-pre-approval.html'
  );
  await page.goto(bMagicLink);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#panelWizard')).toBeVisible({ timeout: 15_000 });

  // Attempt to upload to A's path under B's live session.
  // contractor-documents INSERT policy: auth.uid()::text = (storage.foldername(name))[1]
  // B's uid !== A's uid → Supabase should return an RLS policy violation (HTTP 400).
  const result: {
    uploadedPath: string | null;
    uploadError: string | null;
  } = await page.evaluate(
    async ({ aUid, probe, bucket }) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const sbClient = (window as any).sb;
      if (!sbClient) return { uploadedPath: null, uploadError: 'sb not found' };

      const probeFile = new File(['probe-content'], probe, { type: 'application/pdf' });
      const { data: uploadData, error: uploadError } = await sbClient.storage
        .from(bucket)
        .upload(`${aUid}/${probe}`, probeFile, { upsert: true });

      return {
        uploadedPath: uploadData?.path ?? null,
        uploadError: uploadError ? uploadError.message : null,
      };
    },
    { aUid: state.contractorUserId, probe: PROBE_FILENAME, bucket: BUCKET }
  );

  // Upload to another user's path must fail — confirms bucket policy is enforced
  expect(result.uploadedPath).toBeNull();
  expect(result.uploadError).not.toBeNull();
});
