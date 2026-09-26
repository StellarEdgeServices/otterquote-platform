-- gh-1529 P-2 [SECURITY, tier:3b, tier:3b-approved]: anon-EXECUTE drift on
-- three SECURITY DEFINER trigger functions created AFTER PR #1634 (this
-- issue's original 23-function revoke, applied to production
-- 2026-09-09T04:55:09Z) and PR #1864 (the table-grant half). None of the
-- three below appear in the issue's original 29-name enumeration -- they
-- did not exist yet when the advisor was read on 2026-09-02 -- so they were
-- never covered by either prior remediation and inherited this project's
-- default privilege (`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT
-- EXECUTE ON FUNCTIONS TO anon, authenticated, service_role`, same trap
-- named in memory note `supabase-function-grant-defaults`) with no
-- follow-up REVOKE, same failure mode this issue exists to close.
--
-- Live state re-enumerated this run (2026-09-26, project yeszghaspzwwstvsrioa,
-- read-only `execute_sql`, SELECT only):
--
--   SELECT p.proname,
--          has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_exec,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
--          has_function_privilege('public', p.oid, 'EXECUTE')        AS public_exec
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.prosecdef = true
--     AND has_function_privilege('anon', p.oid, 'EXECUTE') = true;
--
-- returned 12 rows (down from the issue's original 29 -- 23 already
-- revoked by PR #1634). Of the 12: 5 are the issue's own explicit
-- allow-list (get_contractor_licenses_public, get_contractors_public,
-- get_referral_agents_public, register_partner, track_referral_click)
-- plus contractor_can_bid (6) (kept -- see PR #1634's header, RLS `with_check`
-- dependency on the {public}-role "Contractors can insert quotes" policy,
-- unrelated to this migration and NOT touched here). The remaining 6 are
-- new since the issue was filed: get_lead_prefill, set_lead_role,
-- update_lead_contact (all pre-auth lead-router RPCs -- KEPT, see caller
-- enumeration below) and the 3 revoked here.
--
-- Caller enumeration (R-147, literal grep against a fresh
-- --filter=blob:none clone of origin/main, `*.html`, `js/`, `react-app/src`
-- + `app/`, `supabase/functions/`):
--
--   $ grep -rn ".rpc('notify_admin_new_claim'" --include=*.html --include=*.js --include=*.jsx --include=*.ts --include=*.tsx .
--   $ grep -rn ".rpc('notify_admin_new_partner'" --include=*.html --include=*.js --include=*.jsx --include=*.ts --include=*.tsx .
--   $ grep -rn ".rpc('notify_admin_new_router_lead'" --include=*.html --include=*.js --include=*.jsx --include=*.ts --include=*.tsx .
--   (zero matches for all three -- no client anywhere calls any of them via .rpc())
--
--   $ SELECT p.proname, p.prorettype::regtype::text AS ret,
--            EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgfoid = p.oid AND NOT t.tgisinternal) AS is_trigger,
--            (SELECT string_agg(DISTINCT c.relname, ', ') FROM pg_trigger t
--               JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgfoid = p.oid AND NOT t.tgisinternal) AS trigger_tables
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname='public' AND p.proname IN
--     ('notify_admin_new_claim','notify_admin_new_partner','notify_admin_new_router_lead');
--   -- all three: ret=trigger, is_trigger=true --
--   --   notify_admin_new_claim        -> trg_notify_admin_new_claim AFTER INSERT ON claims
--   --   notify_admin_new_partner      -> trg_notify_admin_new_partner AFTER INSERT ON referral_agents
--   --   notify_admin_new_router_lead  -> trg_notify_admin_new_router_lead AFTER UPDATE ON leads
--
-- Same shape as the 15 trigger functions PR #1634 already revoked
-- (notify_admin_new_contractor, handle_new_user, etc.): fired only by
-- Postgres trigger machinery (which runs as the trigger owner, not the
-- invoking role), never invoked via `.rpc()` by any client.
--
-- CORRECTION (REVIEW: FAIL 5850171730, CTO RUN 42, fresh-context Opus
-- refuter): the exposure is NOT "an anon caller can invoke the trigger
-- BODY directly via RPC, outside the INSERT/UPDATE context it assumes" --
-- Postgres refuses to invoke a `RETURNS trigger` function outside trigger
-- context for ANY role, whatever the grants (SQLSTATE 0A000, "trigger
-- functions can only be called as triggers" -- verified live 2026-09-26
-- in a transaction forced to abort before this correction, and already on
-- record from the 2026-09-04 refuter on #1634, comment `5544978633`).
-- Trigger firing itself does not check EXECUTE either (verified live
-- 2026-09-26: an anon INSERT into `claims` still fires
-- `trg_notify_admin_new_claim` with EXECUTE revoked from PUBLIC/anon), so
-- the claims/referral_agents/leads write paths are unaffected by this
-- revoke either way. The actual reason for this migration: these 3 anon
-- EXECUTE grants are advisor-flagged `anon_security_definer_function_executable`
-- drift (no callable hole, but out of the least-privilege posture #1529
-- exists to establish) and closing them is required for #1529's own
-- `closes-on` (0 anon rows for non-public SECURITY DEFINER functions).
-- Revoking them is defense-in-depth cleanup, not a fix for a live
-- callable exposure.
--
-- KEPT, not touched by this migration (confirmed real anon/pre-auth
-- callers, R-147 grep evidence):
--   get_lead_prefill(uuid)      -- contractor-join.html:502, hi-1.html:1556,
--     ins-1.html:1616, partner-adjusters.html:1455,
--     partner-inspectors.html:1442, partner-insurance.html:1724,
--     partner-other.html:1433, partner-re.html:1698,
--     react-app/app/get-started/page.tsx:783 -- pre-auth lead router prefill,
--     no session exists yet on any of these pages at the call site.
--   set_lead_role(uuid, text, text) -- js/router-discovery.js:705,1022,
--     js/router-variant-d.js:357,407,711, js/router-variant-e.js:588,
--     js/router-variant-f.js:510, start.html:2228,2245,2256 -- called
--     before signup/login completes, assigning the lead's role during the
--     pre-auth router flow.
--   update_lead_contact(uuid, text, text, text) -- js/router-variant-d.js:440,506,
--     js/router-variant-e.js:656,837,969,1053, start.html:2100 -- same
--     pre-auth router flow, capturing contact info before a session exists.
--
-- OUT OF SCOPE (explicitly, per this dispatch): `authenticated`'s explicit
-- grant on the three revoked functions is left untouched (no legitimate
-- caller of any kind was found for authenticated either, but this
-- migration's mandate is anon + the PUBLIC default-privilege drift, same
-- boundary PR #1634 drew) -- flagged as a fast-follow below. The 41-table
-- RLS-write-grant half tracked separately on this issue (comment
-- 5768810799, CEO RUN 57) is NOT touched here -- different object class,
-- different enumeration, out of this migration's scope.
--
-- FAST-FOLLOW (not done here, flagged for the owning executive): all three
-- functions also carry an unused `authenticated` EXECUTE grant with zero
-- callers found. A separate pass revoking `authenticated` FROM these three
-- (and re-auditing whether `authenticated` should be revoked to match) is
-- a smaller, lower-risk follow-up once this PUBLIC/anon revoke is applied
-- and re-verified.
--
-- MIGRATION NOT APPLIED. SECURITY / tier:3b -- not applied on Code-lane
-- authority (HARD LIMIT: never apply a migration or write to any
-- database). Rollback: same-named _rollback.sql in
-- supabase/migrations_rollbacks/, restoring the exact live proacl entries
-- captured before this revoke (PUBLIC + anon + authenticated + service_role,
-- confirmed live via pg_proc.proacl for all three, 2026-09-26).

BEGIN;

REVOKE EXECUTE ON FUNCTION public.notify_admin_new_claim() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_admin_new_claim() FROM anon;

REVOKE EXECUTE ON FUNCTION public.notify_admin_new_partner() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_admin_new_partner() FROM anon;

REVOKE EXECUTE ON FUNCTION public.notify_admin_new_router_lead() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_admin_new_router_lead() FROM anon;

-- NOT touched in this migration (see header for full reasoning):
--   contractor_can_bid(uuid)                          -- (kept, PR #1634 RLS with_check dependency, unrelated)
--   get_lead_prefill(uuid)                            -- real pre-auth anon caller
--   set_lead_role(uuid, text, text)                   -- real pre-auth anon caller
--   update_lead_contact(uuid, text, text, text)        -- real pre-auth anon caller
--   get_contractor_licenses_public / get_contractors_public /
--   get_referral_agents_public / register_partner / track_referral_click -- issue's own explicit allow-list

COMMIT;
