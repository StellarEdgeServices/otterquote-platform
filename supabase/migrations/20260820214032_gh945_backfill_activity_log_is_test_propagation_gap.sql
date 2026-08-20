-- gh-945 (SG-4): backfill activity_log.is_test for the 6 rows the gh-1028 propagation
-- fix (20260818224203) only prevented going forward, not backfilled historically.
-- Tier 3A, additive/idempotent, flag-not-delete -- governed by the same Dustin-approved
-- 2026-08-18 ruling gh-1028 cites ("flag + exclude, do NOT delete"). Same operation
-- (boolean flag backfill on rows already proven test via their owning quote/claim),
-- same standing approval; not a new decision.
--
-- Applied to production yeszghaspzwwstvsrioa via apply_migration 2026-08-20
-- (session rw-f22-20260820T204228-ec09). This repo file is added post-apply to keep
-- a trace, matching the gh-752/gh-886/gh-916/gh-1028 precedent -- merging this PR
-- does NOT (re-)apply the migration, it already ran.
--
-- Enumerated live before applying: every activity_log row where is_test is NOT true
-- AND the row's own metadata.quote_id or metadata.claim_id points at a quotes/claims
-- row that IS is_test=true. Exactly 6 rows, all three affected event_types accounted
-- for: bid_submitted (2), bid_confirmation_email_sent (2), loss_sheet_parsed (2).
-- Row ids: a35f6506-ced3-4e14-ba6e-199434626fa9, 52501761-2706-42eb-a410-105997976219,
-- 622107ab-7fc3-4961-8ab3-a584fb79bd97, ea5009ee-988d-4c50-903f-c090842d9c36,
-- 9fd675bc-2eef-43ab-8358-01539d113113, aae60b6d-a98b-4f0f-a572-05c4bd2ec115.
--
-- NOT covered: a 3rd historically-referenced claim (41ba3965-e0d2-4ea4-a672-c18d1b8b8eaf,
-- a 2026-06-24 bid_submitted row) no longer exists in `claims` (already deleted by an
-- earlier cleanup), so it cannot be joined and is left untouched by this predicate --
-- its activity_log row is orphaned, not a live miscount, and out of scope for a
-- flag-not-delete backfill that requires a live row to confirm against. Same for one
-- remaining `welcome_email_sent` row -- never referenced by this event-type family,
-- not evaluated by this migration's predicate, left as-is.
--
-- Post-apply live verification: re-ran the same predicate -- 0 rows remain matching.
-- activity_log totals unchanged (665 bid_submitted / 367 bid_confirmation_email_sent /
-- 3 loss_sheet_parsed / 1 bid_updated / 1 welcome_email_sent) -- this migration flags
-- rows, it does not delete or hide them from any count; is_test-aware reporting views
-- now correctly exclude the 6 rows this backfills.
--
-- GitHub: #945 (SG-4)

UPDATE public.activity_log al
SET is_test = true
WHERE al.is_test IS NOT TRUE
  AND (
    (al.metadata->>'quote_id' IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.quotes q WHERE q.id = (al.metadata->>'quote_id')::uuid AND q.is_test = true))
    OR
    (al.metadata->>'claim_id' IS NOT NULL AND al.metadata->>'quote_id' IS NULL AND EXISTS (
      SELECT 1 FROM public.claims c WHERE c.id = (al.metadata->>'claim_id')::uuid AND c.is_test = true))
  );
