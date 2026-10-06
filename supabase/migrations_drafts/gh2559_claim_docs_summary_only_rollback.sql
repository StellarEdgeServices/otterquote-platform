-- STATUS (gh-1438, as of 2026-10-06T17:32:56Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh2559_claim_docs_summary_only (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: the forward file has not been applied (no ledger row; live policy is the world-fenced text of ledger version 20261006171747, pg_policies read 2026-10-06). This rollback was run inside the same rolled-back proof block as the forward file (supabase/tests/gh2559_claim_docs_summary_only_proof.sql).
-- REPO COPY: none. When the forward file is applied, move this file to supabase/migrations_rollbacks/ under the forward file's ledger version.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback for gh2559_claim_docs_summary_only.sql (gh-2559 item 3, D-368).
-- WARNING: this RE-OPENS what D-368 closed: a contractor in the claim's own world (test with test,
-- real with real) can again read every file in the folder of any claim that is open for bids, the
-- homeowner's uploaded insurance estimate included. Run it only if the narrowing refuses a read a
-- bidding contractor needs to price a job, and say so on #2559.
-- It restores the policy text that was live before the narrowing: the world-fenced text applied as
-- ledger version 20261006171747 (20261006171024_gh2559_claim_docs_world_fence). It does NOT remove
-- the world fence. Nothing else is touched.
-- If the forward file was applied with a ledger row, also delete that
-- supabase_migrations.schema_migrations row.
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
