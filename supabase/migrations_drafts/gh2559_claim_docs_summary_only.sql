-- STATUS (gh-1438, as of 2026-10-06T17:32:56Z): NOT APPLIED
-- FILE ROLE: forward file of set gh2559_claim_docs_summary_only (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: written 2026-10-06 for #2559 item 3 (D-368); proved forward and rollback on production inside one rolled-back block (supabase/tests/gh2559_claim_docs_summary_only_proof.sql); the live policy after that proof is the world-fenced text of ledger version 20261006171747 (pg_policies read, 2026-10-06). No ledger row exists for this set.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh2559_claim_docs_summary_only
-- GitHub: #2559 item 3. Decision: D-368 (Dustin, 2026-10-06, comment 6018744630, "Summary only (Recommended)").
-- Tier: 3B. It removes read access from contractors on real homeowners' files. It waits for its
--   24-hour notice (R-097) on #2559 and is applied only after that window, never from this directory.
-- Rollback: supabase/migrations_drafts/gh2559_claim_docs_summary_only_rollback.sql
-- Pre-flight: supabase/migrations_drafts/gh2559_claim_docs_summary_only_pre-flight.md
-- Proof (rolled back, role-switched): supabase/tests/gh2559_claim_docs_summary_only_proof.sql
--
-- Problem. D-368: before a contractor is selected, a contractor bidding on a claim sees only a summary
-- of the homeowner's uploaded insurance estimate, not the full file. The storage policy
-- "Contractors can view biddable claim docs" lets a contractor read EVERY object in the folder
-- {homeowner_uid}/{claim_id}/ of a claim that is open for bids, the uploaded estimate included.
--
-- What changes: ONE branch of ONE policy. On the bidding leg (the claim is open for bids and the
-- contractor is not the selected one) the contractor may read exactly one object: the file the claim
-- row names as its measurements upload (claims.measurements_filename), and only if that is not also
-- the object named as the estimate (claims.estimate_filename).
--
-- Why an allow-list and not "everything except the estimate". The only writer of that folder is the
-- homeowner dashboard's two upload slots (estimate, measurements); each upload gets a new timestamped
-- name and the old object stays in the folder. "Everything except claims.estimate_filename" would
-- therefore still hand a bidder every EARLIER upload of the estimate. Naming the one file a bidder
-- needs to price (the measurements upload) withholds the current estimate, earlier estimate uploads
-- and earlier measurement uploads in one condition.
--
-- What does not change:
--   * the selected-contractor branch ("or c.selected_contractor_id = ct.id"): the contractor the
--     homeowner selected reads every file in the claim's folder exactly as today. D-368's text covers
--     the time before selection only. Moving that branch to "after the fee is collected" (Contractor
--     Agreement section 6.2; CEO comment 6020252176) is a separate change that needs a guard on
--     claims.selected_contractor_id and claims.platform_fee_charged first; it is NOT in this file.
--   * the world fence (c.is_test = ct.is_test), the policy name, command (SELECT), role
--     (authenticated), the bucket test, the path convention and the three bidding statuses;
--   * every other policy on storage.objects: the homeowner's own-file policies, the service-role
--     policy and the video policies are separate policies and are not touched;
--   * public.claims: the parsed summary (claims.parsed_line_items, claims.contractor_scope_summary)
--     is a pair of columns on the claim row, not a storage object, so a bidder keeps it.
-- A NULL claims.measurements_filename makes the comparison NULL, which refuses the read (fails closed).
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
          AND objects.name = c.measurements_filename
          AND objects.name IS DISTINCT FROM c.estimate_filename
        )
        OR c.selected_contractor_id = ct.id
      )
  )
);

COMMIT;
