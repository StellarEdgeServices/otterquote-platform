-- gh-1529 round 3 proof.
--
-- Run against the CI TEST project (zsdvaqilfdclwosmiheh) ONLY. Never run
-- against production. Each of the two sections below is its own
-- self-contained BEGIN ... ROLLBACK batch -- run SECTION A once (before
-- the migration -- fail-first negative control), then SECTION B once
-- (applies the migration's DDL inline in the SAME rolled-back transaction,
-- then asserts it closed). Neither section ever COMMITs.
--
-- WHY A SHIM: the CI test project (zsdvaqilfdclwosmiheh) has `quotes`,
-- `contractors`, `claims`, and `contractor_can_bid(uuid)` in the same live
-- state as production (verified 2026-09-27: identical policy text on
-- "Contractors can insert quotes", identical proacl on
-- contractor_can_bid), but it does NOT have `partner_onboarding_sends` at
-- all. SECTION A/B both shim it in-batch: `CREATE TABLE IF NOT EXISTS`
-- with the same columns/RLS-enabled-no-policy/anon-grant shape read live
-- from production's `information_schema.columns` /
-- `information_schema.role_table_grants` / `pg_class.relrowsecurity` this
-- run (2026-09-27) -- see the migration file's header for the exact
-- read-only queries and results. The shim is entirely inside the rolled
-- back transaction and never persists.
--
-- ============================================================================
-- SECTION A -- BEFORE (fail-first negative control). Run as:
--   BEGIN;
--   \i supabase/tests/gh1529_round3_proof.sql   -- (SECTION A only)
--   ROLLBACK;
-- Proves: anon currently holds EXECUTE on contractor_can_bid and can call
-- it directly (a real, callable exposure); the "Contractors can insert
-- quotes" policy currently applies to anon (role {public}); the shimmed
-- partner_onboarding_sends currently grants anon INSERT/UPDATE/DELETE at
-- the privilege layer (even though RLS-enabled-no-policy denies the actual
-- DML today, matching CLOSE-REVIEW 5850987845's own finding -- "no live
-- exposure," but the closes-on measures the GRANT, not just live
-- reachability).
-- ============================================================================

BEGIN;

-- Fixtures (is_test rows; contractors.user_id left NULL -- nullable column
-- -- anon can never satisfy the policy's auth.uid() conjunct regardless of
-- whose user_id it is, so no real signed-in fixture is needed for this
-- proof; claims.user_id is NOT NULL / FK'd to auth.users, so it reuses
-- whatever row already exists in this CI project's auth.users).
DO $gh1529_r3_fixtures$
DECLARE
  v_uid uuid;
  v_contractor_id uuid := '11111111-1111-1111-1111-111111111111';
  v_claim_id uuid := '22222222-2222-2222-2222-222222222222';
BEGIN
  SELECT id INTO v_uid FROM auth.users LIMIT 1;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'gh1529_r3 SETUP FAILED: no row in auth.users on this CI project to satisfy claims.user_id FK';
  END IF;

  INSERT INTO public.contractors (id, company_name, contact_name, email, is_test)
  VALUES (v_contractor_id, 'gh1529-r3 test co', 'gh1529-r3 tester', 'gh1529-r3@example.invalid', true)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.claims (id, user_id, is_test)
  VALUES (v_claim_id, v_uid, true)
  ON CONFLICT (id) DO NOTHING;

  RAISE NOTICE 'gh1529_r3 SETUP: contractor % , claim % , auth.users %', v_contractor_id, v_claim_id, v_uid;
END;
$gh1529_r3_fixtures$;

-- Shim partner_onboarding_sends (absent on this CI project) matching
-- production's live shape: RLS enabled, NO policy, anon holds
-- DELETE/INSERT/REFERENCES/SELECT/TRIGGER/TRUNCATE/UPDATE (read live from
-- prod 2026-09-27, see migration header).
CREATE TABLE IF NOT EXISTS public.partner_onboarding_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL,
  stage text NOT NULL,
  status text NOT NULL,
  skipped_reason text,
  error text,
  mailgun_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0,
  terminal_failure boolean NOT NULL DEFAULT false,
  uncertain_alerted_at timestamptz
);
ALTER TABLE public.partner_onboarding_sends ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE ON public.partner_onboarding_sends TO anon;

-- ── BEFORE checks ────────────────────────────────────────────────────────
DO $gh1529_r3_before$
DECLARE
  v_policy_roles text;
  v_anon_exec_fn boolean;
  v_anon_ins_pos boolean;
  v_anon_upd_pos boolean;
  v_anon_del_pos boolean;
  v_bid_result boolean;
