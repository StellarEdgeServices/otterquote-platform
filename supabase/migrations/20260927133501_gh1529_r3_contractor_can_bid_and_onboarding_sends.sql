-- gh-1529 round 3 [SECURITY, tier:3b, tier:3b-approved]: close the two
-- remaining FAILs from CLOSE-REVIEW: FAIL 5850987845 (Marty, CTO RUN 42,
-- cto-2026-09-26T20:52:44Z), as directed in work-order comment 5851011353:
--
--   1. contractor_can_bid -- narrow the "Contractors can insert quotes"
--      policy on public.quotes to `authenticated`, and revoke anon/PUBLIC
--      EXECUTE on contractor_can_bid(uuid). DECIDED (Marty, comment
--      5851011353): revoke outright, no allow-list exception -- "no anon
--      caller exists in the front end (0 `.rpc('contractor_can_bid'` hits
--      in 421 files)."
--   2. partner_onboarding_sends -- revoke anon INSERT/UPDATE/DELETE. RLS is
--      already ON with no anon policy (writes are denied today at the RLS
--      layer), but the issue's closes-on requires 0 tables granting anon
--      more than SELECT at the GRANT layer too, and this table currently
--      does (regression flagged 5850987845 section 2: 0 -> 1 table).
--
-- Live state re-verified this run (2026-09-27T13:35:01Z, project
-- yeszghaspzwwstvsrioa, read-only `execute_sql`, SELECT only):
--
--   SELECT policyname, permissive, roles, cmd, with_check FROM pg_policies
--   WHERE schemaname='public' AND tablename='quotes';
--   -> "Contractors can insert quotes" | PERMISSIVE | {public} | INSERT |
--      with_check = "(contractor_id IN (SELECT contractors.id FROM
--      contractors WHERE contractors.user_id = auth.uid())) AND
--      contractor_can_bid(contractor_id)"
--
--   SELECT p.oid::regprocedure, p.proacl,
--          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
--   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--   WHERE n.nspname='public' AND p.proname='contractor_can_bid';
--   -> contractor_can_bid(uuid) | {=X/postgres,postgres=X/postgres,
--      anon=X/postgres,authenticated=X/postgres,service_role=X/postgres} |
--      anon_exec=true | auth_exec=true
--      (PUBLIC holds it too -- the bare "=X/postgres" entry -- this
--      project's `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE
--      ON FUNCTIONS TO anon, authenticated, service_role` default-privilege
--      trap named in memory note `supabase-function-grant-defaults`, same
--      shape PR #2228 found on its 3 drifted trigger functions.)
--
--   SELECT has_table_privilege('anon','public.quotes','INSERT');
--   -> true (table-level GRANT; left untouched here -- narrowing the RLS
--      policy to {authenticated} is what Marty decided, and with no
--      permissive INSERT policy left for anon, RLS denies every anon
--      INSERT on quotes regardless of the table-level grant. See "OUT OF
--      SCOPE" note below.)
--
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--   WHERE table_schema='public' AND table_name='partner_onboarding_sends'
--   AND grantee='anon';
--   -> anon holds DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE,
--      UPDATE. This migration revokes INSERT/UPDATE/DELETE only, per the
--      work order -- REFERENCES/TRIGGER/TRUNCATE/SELECT are untouched
--      (SELECT in particular: the table's public-facing read path, if any,
--      is a separate concern from the closes-on's "more than SELECT" test).
--
-- Caller enumeration (re-confirmed independently of Marty's 5851011353
-- figure, fresh grep against this worktree's `origin/main` checkout,
-- 2026-09-27):
--
--   $ grep -rn "contractor_can_bid" --include=*.html --include=*.js \
--       --include=*.jsx --include=*.ts --include=*.tsx .
--   ./contractor-bid-form.html:3568:  // Mirrors the RLS policy
--       (contractor_can_bid) so we fail fast in the UI
--
--   Zero `.rpc('contractor_can_bid'` matches anywhere -- the only hit is a
--   code COMMENT explaining that the front end mirrors the RLS predicate in
--   JS for a fast client-side check; nothing calls the RPC directly. Same
--   finding as Marty's "0 `.rpc('contractor_can_bid'` hits in 421 files."
--   Also confirmed live: anon can never satisfy the policy's other
--   conjunct anyway (`contractor_id IN (SELECT ... WHERE user_id =
--   auth.uid())` is never true for an unauthenticated caller), so this
--   revoke changes only the shape of anon's rejection (RLS/permission
--   denial instead of a callable-but-useless predicate), not any live
--   contractor flow.
--
-- OUT OF SCOPE (explicitly, per work-order 5851011353 and Marty's own
-- CLOSE-REVIEW "What is missing for PASS" #1): the table-level `anon`
-- INSERT/SELECT/REFERENCES/TRIGGER/TRUNCATE grants on quotes are NOT
-- revoked here -- the directive is "narrow the policy to authenticated,"
-- not "revoke the table grant," and RLS with no permissive anon policy
-- already blocks every anon INSERT. A separate pass tightening the
-- table-level grant itself (to match #1634/#1864's table-grant precedent)
-- is a smaller, lower-risk follow-up, flagged for the owning executive.
--
-- MIGRATION NOT APPLIED. SECURITY / tier:3b -- not applied on Code-lane
-- authority (HARD LIMIT: never apply a migration or write to any
-- database). Rollback: same-named _rollback.sql in
-- supabase/migrations_rollbacks/, restoring the policy to {public} and the
-- exact live proacl/grant entries captured above.

BEGIN;

-- 1a. Narrow the quotes INSERT policy from {public} to {authenticated}.
ALTER POLICY "Contractors can insert quotes" ON public.quotes TO authenticated;

-- 1b. Revoke anon + PUBLIC EXECUTE on contractor_can_bid(uuid). No allow-list
--     exception -- Marty decided (5851011353): revoke, 0 anon callers.
REVOKE EXECUTE ON FUNCTION public.contractor_can_bid(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.contractor_can_bid(uuid) FROM anon;

-- 2. partner_onboarding_sends: revoke anon write DML. RLS already blocks
--    these (no anon policy), but the closes-on requires 0 at the grant
--    layer too.
REVOKE INSERT, UPDATE, DELETE ON public.partner_onboarding_sends FROM anon;

-- NOT touched in this migration (see header for full reasoning):
--   quotes table-level GRANT to anon (SELECT/INSERT/REFERENCES/TRIGGER/
--     TRUNCATE)                                    -- out of scope, flagged
--   contractor_can_bid authenticated EXECUTE grant -- legitimate caller
--     (the same policy, now {authenticated}-only, still calls it)
--   partner_onboarding_sends anon SELECT/REFERENCES/TRIGGER/TRUNCATE
--                                                   -- out of this work order

COMMIT;
