-- STATUS (gh-1438, as of 2026-10-30T13:30:00Z): NOT APPLIED
-- FILE ROLE: rollback file of PART A (gh3217a_get_my_referrals)
-- EVIDENCE: drafted 2026-10-30 under #3217. Production read-only 2026-10-30 (project yeszghaspzwwstvsrioa): policy "Agents can read own referrals" (SELECT, roles={public}) returns whole rows to the signed-in partner; relacl = {postgres=arwdDxtm/postgres,anon=rwdDxtm/postgres,authenticated=rwdDxtm/postgres,service_role=arwdDxtm/postgres} (table-level SELECT, no column ACLs); get_my_referrals() absent; admin_list_referrals() is SECURITY DEFINER. No database was written to produce this file.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback of gh3217a_get_my_referrals. USE ONLY BEFORE THE FRONTEND OF PR #3225 DEPLOYS (or after the frontend is reverted):
-- the new dashboards call get_my_referrals(), so dropping it while they are live breaks the partner and refer-a-friend referral lists.
-- If Part B is applied, roll B back first. Part A changed nothing else, so this restores the live state exactly (function absent).
BEGIN;
DROP FUNCTION IF EXISTS public.get_my_referrals();
COMMIT;
