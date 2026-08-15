-- 20260727133841_v96_claims_test_visibility_symmetry.sql
--
-- RETROACTIVE CAPTURE (GitHub #746, captured 2026-08-15). This migration
-- was applied to production (yeszghaspzwwstvsrioa) on 2026-07-27 as live
-- ledger entry 20260727133841 | v96_claims_test_visibility_symmetry
-- (PR #581 / issue #564, Tier 3B with R-097 in-session approval), but the
-- replay-chain file was never committed to supabase/migrations/. This
-- file closes that gap, following the same retroactive-capture pattern as
-- the v102 capture (PR #799).
--
-- PROVENANCE / BYTE-FAITHFULNESS: everything below the BEGIN-VERBATIM
-- marker is copied byte-verbatim from the live ledger's stored statement
-- text -- the exact SQL that ran in production, not retyped:
--   SELECT statements[1] FROM supabase_migrations.schema_migrations
--    WHERE version = '20260727133841';
--   md5(statements[1]) = 1202e444aa17fb23c16f3b2dc37c5323 (942 bytes,
--   no trailing newline) -- verified against this file's verbatim
--   section at capture time (2026-08-15).
-- The authored working record (fuller header, BEGIN/COMMIT wrapper,
-- pre/post verification steps, prior policy definition captured verbatim
-- pre-apply) is sql/v96-claims-test-visibility-symmetry.sql, committed by
-- PR #581. The text below is what the ledger actually holds.
--
-- WHAT IT DOES: replaces the "Contractors can view biddable claims"
-- SELECT policy on public.claims with a test-world-symmetric version:
-- a biddable claim is visible when is_test = false (real claims --
-- behavior unchanged) OR (is_test = true AND the requesting contractor's
-- own contractors row has is_test = true). Real contractors can never
-- see test claims (#543's exposure stays closed); test claims stay
-- inside the test world. Purpose confirmed for #746: driven by #564
-- (pre-flight-walk Stage 7 notification/visibility starvation), NOT the
-- #465 ghost-claim loop (related test-data hygiene, different issue).
--
-- REPLAY SAFETY: the introspected baseline
-- 20260101000000_v000_baseline_schema.sql (issue #385, captured from
-- live production AFTER v96 was applied) already creates this policy in
-- its post-v96 form. On a fresh-branch replay this file runs after the
-- baseline, so DROP POLICY finds the policy present and CREATE POLICY
-- recreates the identical definition -- a net no-op that keeps the chain
-- convergent with production while restoring per-migration history.
--
-- Rollback (manual-use only, never in the replay path):
--   supabase/migrations_rollbacks/
--     20260727133841_v96_claims_test_visibility_symmetry_rollback.sql
--   (byte-copy of sql/v96-rollback-claims-test-visibility-symmetry.sql;
--   restores the pre-v96 policy, which was captured verbatim from
--   production before v96 was authored).
--
-- ==== BEGIN-VERBATIM-APPLIED-STATEMENT (do not edit below this line) ====
-- v96 (GitHub #564, CEO Option A 2026-07-13, Tier 3B pre-cleared, R-097
-- in-session approval): symmetric test-world visibility on biddable claims.
-- Full record: sql/v96-claims-test-visibility-symmetry.sql (+ rollback).

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
