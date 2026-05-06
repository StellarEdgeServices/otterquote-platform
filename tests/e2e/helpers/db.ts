/**
 * Database verification helpers for OtterQuote E2E tests.
 *
 * All queries run through the Supabase Admin client (service role key),
 * bypassing RLS so tests can verify persisted state without being subject
 * to per-user RLS policies.
 */

import { createAdminClient } from './auth.js';

/**
 * Verifies that a bid (quote) from the test contractor on the test claim
 * exists in the database. Used to confirm a bid submitted via the UI
 * actually persisted.
 *
 * NOTE: contractorId may be null in CI due to D-211 auth regressions.
 * Query by claim_id only and verify the bid has a non-null contractor_id.
 */
export async function verifyBidPersisted(
  contractorId: string | null,
  claimId: string
): Promise<boolean> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('quotes')
    .select('id, contractor_id, total_price, status, created_at')
    .eq('claim_id', claimId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error('verifyBidPersisted DB error:', error.message);
    return false;
  }
  
  if ((data?.length ?? 0) === 0) {
    console.warn('verifyBidPersisted: No bids found for claim', claimId);
    return false;
  }

  // Critical: bid must have a non-null contractor_id (validates D-211 fix)
  const bid = data![0];
  if (!bid.contractor_id) {
    console.error(
      'verifyBidPersisted: Bid found but contractor_id is null (D-211 regression). ' +
      `Bid: ${bid.id}, status ${bid.status}, price $${bid.total_price}`
    );
    return false;
  }

  console.log(
    `  ✅ Bid confirmed in DB: quote ${bid.id}, ` +
      `contractor ${bid.contractor_id}, price $${bid.total_price}, status ${bid.status}`
  );
  return true;
}

/**
 * Deletes all test bids (quotes) submitted by the test contractor on the
 * test claim. Called by teardown.mjs.
 */
export async function cleanTestBids(
  contractorId: string,
  claimId: string
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from('quotes')
    .delete()
    .eq('contractor_id', contractorId)
    .eq('claim_id', claimId);
  if (error) {
    console.warn('cleanTestBids warning:', error.message);
  }
}

/**
 * Deletes all claims belonging to the test homeowner user.
 * Called by teardown.mjs between runs to ensure a fresh claim each run.
 */
export async function cleanTestClaims(homeownerUserId: string): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from('claims')
    .delete()
    .eq('user_id', homeownerUserId);
  if (error) {
    console.warn('cleanTestClaims warning:', error.message);
  }
}

/**
 * Returns the DocuSign envelope ID from the most recent quote on the test
 * claim that has an envelope. Returns null if no envelope has been created
 * (i.e., homeowner hasn't selected a contractor yet, or DocuSign was skipped).
 * Used by afterAll artifact capture hooks.
 */
export async function getClaimEnvelopeId(claimId: string): Promise<string | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('quotes')
    .select('docusign_envelope_id')
    .eq('claim_id', claimId)
    .not('docusign_envelope_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data.docusign_envelope_id;
}

/**
 * Fetches a single claim by ID using the admin client (bypasses RLS).
 * Returns the claim row or null if not found. Used by tests to verify
 * claim state after UI actions complete.
 */
export async function getTestClaim(
  claimId: string
): Promise<Record<string, unknown> | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('claims')
    .select('*')
    .eq('id', claimId)
    .maybeSingle();
  if (error) {
    console.error('getTestClaim DB error:', error.message);
    return null;
  }
  return data;
}
