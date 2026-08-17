-- ============================================================================
-- OtterQuote Claims Test-Visibility Symmetry — ROLLBACK
-- ============================================================================
-- Created: 2026-07-27
-- Version: v96 rollback (companion to v96-claims-test-visibility-symmetry.sql)
--
-- Restores the pre-v96 "Contractors can view biddable claims" policy,
-- captured VERBATIM from production via pg_policies on 2026-07-27 BEFORE
-- v96 was authored: biddable claims visible only when is_test = false —
-- i.e. test claims invisible to ALL contractors, including test contractors.
--
-- ⚠️  CONSEQUENCE — READ BEFORE RUNNING:
--   Rolling back re-opens the #564 Stage-7 collision: is_test-stamped walk /
--   E2E claims become invisible to the walk's own test contractors, and the
--   bid-flow regression spec (test-world-symmetry.spec.ts) plus PFW Stage 7
--   will FAIL again. It does NOT create any real-contractor exposure (the
--   rollback is strictly more restrictive). If notify-contractors v70 is
--   live, its test-claim fan-out will notify test contractors about claims
--   they can no longer see — roll the EF back to v69 in the same window.
--
-- GitHub: #564
-- ============================================================================

BEGIN;

DROP POLICY "Contractors can view biddable claims" ON public.claims;

CREATE POLICY "Contractors can view biddable claims"
  ON public.claims
  FOR SELECT
  USING (
    ready_for_bids = true
    AND is_test = false
    AND status = ANY (ARRAY['active'::text, 'bidding'::text, 'pending'::text])
    AND (SELECT auth.uid()) IN (
      SELECT contractors.user_id
      FROM public.contractors
      WHERE contractors.status = 'active'::text
    )
  );

COMMIT;

-- ============================================================================
-- POST-ROLLBACK VERIFICATION
--   SELECT qual FROM pg_policies
--    WHERE schemaname = 'public' AND tablename = 'claims'
--      AND policyname = 'Contractors can view biddable claims';
--   → qual must again contain "(is_test = false)" as an unconditional AND arm.
-- ============================================================================
