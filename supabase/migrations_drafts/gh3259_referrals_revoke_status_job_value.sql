-- STATUS (gh-1438, as of 2026-10-30T21:00:00Z): NOT APPLIED
-- FILE ROLE: forward file of set gh3259_referrals_revoke_status_job_value (rollback and pre-flight beside it)
-- EVIDENCE: drafted 2026-10-30 under #3259. Production read-only 2026-10-30 (project yeszghaspzwwstvsrioa): attacl of referrals.status and referrals.job_value = {authenticated=r/postgres}; has_column_privilege('authenticated','public.referrals','job_value','SELECT') = true; relacl has no table-level SELECT for anon/authenticated ({postgres=arwdDxtm/postgres,anon=wdDxtm/postgres,authenticated=wdDxtm/postgres,service_role=arwdDxtm/postgres}); get_my_referrals() and admin_list_referrals() are SECURITY DEFINER, owned by postgres. No database was written to produce this file.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3259_referrals_revoke_status_job_value
-- GitHub: #3259 (follow-up to #3257 / PR #3258; Dustin's ruling on #3257: "Match the policy (Recommended)"). Project P18.
-- Tier: 3B (grant change: REMOVES a read capability from `authenticated`). R-097 24-hour notice before apply.
-- Rollback: supabase/migrations_drafts/gh3259_referrals_revoke_status_job_value_rollback.sql (restores the two column grants exactly)
-- Pre-flight: supabase/migrations_drafts/gh3259_referrals_revoke_status_job_value_pre-flight.md (caller inventory, apply order)
-- Proof: bash supabase/tests/gh3259_referrals_column_revoke_proof_run.sh (throwaway PG16: before / after / rerun / rollback, mutants)
--
-- WHAT. privacy.html 4.7 tells a referred homeowner that updates to their referrer "never include your claim amount" and that they can
--   "decline these updates". get_my_referrals() (#3257 / PR #3258) enforces that in the RPC, but `authenticated` still holds column SELECT
--   on referrals.job_value and referrals.status, so the "Agents can read own referrals" policy lets a partner read both straight through
--   PostgREST (GET /rest/v1/referrals?select=job_value,status, or ?status=eq.x as a filter). This file withdraws exactly those two
--   column grants. A partner then reads status / job value only through get_my_referrals(), which is SECURITY DEFINER (runs as its owner,
--   postgres) and is therefore not affected by the caller's column privileges.
--
-- WHAT STAYS. authenticated keeps SELECT on id, created_at, referral_agent_id, commission_amount, recruit_commission_amount (the recruit
--   earnings read on both partner dashboards). INSERT/UPDATE/DELETE privileges, the RLS policies, service_role, the edge functions (all
--   use the service-role key), admin_list_referrals() and get_my_referrals() are untouched.
--
-- PRECONDITION / GATE. On main at the time of drafting, partner-dashboard.html loadStats() still runs
--   .from('referrals').select('status, job_value, commission_amount'). PR #3258 replaces that read with the get_my_referrals() rows.
--   Applying this file before #3258's partner-dashboard.html is published leaves that page's four stat cards unpopulated (the read
--   returns 42501; the page catches it). The file therefore refuses (P0A92) unless the apply transaction first ran
--     SET LOCAL gh3259.frontend_published = 'yes';
--   which is the operator's recorded statement that #3258's frontend is live and nothing a partner or customer loads reads
--   referrals.status or referrals.job_value directly (pre-flight section 2). It is deliberately NOT inside this file.
--
-- Rerun-safe: a second run (with the gate statement) revokes nothing new and passes its own assertions.
BEGIN;

SET LOCAL lock_timeout = '5s';

DO $gate$
BEGIN
  IF coalesce(current_setting('gh3259.frontend_published', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'gh3259: refused. Run SET LOCAL gh3259.frontend_published = ''yes''; in the same transaction ONLY after PR #3258''s partner-dashboard.html (no direct referrals.status / job_value read) is published (pre-flight section 2).' USING ERRCODE = 'P0A92';
  END IF;
END
$gate$;

-- The partner read path must exist and must not depend on the caller's column privileges.
DO $need$
BEGIN
  IF to_regprocedure('public.get_my_referrals()') IS NULL THEN
    RAISE EXCEPTION 'gh3259: public.get_my_referrals() does not exist; partners would have no read path' USING ERRCODE = 'P0A93';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.get_my_referrals()'::regprocedure) THEN
    RAISE EXCEPTION 'gh3259: public.get_my_referrals() is not SECURITY DEFINER; revoking the column grants would break it' USING ERRCODE = 'P0A93';
  END IF;
  -- A table-level SELECT overrides any column REVOKE; if one is present this file would be a silent no-op.
  IF has_table_privilege('authenticated', 'public.referrals', 'SELECT') OR has_table_privilege('anon', 'public.referrals', 'SELECT') THEN
    RAISE EXCEPTION 'gh3259: anon or authenticated holds table-level SELECT on public.referrals; a column REVOKE would not take effect' USING ERRCODE = 'P0A94';
  END IF;
END
$need$;

REVOKE SELECT (status, job_value) ON public.referrals FROM anon, authenticated;

DO $post$
BEGIN
  IF has_column_privilege('authenticated', 'public.referrals', 'job_value', 'SELECT')
     OR has_column_privilege('authenticated', 'public.referrals', 'status', 'SELECT')
     OR has_column_privilege('anon', 'public.referrals', 'job_value', 'SELECT')
     OR has_column_privilege('anon', 'public.referrals', 'status', 'SELECT') THEN
    RAISE EXCEPTION 'gh3259: status/job_value still readable by a client role after the revoke' USING ERRCODE = 'P0A95';
  END IF;
  IF NOT (has_column_privilege('authenticated', 'public.referrals', 'id', 'SELECT')
      AND has_column_privilege('authenticated', 'public.referrals', 'created_at', 'SELECT')
      AND has_column_privilege('authenticated', 'public.referrals', 'referral_agent_id', 'SELECT')
      AND has_column_privilege('authenticated', 'public.referrals', 'commission_amount', 'SELECT')
      AND has_column_privilege('authenticated', 'public.referrals', 'recruit_commission_amount', 'SELECT')) THEN
    RAISE EXCEPTION 'gh3259: a column the dashboards still read directly lost its SELECT grant' USING ERRCODE = 'P0A95';
  END IF;
END
$post$;

COMMIT;
