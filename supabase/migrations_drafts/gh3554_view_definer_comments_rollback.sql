-- STATUS (gh-1438, as of 2026-11-09T12:45:00Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh3554_view_definer_comments (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: drafted 2026-11-09 under #3554. Restores the comments as written in the repo by supabase/migrations/20261008231303_gh2559_bidder_claims_view.sql:353 (bidder_claim_summary) and supabase/migrations/20261020162602_gh2559_d390_redact_contact_until_fee.sql:412 (contractor_thread_messages); later migrations replace the views with CREATE OR REPLACE, which keeps comments. Production comment text was NOT read for this draft: before relying on it, exec:cto should paste obj_description from production and, if it differs from the text below, correct this file.
-- REPO COPY: none. When applied, move to supabase/migrations_rollbacks/ beside the filed forward migration.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback of gh3554_view_definer_comments: comment only, no view definition, grant or policy is touched.
BEGIN;
SET LOCAL lock_timeout = '5s';

COMMENT ON VIEW public.bidder_claim_summary IS
  'gh-2559 / D-368: what a contractor may read of a claim before selection (summary, no homeowner identity or contact). Owner-run; filters its own rows by auth.uid(). Raw file paths only for the selected contractor. Allow-list: supabase/migrations_drafts/gh2559_bidder_claims_view_pre-flight.md.';

COMMENT ON VIEW public.contractor_thread_messages IS
  'D-390 / gh-2619: a selected contractor''s read of a claim thread. Homeowner-sent bodies are redacted (phone, e-mail) until claims.platform_fee_charged IS TRUE. Owner-run; filters by auth.uid().';

COMMIT;
