-- STATUS (gh-1438, as of 2026-10-15T21:26:09Z): NOT APPLIED
-- FILE ROLE: forward file of set gh2559_claim_docs_fee_gate (the STATUS is the set's)
-- EVIDENCE: production read-only (Supabase MCP SELECT, project yeszghaspzwwstvsrioa) 2026-10-15T21:3xZ by the cto68-d386 builder (CTO RUN 68): the live policy "Contractors can view biddable claim docs" is the selected-contractor-only text of ledger version 20261008231142 (gate: c.selected_contractor_id = ct.id, no fee condition); claims.platform_fee_charged boolean DEFAULT false, nullable; trigger claims_guard_platform_fee_charged live (ledger 20261015205709 gh2491_claims_platform_fee_charged_guard). Rows that change behaviour today: 0 real claims have a selected contractor, 0 claims of any kind have a selected contractor AND an estimate, 0 active real contractors (counts only).
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md (Tier 3B path: review, R-097 notice, recorded apply)
--
-- Migration: gh2559_claim_docs_fee_gate
-- GitHub: #2559 (fee leg). Decision: D-386 (Dustin, #2696 comment 6084050178 "Approve default (Recommended)"; Contractor
--   Agreement 6.2): "The Homeowner's phone number and email address, and the Homeowner's full insurance estimate, are
--   released to Contractor only after the Platform Fee has been successfully collected."
-- Tier: 3B (read access to homeowner files, consent/privacy). NOT APPLIED by the authoring session or by CI. It removes
--   read access (a selected contractor loses the file between selection and fee collection) and adds none.
-- Rollback: gh2559_claim_docs_fee_gate_rollback.sql
-- Pre-flight: gh2559_claim_docs_fee_gate_pre-flight.md
-- Proof (rolled back, role-switched, is_test fixtures only): supabase/tests/gh2559_claim_docs_fee_gate_proof.sql
--
-- ONE CHANGE: the storage policy "Contractors can view biddable claim docs" gains one condition on its only
-- remaining branch, the selected contractor's:
--     AND c.platform_fee_charged IS TRUE
-- Today the branch is "c.selected_contractor_id = ct.id", so the contractor the homeowner selects opens every file in
-- the claim's folder at SELECTION, before the contract is signed and before the fee is charged. After this change the
-- same contractor opens them only once the claim's platform fee has been collected.
--
-- THE FEE SIGNAL. claims.platform_fee_charged is the signal, and it is the only one: it is written true only on a
-- confirmed success (docusign-webhook, synchronous card success, same update that flips the claim to contract_signed;
-- stripe-webhook payment_intent.succeeded for an ACH fee that settles later), and a client session cannot write it
-- (trigger claims_guard_platform_fee_charged, gh-2491, live). It is NULLABLE, so the test is "IS TRUE": NULL and false
-- both refuse. A pending or processing payment leaves it false, so the file stays closed until the money has moved.
--
-- WHY THE WHOLE FOLDER AND NOT ONLY "THE ESTIMATE". D-386 names the full insurance estimate. This policy cannot tell the
-- estimate from the other objects in {homeowner_uid}/{claim_id}/: the homeowner chooses the file, its name and the slot
-- (see the gh2559_claim_docs_summary_only header), and on the one real claim that has an estimate the "measurements"
-- slot holds a byte-identical copy of it. Any rule that opened the other files at selection would open the estimate.
-- So the folder follows the estimate, which is also Ben's stated default (#2559 comment 6199982599: the loss sheet,
-- aerial measurements and photos follow the estimate unless the CTO finds a product reason). If a product reason is
-- found, the fix is a platform-written marker object (first path segment = claim id), not a label a homeowner sets.
--
-- WHAT DOES NOT CHANGE: the policy name, command, role and bucket test; the claim-owner policy ("Users can view own
-- files"), the service role policy and every other policy on storage.objects; public.claims, its policies and triggers;
-- public.bidder_claim_summary (the view returns file PATHS to the selected contractor, not file contents, and the
-- parsed line-item summary, which D-368 already lets a bidder read); every edge function. The contractor pages still
-- show a Loss Sheet / View Measurements button to the selected contractor before the fee; until the pages learn the
-- fee state the button answers "Unable to open" (page change is a separate PR, see the pre-flight).
--
-- PHONE AND EMAIL (D-386 also names them) ARE NOT THIS OBJECT. No contractor-readable policy or view exposes them:
-- profiles is owner-read only and claims has no phone or email column. They reach the contractor through edge
-- functions on the service role (see the pre-flight, "Phone and email", for what was found). Not changed here.
--
-- Self-check: the DO block raises (and the transaction rolls back) if the policy is missing afterwards or does not
-- carry the fee condition.
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
      AND c.platform_fee_charged IS TRUE
  )
);

DO $check$
DECLARE
  v_qual text;
BEGIN
  SELECT qual INTO v_qual
    FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'Contractors can view biddable claim docs';
  IF v_qual IS NULL OR v_qual NOT LIKE '%platform_fee_charged%' OR v_qual NOT LIKE '%selected_contractor_id%' THEN
    RAISE EXCEPTION 'gh2559 fee gate: policy missing or without the fee / selected conditions' USING ERRCODE = 'P0A03';
  END IF;
END
$check$;

COMMIT;