BEGIN
  SELECT roles::text INTO v_policy_roles FROM pg_policies
  WHERE schemaname='public' AND tablename='quotes' AND policyname='Contractors can insert quotes';

  SELECT has_function_privilege('anon', 'public.contractor_can_bid(uuid)', 'EXECUTE') INTO v_anon_exec_fn;
  SELECT has_table_privilege('anon','public.partner_onboarding_sends','INSERT') INTO v_anon_ins_pos;
  SELECT has_table_privilege('anon','public.partner_onboarding_sends','UPDATE') INTO v_anon_upd_pos;
  SELECT has_table_privilege('anon','public.partner_onboarding_sends','DELETE') INTO v_anon_del_pos;

  RAISE NOTICE 'gh1529_r3 BEFORE: quotes INSERT policy roles=% (expect {public}, anon included)', v_policy_roles;
  RAISE NOTICE 'gh1529_r3 BEFORE: anon EXECUTE contractor_can_bid = % (expect true)', v_anon_exec_fn;
  RAISE NOTICE 'gh1529_r3 BEFORE: anon INSERT/UPDATE/DELETE partner_onboarding_sends = %/%/%  (expect true/true/true)', v_anon_ins_pos, v_anon_upd_pos, v_anon_del_pos;

  IF v_policy_roles !~ 'public' OR NOT v_anon_exec_fn OR NOT v_anon_ins_pos OR NOT v_anon_upd_pos OR NOT v_anon_del_pos THEN
    RAISE EXCEPTION 'gh1529_r3 BEFORE PRE-CHECK FAILED: expected the pre-migration exposure to be present (anon in quotes-INSERT policy roles, anon EXECUTE on contractor_can_bid, anon DML grants on partner_onboarding_sends) -- got policy_roles=%, anon_exec_fn=%, ins=%, upd=%, del=%. This proof is fail-first and expects to run BEFORE the migration.', v_policy_roles, v_anon_exec_fn, v_anon_ins_pos, v_anon_upd_pos, v_anon_del_pos;
  END IF;
END;
$gh1529_r3_before$;

-- Live, direct proof that anon can currently CALL contractor_can_bid as an
-- RPC (not just that the grant exists) -- the actual exposure Marty's
-- CLOSE-REVIEW flagged ("anon-callable SECURITY DEFINER predicate over any
-- contractor's status/COI/attestation state via /rest/v1/rpc/contractor_can_bid").
DO $gh1529_r3_before_call$
DECLARE
  v_result boolean;
BEGIN
  SET LOCAL ROLE anon;
  SELECT public.contractor_can_bid('11111111-1111-1111-1111-111111111111'::uuid) INTO v_result;
  RESET ROLE;
  RAISE NOTICE 'gh1529_r3 BEFORE: anon-role direct call to contractor_can_bid(...) SUCCEEDED, returned % (this is the exposure -- anon can invoke the predicate directly, regardless of what it returns)', v_result;
EXCEPTION WHEN insufficient_privilege THEN
  RESET ROLE;
  RAISE EXCEPTION 'gh1529_r3 BEFORE PRE-CHECK FAILED: anon-role call to contractor_can_bid was UNEXPECTEDLY already denied pre-migration -- % / %', SQLSTATE, SQLERRM;
END;
$gh1529_r3_before_call$;

-- Section A never commits.
ROLLBACK;

-- ============================================================================
-- SECTION B -- apply the migration's DDL inline, then assert it closed the
-- gap. Run as its own separate batch:
--   BEGIN;
--   \i supabase/tests/gh1529_round3_proof.sql   -- (SECTION B only)
--   ROLLBACK;
-- ============================================================================

BEGIN;

DO $gh1529_r3_fixtures_b$
DECLARE
  v_uid uuid;
  v_contractor_id uuid := '11111111-1111-1111-1111-111111111111';
  v_claim_id uuid := '22222222-2222-2222-2222-222222222222';
BEGIN
  SELECT id INTO v_uid FROM auth.users LIMIT 1;
  INSERT INTO public.contractors (id, company_name, contact_name, email, is_test)
  VALUES (v_contractor_id, 'gh1529-r3 test co', 'gh1529-r3 tester', 'gh1529-r3@example.invalid', true)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.claims (id, user_id, is_test)
  VALUES (v_claim_id, v_uid, true)
  ON CONFLICT (id) DO NOTHING;
END;
$gh1529_r3_fixtures_b$;

CREATE TABLE IF NOT EXISTS public.partner_onboarding_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL,
  stage text NOT NULL,
  status text NOT NULL,
  skipped_reason text,
  error text,
  mailgun_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0,
  terminal_failure boolean NOT NULL DEFAULT false,
  uncertain_alerted_at timestamptz
);
ALTER TABLE public.partner_onboarding_sends ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE ON public.partner_onboarding_sends TO anon;

