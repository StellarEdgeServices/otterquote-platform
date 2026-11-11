-- STATUS (gh-1438, as of 2026-11-10): NOT APPLIED
-- EVIDENCE: CTO RUN 101 (claim cto-2026-11-10T17:30:11Z). The Supabase security advisor, observed 2026-11-10T17:35:48Z, lists 12 anon-executable SECURITY DEFINER functions in public.
--   This file touches 2 of them. No database was read or written to produce this file (repository-only work); the live grants are the advisor's word, not re-measured here.
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY: apply only through the Tier 3B path (review, R-097 24-hour notice, a recorded apply).
-- Rollback: supabase/migrations_rollbacks/cto101_revoke_anon_secdef_nonpublic_rollback.sql
-- Proof (throwaway Postgres, before/after, trigger path still works as the client roles): supabase/tests/cto101_anon_secdef_revoke_proof_run.mjs
--
-- WHY. Supabase's default privileges grant EXECUTE on every new public function to anon, authenticated and service_role (same trap as gh-1529 P-2 and the TRUNCATE analogue in #3256).
--   gh-3409's file then re-asserted it for fee_acceptance_quarantine_add: `REVOKE ALL ... FROM PUBLIC; GRANT EXECUTE ... TO anon, authenticated, service_role;`.
--   The function writes the money quarantine table (fee_acceptance_quarantine).
--
-- WHAT THIS REVOKES (PUBLIC and anon only; authenticated and service_role are not touched):
--   1. public.fee_acceptance_quarantine_add(public.fee_acceptances, text[], numeric, numeric)
--      Caller enumeration: the only caller in the repo is public.fee_acceptances_guard_client_insert() (a BEFORE INSERT trigger on fee_acceptances, NOT SECURITY DEFINER, so it runs as the
--      INSERTING role). It reaches the call only after rule A, which refuses any caller whose auth.uid() does not own the named contractor row, so anon (auth.uid() NULL) is refused with 42501
--      before the call and never needs EXECUTE. authenticated does need it (a contractor's diverted bid-form insert), so it is kept. No Edge Function, react-app or HTML page calls it by .rpc().
--   2. public.notify_admin_out_of_state_claim()  (RETURNS trigger)
--      Only caller: trigger trg_notify_admin_out_of_state_claim on public.claims. PostgreSQL does not check EXECUTE when a trigger fires (see gh-1529 P-2 header, REVIEW 5850171730), and a
--      RETURNS trigger function cannot be called directly by any role. Same shape as the three functions gh-1529 P-2 revoked. Pure advisor hygiene.
--
-- WHAT THIS DELIBERATELY DOES NOT TOUCH:
--   public.is_admin_email(): called by anon-evaluated RLS policies (TO public). A policy's function runs with the querying role's privileges, so revoking anon EXECUTE would make every anon query
--     on any table with such a policy fail with "permission denied for function". gh-3009 chose "keep EXECUTE broad" on purpose. It returns only whether the CALLER's own JWT email is an admin
--     (false for anon). Not exploitable. Leave it.
--   The nine intentionally public functions (get_contractors_public, get_referral_agents_public, register_partner, track_referral_click, resolve_partner_slug, get_lead_prefill, set_lead_role,
--     update_lead_contact, get_contractor_licenses_public): real pre-auth callers; out of scope.
--   Default privileges (ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM anon) would stop the drift recurring but is a wider change that must be checked against every public function; not done here.
--
-- Both statements are idempotent and metadata-only. Run alone: `psql -v ON_ERROR_STOP=1 -f`.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $prereq$
BEGIN
  IF to_regprocedure('public.fee_acceptance_quarantine_add(public.fee_acceptances,text[],numeric,numeric)') IS NULL THEN
    RAISE EXCEPTION 'cto101: fee_acceptance_quarantine_add does not exist (gh-3409 not applied); nothing to revoke';
  END IF;
  IF to_regprocedure('public.notify_admin_out_of_state_claim()') IS NULL THEN
    RAISE EXCEPTION 'cto101: notify_admin_out_of_state_claim does not exist; nothing to revoke';
  END IF;
END
$prereq$;

REVOKE EXECUTE ON FUNCTION public.fee_acceptance_quarantine_add(public.fee_acceptances, text[], numeric, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fee_acceptance_quarantine_add(public.fee_acceptances, text[], numeric, numeric) FROM anon;

REVOKE EXECUTE ON FUNCTION public.notify_admin_out_of_state_claim() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_admin_out_of_state_claim() FROM anon;

DO $final$
BEGIN
  IF has_function_privilege('anon', 'public.fee_acceptance_quarantine_add(public.fee_acceptances,text[],numeric,numeric)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.notify_admin_out_of_state_claim()', 'EXECUTE') THEN
    RAISE EXCEPTION 'cto101: anon still holds EXECUTE; nothing is applied';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.fee_acceptance_quarantine_add(public.fee_acceptances,text[],numeric,numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'cto101: authenticated lost EXECUTE on fee_acceptance_quarantine_add (the bid-form diversion path needs it); nothing is applied';
  END IF;
END
$final$;

COMMIT;
