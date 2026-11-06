BEGIN;
-- STATUS (gh-1438, as of 2026-11-05): APPLIED to production as ledger version 20261030141726 (#3217 (ledger row read-only 2026-11-05))
-- FILE ROLE: forward file, PART B of set gh3217_mask_referral_homeowner (the lockdown; pre-flight is gh3217_mask_referral_homeowner_pre-flight.md)
-- EVIDENCE: drafted 2026-10-30 under #3217. Production read-only 2026-10-30 (project yeszghaspzwwstvsrioa): policy "Agents can read own referrals" (SELECT, roles={public}) returns whole rows to the signed-in partner; relacl = {postgres=arwdDxtm/postgres,anon=rwdDxtm/postgres,authenticated=rwdDxtm/postgres,service_role=arwdDxtm/postgres} (table-level SELECT, no column ACLs); get_my_referrals() absent; admin_list_referrals() is SECURITY DEFINER. No database was written to produce this file.
-- REPO COPY: this file, filed under its ledger version; rollback and pre-flight in supabase/migrations_rollbacks/20261030141726_*. Header comments only differ from the draft.
-- Already applied; do not run again.
--
-- Migration: gh3217b_referrals_column_allowlist  (PART B, apply LAST)
-- GitHub: #3217. Project P18. Tier 3B (grant change). R-134 protective-only.
-- PRECONDITION: Part A applied, the frontend of PR #3225 deployed, and the four pages smoke-tested (/partner-dashboard.html,
--   /refer-a-friend.html, React /partner/dashboard, React /refer). Applying B before the frontend deploys makes the old
--   select('*') calls fail with permission denied.
-- Rollback: gh3217b_referrals_column_allowlist_rollback.sql (restores the exact live grants; keeps the function)
-- Proof: supabase/tests/gh3217_mask_referral_homeowner_proof.sql
--
-- WHY COLUMN PRIVILEGES AND NOT A POLICY CHANGE
--   RLS is row-level: no policy can hide homeowner_email while still returning the same row. Live, `authenticated` holds a TABLE-level
--   SELECT, and a table-level grant overrides any column REVOKE, so `REVOKE SELECT (homeowner_email) ...` alone is a no-op. This
--   revokes the table-level SELECT and re-grants SELECT on an explicit allow-list of non-contact columns (what the dashboards still
--   read directly: stats and recruit earnings). Contact columns and `metadata` are withheld; a column added later is private by
--   default. The RLS policy is untouched and still scopes rows. Dropping the policy would break the stat reads and leave the contact
--   columns exposed to any policy added later. service_role and SECURITY DEFINER functions (admin_list_referrals, edge functions)
--   are unaffected.

-- Withdraw direct read of the contact columns (and metadata) from client roles.
REVOKE SELECT ON public.referrals FROM anon, authenticated;
GRANT SELECT (id, created_at, referral_agent_id, status, job_value, commission_amount, recruit_commission_amount)
  ON public.referrals TO authenticated;

COMMIT;
