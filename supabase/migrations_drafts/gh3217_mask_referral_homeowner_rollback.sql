-- STATUS (gh-1438, as of 2026-10-30T12:30:00Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh3217_mask_referral_homeowner (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: drafted 2026-10-30 under #3217. Restores the production state read 2026-10-30: relacl {postgres=arwdDxtm/postgres,anon=rwdDxtm/postgres,authenticated=rwdDxtm/postgres,service_role=arwdDxtm/postgres} (table-level SELECT for anon and authenticated, no column ACLs). The RLS policy is not touched by the forward file, so nothing to restore there. No database was written to produce this file.
-- REPO COPY: none. When applied, move to supabase/migrations_rollbacks/ beside the filed forward migration.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback of gh3217_mask_referral_homeowner. WARNING: running this restores partner read access to homeowner email and phone
-- (the privacy.html 4.7 breach). Only run it if the dashboards cannot be switched back to get_my_referrals() in time.
BEGIN;
REVOKE SELECT (id, created_at, referral_agent_id, status, job_value, commission_amount, recruit_commission_amount)
  ON public.referrals FROM authenticated;
GRANT SELECT ON public.referrals TO anon, authenticated;
DROP FUNCTION IF EXISTS public.get_my_referrals();
COMMIT;
