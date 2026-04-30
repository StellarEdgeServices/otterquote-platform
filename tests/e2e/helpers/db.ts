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
 */
export async function verifyBidPersisted(
  contractorId: string,
  claimId: string
): Promise<boolean> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('quotes')
    .select('id, total_price, status, created_at')
    .eq('contractor_id', contractorId)
    .eq('claim_id', claimId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error('verifyBidPersisted DB error:', error.message);
    return false;
  }
  const found = (data?.length ?? 0) > 0;
  if (found) {
    console.log(
      `  ✅ Bid confirmed in DB: quote ${data![0].id}, ` +
        `price $${data![0].total_price}, status ${data![0].status}`
    );
  }
  return found;
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
 * Verifies the test homeowner's claim exists in the database and is in
 * the expected status. Used by homeowner journey spec.
 */
export async function getTestClaim(claimId: string) {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('claims')
    .select('id, status, property_state, job_type, ready_for_bids')
    .eq('id', claimId)
    .single();
  if (error) return null;
  return data;
}
