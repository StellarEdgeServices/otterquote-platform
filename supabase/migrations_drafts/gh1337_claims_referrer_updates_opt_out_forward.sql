-- gh-1337 forward.sql — Tier 3A (additive, autonomous per D-261). NOT APPLIED.
--
-- Adds the storage for the homeowner's referrer-updates opt-out choice captured
-- by the approved opt-out checkbox on the homeowner intake
-- (react-app/app/get-started/page.tsx), and read by the consent gate in
-- supabase/functions/send-partner-status-email/index.ts.
--
-- STATUS: DRAFT ONLY. This file has NOT been applied to production
-- (yeszghaspzwwstvsrioa) or to any branch. It ships in the gh-1337 PR as an
-- artifact for Dustin's R-120 read. Do not apply without his word.
--
-- Tri-state semantics — the gate depends on all three being distinguishable:
--   NULL   the homeowner was never shown the checkbox (every row predating the
--          intake change, and any path that does not write the column).
--          The gate treats NULL as consent-not-captured and does NOT send.
--   FALSE  the homeowner saw the checkbox and left it unchecked. This is the
--          only value that permits a third-party claim-progress email.
--   TRUE   the homeowner checked the box and opted out. Does NOT send.
--
-- Why claims and not referrals.metadata:
--   send-partner-status-email/index.ts merges referrals.metadata in JS and
--   writes the whole object back (its own header documents that a concurrent
--   write to an unrelated metadata key from another process "could be lost").
--   A consent record must not live in a column with a documented lossy merge.
--   claims is also the homeowner's own row and is already SELECTed by the
--   function, so the gate costs no extra round trip in the common path.
--   (The approved copy doc's §5.2 suggested referrals.metadata; its own author
--   flagged that as "an engineering decision, not a copy one". The gate reads
--   referrals.metadata.referrer_updates_opt_out as a fallback either way, so
--   this choice does not foreclose that path.)
--
-- Safety profile:
--   - ADD COLUMN, nullable, NO DEFAULT -> catalog-only, no table rewrite, no
--     lock beyond a brief ACCESS EXCLUSIVE on public.claims. Safe on a live
--     table at this row count.
--   - No backfill. Existing rows stay NULL, i.e. fail-closed. This is
--     deliberate: no historical homeowner ever saw the checkbox, so no
--     historical claim may be treated as having granted consent.
--   - No RLS change needed. public.claims grants are table-level and uniform
--     across all 107 existing columns for anon / authenticated / service_role /
--     postgres, so the new column inherits them (verified live 2026-08-28).
--   - No index. The column is only ever read by primary-key lookup on claims.id.
--
-- Rollback: gh1337_claims_referrer_updates_opt_out_rollback.sql

BEGIN;

ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS referrer_updates_opt_out BOOLEAN;

COMMENT ON COLUMN public.claims.referrer_updates_opt_out IS
'gh-1337: homeowner''s choice on the intake opt-out checkbox for progress updates sent to the person who referred them. TRUE = opted out (do not send). FALSE = shown the checkbox and did not opt out (the ONLY value that permits a send). NULL = never asked (do not send). Read by send-partner-status-email; copy approved by Dustin on gh-1336, R-120.';

COMMIT;
