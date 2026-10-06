-- STATUS (gh-1438, as of 2026-10-06T19:50:52Z): NOT APPLIED
-- FILE ROLE: forward file of set gh2559_claim_docs_summary_only (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: rebuilt 2026-10-06T19:50:52Z after REVIEW: FAIL on #2569 (comment 6023922644) and Ben's return (comment 6022309354); proved forward and rollback on production inside one rolled-back block (supabase/tests/gh2559_claim_docs_summary_only_proof.sql). The live policy is the world-fenced text of ledger version 20261006171747 (pg_policies read 2026-10-06). No ledger row exists for this set.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh2559_claim_docs_summary_only
-- GitHub: #2559 item 3. Decision: D-368 (Dustin, 2026-10-06, comment 6018744630, "Summary only (Recommended)").
-- Tier: 3B. It removes read access from contractors on real homeowners' files and adds a check on the
--   homeowner's submit-for-bids step. It waits for its 24-hour notice (R-097) on #2559 and is applied
--   only after that window, never from this directory.
-- Rollback: supabase/migrations_drafts/gh2559_claim_docs_summary_only_rollback.sql
-- Pre-flight: supabase/migrations_drafts/gh2559_claim_docs_summary_only_pre-flight.md
-- Proof (rolled back, role-switched): supabase/tests/gh2559_claim_docs_summary_only_proof.sql
--
-- PART 1. Storage policy "Contractors can view biddable claim docs".
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
-- {folder, name, slot} can separate the estimate from the rest, and the previous draft's allow-list
-- (the object named by claims.measurements_filename) was defeated by exactly that copy.
-- The platform's own measurement pipeline writes under a different prefix that no client policy
-- permits (get-hover-pdf: {claim_id}/hover_measurements_*.pdf; admin-measurements.html:
-- {admin_uid}/measurements/{claim_id}/*.pdf), and neither path has the claim id in second position,
-- so the old bidding branch never reached them either; bidders get that PDF through the get-hover-pdf
-- edge function, which this migration does not touch.
-- Safe default taken here: the bidding branch is REMOVED. A bidding contractor reads no raw object of
-- the bucket at all; the summary lives in public.claims, not in storage. The only branch left is the
-- selected contractor's, unchanged.
-- (If a bidder-readable raw file is ever wanted, the smallest server-only marker is a platform-written
--  object whose FIRST path segment is the claim id: no client policy lets a user write there, because
--  the insert policy requires the first segment to equal the caller's user id. The proof file shows a
--  homeowner session refused at that path. It is not built here.)
--
-- What does not change: the selected-contractor branch ("c.selected_contractor_id = ct.id") reads every
-- file in the claim's folder exactly as today (Contractor Agreement section 6.2 / fee-collection timing
-- is Ben's open question on #2559; this file does not touch it); the policy name, command, role, bucket
-- test and path convention; every other policy on storage.objects; public.claims and its policies.
-- The world fence (c.is_test = ct.is_test) lived only on the removed bidding branch, so it leaves with
-- it: a bidder in either world now reads zero objects (rows F1 to F3 of the proof).
--
-- PART 2. Bid-release gate (Ben's return 6022309354: the CTO's two conditions are part of this change).
--
-- When a claim goes from not-open to open for bids, and an estimate file is on it, a bidder will have
-- only the summary to price from. So the claim may open only if (a) the estimate was read into a
-- summary (loss_sheet_parsed_at set and either line-item sections or a total RCV present), and (b) the
-- stored summary does not repeat the claim's own homeowner name, street address or claim number
-- (case-insensitive substring; a value shorter than 4 characters, or 5 for a street, is not checked).
-- The parser is only INSTRUCTED to omit those; this is the deterministic check.
-- It fires only on the false-to-true change of ready_for_bids (and on insert with it true), so claims
-- already open are untouched, and a claim with no estimate file is not affected. A refusal surfaces to
-- the homeowner as the existing "Failed to submit your project" message; the wording shown to her is
-- Ben's question on #2559, not changed here.
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

CREATE OR REPLACE FUNCTION public.claims_guard_bid_release()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_hay    text;
  v_name   text := lower(btrim(coalesce(NEW.homeowner_name, '')));
  v_street text := lower(btrim(split_part(coalesce(NEW.property_address, ''), ',', 1)));
  v_claimn text := lower(btrim(coalesce(NEW.claim_number, '')));
BEGIN
  IF NEW.ready_for_bids IS NOT TRUE THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.ready_for_bids IS TRUE THEN RETURN NEW; END IF;
  IF NEW.estimate_filename IS NULL THEN RETURN NEW; END IF;

  IF NEW.loss_sheet_parsed_at IS NULL
     OR jsonb_typeof(NEW.parsed_line_items) IS DISTINCT FROM 'object'
     OR NOT (
          (jsonb_typeof(NEW.parsed_line_items -> 'sections') = 'array'
             AND jsonb_array_length(NEW.parsed_line_items -> 'sections') > 0)
          OR (NEW.parsed_line_items -> 'summary' ->> 'rcv') IS NOT NULL
        )
  THEN
    RAISE EXCEPTION 'gh2559: claim cannot open for bids: the uploaded estimate has not been read into a summary'
      USING ERRCODE = 'check_violation';
  END IF;

  v_hay := lower(coalesce(NEW.contractor_scope_summary, '') || E'\n' || NEW.parsed_line_items::text);
  IF (length(v_name)   >= 4 AND position(v_name   IN v_hay) > 0)
  OR (length(v_street) >= 5 AND position(v_street IN v_hay) > 0)
  OR (length(v_claimn) >= 4 AND position(v_claimn IN v_hay) > 0)
  THEN
    RAISE EXCEPTION 'gh2559: claim cannot open for bids: the estimate summary repeats the homeowner name, street address or claim number'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.claims_guard_bid_release() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS claims_guard_bid_release ON public.claims;
CREATE TRIGGER claims_guard_bid_release
  BEFORE INSERT OR UPDATE OF ready_for_bids ON public.claims
  FOR EACH ROW
  WHEN (NEW.ready_for_bids IS TRUE)
  EXECUTE FUNCTION public.claims_guard_bid_release();

COMMIT;
