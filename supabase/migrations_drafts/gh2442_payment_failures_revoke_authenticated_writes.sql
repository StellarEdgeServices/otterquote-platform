-- STATUS (gh-1438, as of 2026-10-14T15:27:36Z): NOT APPLIED
-- FILE ROLE: forward file of set gh2442_payment_failures_revoke_authenticated_writes (the STATUS is the set's)
-- EVIDENCE: `authenticated` holds INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER on public.payment_failures on production: CLOSE-REVIEW 6154141392 (#2442), Supabase MCP SELECT 2026-10-13 20:05:06Z, and CTO65 state 6164276552 (2026-10-14 08:32Z). Not re-measured by the authoring session (it ran no SQL on production).
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md (Tier 3B path: review, R-097 notice, recorded apply)
--
-- Migration: gh2442_payment_failures_revoke_authenticated_writes
-- GitHub: #2442. Named as a separate protective change by the CEO in PR #2579 comment 6045861846 and listed as owed in
--         #2442 comments 6071468408 and 6154141392 ("revoke `authenticated`'s broad writes on `payment_failures`").
-- Tier: 3B (money-path table, privilege change). NOT APPLIED by the authoring session or by CI. Protective only: it
--       removes capability, adds none.
-- Rollback: gh2442_payment_failures_revoke_authenticated_writes_rollback.sql
-- Pre-flight: gh2442_payment_failures_revoke_authenticated_writes_pre-flight.md
--
-- What it does. Revokes from `authenticated` on public.payment_failures: INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER.
--   TRUNCATE is the one that matters: row-level security does NOT govern TRUNCATE, so today any signed-in user can
--   empty the dunning table (the failed platform-fee payment records) with one statement.
--   INSERT and DELETE have no RLS policy for `authenticated` (policies on the table: admin_select, admin_update,
--   contractor_select_own), so they already match no rows; revoking them is a second lock, not a behaviour change.
-- What it leaves alone, on purpose: SELECT (the contractor dashboard banner reads its own failures through the
--   contractor_select_own policy: react-app/app/contractor/dashboard/use-dashboard-data.ts:246 and
--   contractor-dashboard.html:1727) and UPDATE (policy admin_update_payment_failures exists; the legacy page's
--   retryDunningPayment, contractor-dashboard.html:1820, still issues a table UPDATE that matches zero rows. Revoking
--   UPDATE is the follow-up once the page calls request_dunning_retry instead, which waits on Ben's wording).
-- Who writes this table today: Edge Functions on the service role (process-dunning, stripe-webhook, docusign-webhook,
--   process-bid-expirations) and the SECURITY DEFINER function request_dunning_retry (migration gh2442_dunning_retry_request,
--   applied 2026-10-09 as ledger 20261009000257). Service role and function owner are unaffected by this REVOKE.
--
-- Self-check: the DO block raises (and the transaction rolls back) if any of the five privileges is still held by
-- `authenticated` afterwards, or if SELECT or UPDATE was lost.
BEGIN;

REVOKE INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.payment_failures FROM authenticated;

DO $$
DECLARE
  p text;
BEGIN
  FOREACH p IN ARRAY ARRAY['INSERT','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
    IF has_table_privilege('authenticated', 'public.payment_failures', p) THEN
      RAISE EXCEPTION 'gh2442 revoke: authenticated still holds % on public.payment_failures', p;
    END IF;
  END LOOP;
  IF NOT has_table_privilege('authenticated', 'public.payment_failures', 'SELECT') THEN
    RAISE EXCEPTION 'gh2442 revoke: authenticated lost SELECT on public.payment_failures (the contractor banner reads it)';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.payment_failures', 'UPDATE') THEN
    RAISE EXCEPTION 'gh2442 revoke: authenticated lost UPDATE on public.payment_failures (out of scope for this set)';
  END IF;
END $$;

COMMIT;
