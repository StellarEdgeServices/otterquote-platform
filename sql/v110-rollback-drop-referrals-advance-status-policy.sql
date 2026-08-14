-- ============================================================================
-- v110 ROLLBACK — restore "Authenticated can advance referral status"
-- ============================================================================
-- Restores the v87 policy verbatim, pre-v110-drop. Run manually if v110
-- needs to be reverted; do not rename into a CLI-parseable timestamp or
-- place in supabase/migrations/ (see supabase/migrations/README.md).
-- ============================================================================

BEGIN;

CREATE POLICY "Authenticated can advance referral status"
  ON public.referrals
  FOR UPDATE
  TO authenticated
  USING  (status = 'clicked')
  WITH CHECK (status = 'registered');

COMMIT;
