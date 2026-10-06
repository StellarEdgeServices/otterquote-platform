-- Migration: 20261006171024_gh2559_claim_docs_world_fence
-- GitHub: #2559 (CONSENT / SECURITY; CEO handoff 6017797599, CTO ruling 6021154136 item 2).
-- Tier: 3B on the R-134 fast path. Protective only: it only removes read access. It grants nothing.
-- APPLIED to production (yeszghaspzwwstvsrioa) under R-134 by CTO RUN 61 (claim cto-2026-10-06T15:13:52Z):
--   supabase_migrations.schema_migrations version 20261006171747, name
--   '20261006171024_gh2559_claim_docs_world_fence'. NEVER RE-RUN by hand. These four comment lines were
--   added after the apply; every statement below is byte for byte what ran.
-- Rollback: supabase/migrations_rollbacks/20261006171024_gh2559_claim_docs_world_fence_rollback.sql
-- Pre-flight: supabase/migrations/20261006171024_gh2559_claim_docs_world_fence_pre-flight.md
-- Proof (rolled back, role-switched): supabase/tests/gh2559_claim_docs_world_fence_proof.sql
--
-- Problem. The storage policy "Contractors can view biddable claim docs" (v88, 20260708002834) lets
-- every contractor with status = 'active' read every file in the folder of any claim that is open for
-- bids. It has no is_test clause. A test-flagged contractor login can therefore open the uploaded
-- insurance documents of a real homeowner's claim.
--
-- Why this is NOT a copy of the claims-table fence. "Contractors can view biddable claims" on
-- public.claims reads (is_test = false) OR (is_test = true AND the caller is a test contractor). That
-- hides TEST claims from REAL contractors. It shows REAL claims to every active contractor, test-flagged
-- ones included, so copying it here would leave the hole open. The fence here is a WORLD MATCH:
-- on the bidding leg, the claim's is_test must equal the contractor's is_test.
--
-- What changes: one condition, "and c.is_test = ct.is_test", inside the ready_for_bids branch.
-- What does not change: the policy name, command (SELECT), role (authenticated), the bucket test, the
-- path convention {homeowner_uid}/{claim_id}/{filename}, the three bidding statuses, and the
-- selected-contractor branch (a contractor the homeowner selected keeps access as before). No other
-- policy, no table, no column, no grant, no data. The homeowner's own-file policies and the service-role
-- policy on the same bucket are separate policies and are not touched.
-- claims.is_test and contractors.is_test are NOT NULL in practice (0 NULLs on production 2026-10-06);
-- a NULL on either side makes the comparison NULL, which refuses the read (fails closed).
--
-- NOT in this migration: the D-368 narrowing to "summary only" before selection. That is a separate
-- Tier 3B change behind its own 24-hour notice.
BEGIN;

SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS "Contractors can view biddable claim docs" ON storage.objects;

CREATE POLICY "Contractors can view biddable claim docs"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'claim-documents'
  AND EXISTS (
    SELECT 1
    FROM public.claims c
    JOIN public.contractors ct
      ON ct.user_id = auth.uid()
     AND ct.status = 'active'
    WHERE c.id::text = (storage.foldername(objects.name))[2]
      AND (
        (
          c.ready_for_bids = true
          AND c.status IN ('active', 'bidding', 'pending')
          AND c.is_test = ct.is_test
        )
        OR c.selected_contractor_id = ct.id
      )
  )
);

COMMIT;
