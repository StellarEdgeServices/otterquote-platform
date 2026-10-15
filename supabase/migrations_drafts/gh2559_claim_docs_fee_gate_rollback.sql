-- STATUS (gh-1438, as of 2026-10-15T21:26:09Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh2559_claim_docs_fee_gate (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: forward file not applied; the CREATE POLICY text below is the live text of ledger version 20261008231142 (gh2559_claim_docs_summary_only), read from pg_policies 2026-10-15
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md. Rollback only on a human decision, after saying so on #2559.
--
-- Rollback for gh2559_claim_docs_fee_gate.sql (gh-2559 fee leg, D-386).
-- WARNING: this RE-OPENS what D-386 closes: the contractor the homeowner selects can again open every file in the
-- claim's folder, the insurance estimate included, from the moment of selection, before the Platform Fee is collected.
-- Run it only if the fee gate refuses a read the selected contractor legitimately needs after the fee, and say so on #2559.
-- Restores exactly the policy text that was live before the forward file (selected contractor, no fee condition).
-- Nothing else is touched (the forward file changes nothing but this policy). No ledger row is created by the forward
-- file's apply path in this repo; if the apply recorded one, delete that supabase_migrations.schema_migrations row.
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
      AND c.selected_contractor_id = ct.id
  )
);

COMMIT;
