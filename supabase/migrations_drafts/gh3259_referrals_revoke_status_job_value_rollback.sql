-- STATUS (gh-1438, as of 2026-10-30T21:00:00Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh3259_referrals_revoke_status_job_value (forward and pre-flight beside it)
-- EVIDENCE: drafted 2026-10-30 under #3259. Restores the production state read 2026-10-30 (project yeszghaspzwwstvsrioa): attacl of referrals.status and referrals.job_value = {authenticated=r/postgres}. No database was written to produce this file.
-- REPO COPY: none. When the forward is applied, move this file to supabase/migrations_rollbacks/ under the forward's ledger version.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback: gh3259_referrals_revoke_status_job_value. Re-grants SELECT (status, job_value) to authenticated, grantor postgres (run it as
-- postgres, the table owner, so the ACL entry reads authenticated=r/postgres exactly as before). anon held neither column before the
-- forward and gets nothing here. Safe to run twice. The proof checks the resulting catalog is identical to the pre-forward snapshot.
-- Reopening these columns reopens the privacy 4.7 gap #3259 closes; run it only to undo a broken apply.
BEGIN;

SET LOCAL lock_timeout = '5s';

GRANT SELECT (status, job_value) ON public.referrals TO authenticated;

DO $post$
BEGIN
  IF NOT (has_column_privilege('authenticated', 'public.referrals', 'job_value', 'SELECT')
      AND has_column_privilege('authenticated', 'public.referrals', 'status', 'SELECT')) THEN
    RAISE EXCEPTION 'gh3259 rollback: grants not restored' USING ERRCODE = 'P0A96';
  END IF;
END
$post$;

COMMIT;
