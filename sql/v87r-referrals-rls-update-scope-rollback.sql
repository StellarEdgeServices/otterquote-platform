-- ============================================================================
-- Rollback v87 — Restore broad referrals UPDATE policy
-- ============================================================================
-- Reverts v87-referrals-rls-update-scope.sql

BEGIN;

DROP POLICY IF EXISTS "Authenticated can advance referral status" ON public.referrals;

-- Restore the original v16 policy (unscoped)
CREATE POLICY "Authenticated can update referrals"
  ON public.referrals
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

COMMIT;
