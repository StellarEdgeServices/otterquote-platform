-- STATUS (gh-1438, as of 2026-11-05): APPLIED to production as ledger version 20261030141726 (#3217 (ledger row read-only 2026-11-05)); this rollback is NOT run
-- FILE ROLE: rollback file of PART B (gh3217b_referrals_column_allowlist)
-- EVIDENCE: drafted 2026-10-30 under #3217. Production read-only 2026-10-30 (project yeszghaspzwwstvsrioa): policy "Agents can read own referrals" (SELECT, roles={public}) returns whole rows to the signed-in partner; relacl = {postgres=arwdDxtm/postgres,anon=rwdDxtm/postgres,authenticated=rwdDxtm/postgres,service_role=arwdDxtm/postgres} (table-level SELECT, no column ACLs); get_my_referrals() absent; admin_list_referrals() is SECURITY DEFINER. No database was written to produce this file.
-- REPO COPY: this file, beside the filed forward supabase/migrations/20261030141726_gh3217b_referrals_column_allowlist.sql.
-- Run only as a deliberate rollback.
--
-- Rollback of gh3217b_referrals_column_allowlist. Restores the production grants read 2026-10-30 exactly
-- (relacl authenticated=rwdDxtm, anon=rwdDxtm, no column ACLs) and KEEPS get_my_referrals(), so the deployed frontend keeps working.
-- WARNING: this re-opens partner read access to homeowner email and phone (the privacy.html 4.7 breach). Use only if B breaks a reader.
BEGIN;
REVOKE SELECT (id, created_at, referral_agent_id, status, job_value, commission_amount, recruit_commission_amount)
  ON public.referrals FROM authenticated;
GRANT SELECT ON public.referrals TO anon, authenticated;
COMMIT;
