-- STATUS (gh-1438, as of 2026-10-07T19:20:06Z): NOT APPLIED
-- FILE ROLE: forward file of set gh2559_claim_docs_summary_only (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: cut down 2026-10-07T19:20:06Z to the storage policy alone, after REVIEW: FAIL on #2569 (comment 6024856617, option A) and the CEO ruling (comment 6029315131, item A: the bid-open trigger is OUT of this PR). The CREATE POLICY statement below is byte-identical to the one at head c60b216f, which was proved forward and rollback on production inside rolled-back blocks (review 6024856617 finding 9; supabase/tests/gh2559_claim_docs_summary_only_proof.sql). The live policy is the world-fenced text of ledger version 20261006171747 (pg_policies read 2026-10-06). No ledger row exists for this set.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh2559_claim_docs_summary_only
-- GitHub: #2559 item 3. Decision: D-368 (Dustin, 2026-10-06, comment 6018744630, "Summary only (Recommended)"),
--   extended by his answer of 2026-10-07 (comment 6038067961, question 1, the measurement report: "Hide it (Recommended)").
-- Tier: 3B. It removes read access from contractors on real homeowners' files. It waits for its
--   24-hour notice (R-097) on #2559 and is applied only after that window and the conditions of
--   comment 6029315131 (item B), never from this directory.
-- Rollback: supabase/migrations_drafts/gh2559_claim_docs_summary_only_rollback.sql
-- Pre-flight: supabase/migrations_drafts/gh2559_claim_docs_summary_only_pre-flight.md
-- Proof (rolled back, role-switched): supabase/tests/gh2559_claim_docs_summary_only_proof.sql
--
-- ONE CHANGE: the storage policy "Contractors can view biddable claim docs". Nothing on public.claims.
--
-- D-368: before a contractor is selected, a contractor bidding on a claim sees only a summary of the
-- homeowner's uploaded insurance estimate, not the file. The policy used to let every active
-- contractor read EVERY object in {homeowner_uid}/{claim_id}/ of a claim open for bids.
--
-- What decides what a bidder may read now: NOTHING a homeowner can label. Every object in that folder
-- is written by the homeowner's own session ("Users can upload to own folder" requires only that the
-- first path segment is her user id; the second segment, the file name and the slot she picks in the
-- dashboard are all hers). A file named as "measurements" can be her estimate: on the one real claim
-- that has an estimate, the measurements slot holds a byte-identical copy of it. So no rule over
-- {folder, name, slot} can separate the estimate from the rest. Dustin's answer on the measurement
-- report (comment 6038067961) settles the slot: it is hidden from a bidder with the estimate.
-- The platform's own measurement pipeline writes under a different prefix that no client policy
-- permits (get-hover-pdf: {claim_id}/hover_measurements_*.pdf; admin-measurements.html:
-- {admin_uid}/measurements/{claim_id}/*.pdf), and neither path has the claim id in second position,
-- so the old bidding branch never reached them either; bidders get that PDF through the get-hover-pdf
-- edge function, which this migration does not touch.
-- The bidding branch is REMOVED. A bidding contractor reads no raw object of the bucket at all; the
-- summary lives in public.claims, not in storage. The only branch left is the selected contractor's,
-- unchanged.
-- (If a bidder-readable raw file is ever wanted, the smallest server-only marker is a platform-written
--  object whose FIRST path segment is the claim id: no client policy lets a user write there, because
--  the insert policy requires the first segment to equal the caller's user id. The proof file shows a
--  homeowner session refused at that path. It is not built here.)
--
-- What does not change: the selected-contractor branch ("c.selected_contractor_id = ct.id") reads every
-- file in the claim's folder exactly as today (the guard on claims.selected_contractor_id and
-- claims.platform_fee_charged, and the fee leg, stay named on #2559 as its remaining parts); the policy
-- name, command, role, bucket test and path convention; every other policy on storage.objects;
-- public.claims, its policies and its triggers.
-- The world fence (c.is_test = ct.is_test) lived only on the removed bidding branch, so it leaves with
-- it: a bidder in either world now reads zero objects (rows F1 to F3 of the proof).
--
-- NOT IN THIS FILE (cut by comment 6029315131 item A): the bid-open trigger of the previous head. A
-- claim whose estimate was never read into a summary can still open for bids; with every raw file
-- refused to a bidder, that means no summary panel for it, not a file. The two conditions the trigger
-- was meant to enforce (no bid opens on an unread estimate; no identity in a summary) stay on #2559
-- as a named remaining part of that issue's closes-on.
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
