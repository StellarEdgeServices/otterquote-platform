-- ============================================================================
-- OtterQuote Claims Test-Visibility Symmetry Migration
-- ============================================================================
-- Created: 2026-07-27
-- Version: v96
-- Depends on: the #543 test-exclusion closure (claims RLS is_test=false guard),
--             claims.is_test / contractors.is_test (both NOT NULL DEFAULT false)
--
-- Purpose (GitHub #564 — Tier 3B, CEO-approved Option A in the 2026-07-13
-- decision comment on the issue; R-097 satisfied via explicit in-session
-- approval — no separate 24h brief required):
--
--   Pre-flight-walk run pfw-1783974479 Stage 7 FAIL: a correctly
--   is_test-stamped walk claim can never appear in contractor opportunities,
--   because "Contractors can view biddable claims" hard-requires
--   is_test = false — colliding with the #543 item-4 stamping directive
--   (every walk artifact stamps is_test=true at creation).
--
--   Fix (CEO Option A — full test-world symmetry): a biddable claim is
--   visible when:
--     * claims.is_test = false (real claims — behavior unchanged), OR
--     * claims.is_test = true AND the requesting contractor's own
--       contractors row has is_test = true (test claims stay inside the
--       test world).
--   Real contractors can never see test claims — #543's exposure stays
--   closed. Test contractors continue to see real claims (unchanged; the
--   carve-out only restricts test-claim visibility).
--
--   Read-path sweep (2026-07-27, live prod): this policy is the ONLY object
--   in schema public carrying a hard claims.is_test filter. Scanned:
--   pg_policies (qual + with_check), pg_views definitions, pg_proc function
--   bodies. The only other is_test references are the contractors
--   privileged-column trigger guards (contractors_freeze_privileged_columns,
--   enforce_contractor_privileged_columns) — not claim read paths.
--   Client listing queries (contractor-opportunities.html:512-520, React
--   app) carry no is_test filter — visibility is decided entirely here.
--
-- Prior definition (production, captured verbatim via pg_policies 2026-07-27):
--   Policy "Contractors can view biddable claims" ON public.claims
--   FOR SELECT TO public USING (
--     (ready_for_bids = true) AND (is_test = false)
--     AND (status = ANY (ARRAY['active'::text, 'bidding'::text, 'pending'::text]))
--     AND ((SELECT auth.uid() AS uid) IN
--          (SELECT contractors.user_id FROM contractors
--            WHERE (contractors.status = 'active'::text))))
--
-- Companion rollback: v96-rollback-claims-test-visibility-symmetry.sql
-- Companion EF change: notify-contractors v70 (symmetric new_opportunity
--   fan-out — test claims notify test contractors only)
-- Decisions implemented: #564 CEO decision 1 (Option A), R-097
-- GitHub: #564
-- ============================================================================

BEGIN;

DROP POLICY "Contractors can view biddable claims" ON public.claims;

CREATE POLICY "Contractors can view biddable claims"
  ON public.claims
  FOR SELECT
  USING (
    ready_for_bids = true
    AND status = ANY (ARRAY['active'::text, 'bidding'::text, 'pending'::text])
    AND (SELECT auth.uid()) IN (
      SELECT contractors.user_id
      FROM public.contractors
      WHERE contractors.status = 'active'::text
    )
    AND (
      is_test = false
      OR (
        is_test = true
        AND (SELECT auth.uid()) IN (
          SELECT contractors.user_id
          FROM public.contractors
          WHERE contractors.status = 'active'::text
            AND contractors.is_test = true
        )
      )
    )
  );

COMMIT;

-- ============================================================================
-- POST-APPLY VERIFICATION
--   1. Definition check:
--        SELECT qual FROM pg_policies
--         WHERE schemaname = 'public' AND tablename = 'claims'
--           AND policyname = 'Contractors can view biddable claims';
--   2. Positive probe: an active is_test=true contractor SELECTs a biddable
--      is_test=true claim (walk claim 474af0fc) → row visible.
--   3. Negative probe: an active is_test=false contractor SELECTs the same
--      claim → zero rows.
--   Both probes are runnable via SET LOCAL ROLE authenticated +
--   request.jwt.claims sub = the contractor's user_id.
-- ============================================================================
