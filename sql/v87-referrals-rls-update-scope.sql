-- ============================================================================
-- Migration v87 — Tighten referrals UPDATE policy
-- Created: 2026-06-13
-- ============================================================================
-- Problem:
--   The "Authenticated can update referrals" policy (added v16) has
--   USING(true) WITH CHECK(true) — any authenticated user can update any
--   referral row to any value. There are 0 rows in prod and no legitimate
--   need for open writes. The only real UPDATE path is auth.js advancing
--   a referral from status='clicked' → status='registered' after a homeowner
--   signs up via a referral link.
--
-- Decision:
--   Replace the broad policy with a scoped one:
--     USING: row must be in status='clicked' (not already processed)
--     WITH CHECK: the new status must be 'registered'
--   This closes arbitrary-status writes while preserving the one real path.
--
-- Read-site map (full repo grep — no .from('referrals').update found in
-- frontend other than js/auth.js:846):
--   js/auth.js:846 — homeowner advances clicked→registered after signup ✓
--   All other referrals reads are INSERT (ref landing pages) or SELECT
--   (partner-dashboard.html, supabase/functions/*) — not affected.
-- ============================================================================

BEGIN;

-- Drop the over-broad policy
DROP POLICY IF EXISTS "Authenticated can update referrals" ON public.referrals;

-- Replace with a scoped policy:
--   USING  → only touch rows that are still in 'clicked' state
--   WITH CHECK → only allow advancing to 'registered'
-- The homeowner_email field can be freely updated alongside status because
-- WITH CHECK validates the full new row and only constrains status.
CREATE POLICY "Authenticated can advance referral status"
  ON public.referrals
  FOR UPDATE
  TO authenticated
  USING  (status = 'clicked')
  WITH CHECK (status = 'registered');

COMMIT;
