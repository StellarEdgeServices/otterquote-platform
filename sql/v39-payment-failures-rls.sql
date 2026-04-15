/**
 * OtterQuote SQL Migration v39: Enable RLS on payment_failures
 *
 * SECURITY FIX (Session 174, Apr 15, 2026) — closes a pre-existing data
 * exposure discovered during the Deploy Review Checklist calibration audit.
 *
 * BACKGROUND
 *   The payment_failures table was created by v31-payment-dunning.sql without
 *   RLS enabled. The client (contractor-dashboard.html) reads from it using
 *   the Supabase anon key with a client-side `.eq('contractor_id', ...)` filter.
 *   Because RLS was off, any authenticated user could remove that filter in
 *   browser devtools and read ALL contractors' payment failure rows — Stripe
 *   payment intent IDs and dunning state included.
 *
 * FIX
 *   1. Enable RLS on payment_failures.
 *   2. Policy: contractors can SELECT/UPDATE their own rows only.
 *      Matches the pattern established in v5, v10, v33.
 *   3. Policy: admin (dustinstohler1@gmail.com) can do anything.
 *      Matches the pattern established in v35.
 *   4. Service role bypasses RLS automatically — Edge Functions (process-dunning,
 *      create-payment-intent) remain unaffected.
 *
 * VERIFICATION (post-apply)
 *   - As a non-admin authenticated user, run in browser devtools:
 *       await sb.from('payment_failures').select('*')
 *     Expected: returns only rows where contractor_id matches the caller,
 *     or empty if they have no payment failures.
 *   - Contractor dashboard dunning UI continues to load rows for the logged-in
 *     contractor (existing .eq filter becomes redundant but harmless).
 *   - Admin console (admin-contractors.html / admin-contractor-action Edge
 *     Function) continues to see all rows — service role bypass unchanged.
 *
 * ClickUp: 86e0xhy8r
 */

-- Enable RLS
ALTER TABLE payment_failures ENABLE ROW LEVEL SECURITY;

-- Contractor can SELECT their own payment_failures rows
CREATE POLICY "contractor_select_own_payment_failures" ON payment_failures
  FOR SELECT USING (
    contractor_id IN (SELECT id FROM contractors WHERE user_id = auth.uid())
  );

-- Contractor can UPDATE their own payment_failures rows (e.g., acknowledging dunning)
CREATE POLICY "contractor_update_own_payment_failures" ON payment_failures
  FOR UPDATE USING (
    contractor_id IN (SELECT id FROM contractors WHERE user_id = auth.uid())
  );

-- Admin can SELECT all payment_failures rows
CREATE POLICY "admin_select_payment_failures" ON payment_failures
  FOR SELECT USING (
    auth.jwt() ->> 'email' = 'dustinstohler1@gmail.com'
  );

-- Admin can UPDATE all payment_failures rows
CREATE POLICY "admin_update_payment_failures" ON payment_failures
  FOR UPDATE USING (
    auth.jwt() ->> 'email' = 'dustinstohler1@gmail.com'
  );

-- Note: No INSERT or DELETE policies. INSERT is performed by the
-- process-dunning Edge Function and create-payment-intent (service role —
-- bypasses RLS). DELETE is not a supported application operation on this
-- table; resolved records are marked with dunning_status='resolved', not
-- deleted. If DELETE becomes needed, add an admin-only policy.