-- ── Apply the forward migration's DDL inline ────────────────────────────
ALTER POLICY "Contractors can insert quotes" ON public.quotes TO authenticated;
REVOKE EXECUTE ON FUNCTION public.contractor_can_bid(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.contractor_can_bid(uuid) FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.partner_onboarding_sends FROM anon;

-- ── AFTER checks ─────────────────────────────────────────────────────────
DO $gh1529_r3_after$
DECLARE
  v_policy_roles text;
  v_anon_exec_fn boolean;
  v_anon_ins_pos boolean;
  v_anon_upd_pos boolean;
  v_anon_del_pos boolean;
BEGIN
  SELECT roles::text INTO v_policy_roles FROM pg_policies
  WHERE schemaname='public' AND tablename='quotes' AND policyname='Contractors can insert quotes';
  SELECT has_function_privilege('anon', 'public.contractor_can_bid(uuid)', 'EXECUTE') INTO v_anon_exec_fn;
  SELECT has_table_privilege('anon','public.partner_onboarding_sends','INSERT') INTO v_anon_ins_pos;
  SELECT has_table_privilege('anon','public.partner_onboarding_sends','UPDATE') INTO v_anon_upd_pos;
  SELECT has_table_privilege('anon','public.partner_onboarding_sends','DELETE') INTO v_anon_del_pos;

  RAISE NOTICE 'gh1529_r3 AFTER: quotes INSERT policy roles=% (expect {authenticated}, anon removed)', v_policy_roles;
  RAISE NOTICE 'gh1529_r3 AFTER: anon EXECUTE contractor_can_bid = % (expect false)', v_anon_exec_fn;
  RAISE NOTICE 'gh1529_r3 AFTER: anon INSERT/UPDATE/DELETE partner_onboarding_sends = %/%/%  (expect false/false/false)', v_anon_ins_pos, v_anon_upd_pos, v_anon_del_pos;

  IF v_policy_roles ~ 'public' OR v_anon_exec_fn OR v_anon_ins_pos OR v_anon_upd_pos OR v_anon_del_pos THEN
    RAISE EXCEPTION 'gh1529_r3 AFTER POST-CHECK FAILED: expected the gap closed -- got policy_roles=%, anon_exec_fn=%, ins=%, upd=%, del=%', v_policy_roles, v_anon_exec_fn, v_anon_ins_pos, v_anon_upd_pos, v_anon_del_pos;
  END IF;
  RAISE NOTICE 'gh1529_r3 AFTER: POST-CHECK PASSED.';
END;
$gh1529_r3_after$;

-- Live, direct proof anon can no longer CALL contractor_can_bid.
DO $gh1529_r3_after_call$
DECLARE
  v_result boolean;
BEGIN
  SET LOCAL ROLE anon;
  SELECT public.contractor_can_bid('11111111-1111-1111-1111-111111111111'::uuid) INTO v_result;
  RESET ROLE;
  RAISE EXCEPTION 'gh1529_r3 AFTER POST-CHECK FAILED: anon-role call to contractor_can_bid UNEXPECTEDLY SUCCEEDED, returned %', v_result;
EXCEPTION WHEN insufficient_privilege THEN
  RESET ROLE;
  RAISE NOTICE 'gh1529_r3 AFTER: anon-role direct call to contractor_can_bid(...) correctly DENIED -- % / %', SQLSTATE, SQLERRM;
END;
$gh1529_r3_after_call$;

-- KEPT check -- guard against an over-broad copy/paste: the three real
-- pre-auth lead-router RPCs (Marty's item 2, caller evidence below) must
-- remain anon-executable; this migration must never touch them.
DO $gh1529_r3_kept$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(want, ', ') INTO v_missing
  FROM unnest(ARRAY['get_lead_prefill', 'set_lead_role', 'update_lead_contact']) AS want
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = want
      AND has_function_privilege('anon', p.oid, 'EXECUTE') = true
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'gh1529_r3 KEPT-CHECK FAILED: expected anon EXECUTE to remain on %, but it does not', v_missing;
  END IF;
  RAISE NOTICE 'gh1529_r3 KEPT-CHECK PASSED: get_lead_prefill / set_lead_role / update_lead_contact untouched.';
END;
$gh1529_r3_kept$;

-- Section B never commits either.
ROLLBACK;

-- ============================================================================
-- APPLIER READ-BACK -- plain SELECTs, safe to copy-paste and re-run on
-- PRODUCTION (yeszghaspzwwstvsrioa) after the real apply. Not part of the
-- mutation testing above; these are read-only and expected to return the
-- "after" values once the forward migration has actually been applied.
-- ============================================================================

-- Expect roles = {authenticated}:
SELECT policyname, roles FROM pg_policies
WHERE schemaname='public' AND tablename='quotes' AND policyname='Contractors can insert quotes';

-- Expect false:
SELECT has_function_privilege('anon', 'public.contractor_can_bid(uuid)', 'EXECUTE') AS anon_can_exec_contractor_can_bid;

-- Expect false for all three:
SELECT has_table_privilege('anon','public.partner_onboarding_sends','INSERT') AS anon_ins,
       has_table_privilege('anon','public.partner_onboarding_sends','UPDATE') AS anon_upd,
       has_table_privilege('anon','public.partner_onboarding_sends','DELETE') AS anon_del;

-- Expect true for all three (kept, untouched):
SELECT proname, has_function_privilege('anon', oid, 'EXECUTE') AS anon_exec
FROM pg_proc JOIN pg_namespace n ON n.oid = pronamespace
WHERE nspname='public' AND proname IN ('get_lead_prefill','set_lead_role','update_lead_contact');
