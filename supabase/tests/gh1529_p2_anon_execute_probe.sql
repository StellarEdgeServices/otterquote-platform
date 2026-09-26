-- gh-1529 P-2 negative probe.
--
-- Run the WHOLE file as one statement batch wrapped in BEGIN ... ROLLBACK
-- against the target database. Never COMMIT.
--
-- Purpose: prove the exposure exists BEFORE
-- 20260926211800_gh1529_p2_revoke_anon_execute_drift_trigger_fns.sql
-- applies (fail-first negative control), then prove the migration closes
-- it. Run this file twice: once against the pre-migration database (the
-- first assertion should PASS -- has_function_privilege returns true,
-- i.e. the exposure is real, not assumed) and once after applying the
-- migration inline below in the SAME transaction (the second assertion
-- should also PASS -- the grant is gone). Both are asserted here so a
-- single run proves both halves without depending on database state
-- outside this transaction.

-- ── 1. BEFORE: assert anon currently CAN execute all three drift functions ──
DO $gh1529_p2_before$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(proname, ', ') INTO v_bad
  FROM (
    SELECT p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('notify_admin_new_claim', 'notify_admin_new_partner', 'notify_admin_new_router_lead')
      AND has_function_privilege('anon', p.oid, 'EXECUTE') = true
  ) x;

  IF v_bad IS DISTINCT FROM 'notify_admin_new_claim, notify_admin_new_partner, notify_admin_new_router_lead'
     AND v_bad IS NOT NULL THEN
    -- order-independent check: just require all three are present
    IF v_bad !~ 'notify_admin_new_claim' OR v_bad !~ 'notify_admin_new_partner' OR v_bad !~ 'notify_admin_new_router_lead' THEN
      RAISE EXCEPTION 'gh1529_p2 PRE-CHECK FAILED: expected all 3 functions anon-executable pre-migration, got: %', COALESCE(v_bad, '(none)');
    END IF;
  END IF;

  IF v_bad IS NULL THEN
    RAISE EXCEPTION 'gh1529_p2 PRE-CHECK FAILED (unexpectedly already clean): anon has no EXECUTE on any of the 3 target functions -- this probe expects to run BEFORE the migration, as its fail-first negative control. If the migration is already applied, this is expected to fail here; re-run this file''s SECOND block only.';
  END IF;

  RAISE NOTICE 'gh1529_p2 PRE-CHECK PASSED (fail-first): anon CAN execute: %', v_bad;
END;
$gh1529_p2_before$;

-- ── 2. Apply the migration inline (idempotent REVOKEs) ──────────────────
REVOKE EXECUTE ON FUNCTION public.notify_admin_new_claim() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_admin_new_claim() FROM anon;

REVOKE EXECUTE ON FUNCTION public.notify_admin_new_partner() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_admin_new_partner() FROM anon;

REVOKE EXECUTE ON FUNCTION public.notify_admin_new_router_lead() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_admin_new_router_lead() FROM anon;

-- ── 3. AFTER: assert anon can no longer execute any of the three ────────
DO $gh1529_p2_after$
DECLARE
  v_still_open text;
BEGIN
  SELECT string_agg(proname, ', ') INTO v_still_open
  FROM (
    SELECT p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('notify_admin_new_claim', 'notify_admin_new_partner', 'notify_admin_new_router_lead')
      AND has_function_privilege('anon', p.oid, 'EXECUTE') = true
  ) x;

  IF v_still_open IS NOT NULL THEN
    RAISE EXCEPTION 'gh1529_p2 POST-CHECK FAILED: anon can still execute: % -- REVOKE did not take effect', v_still_open;
  END IF;

  RAISE NOTICE 'gh1529_p2 POST-CHECK PASSED: anon EXECUTE revoked on all 3 target functions.';
END;
$gh1529_p2_after$;

-- ── 4. Kept functions unaffected -- assert the 3 legitimate anon RPCs this
--       migration does NOT touch are still anon-executable, guarding
--       against an over-broad copy/paste of this file being applied wrong ──
DO $gh1529_p2_kept$
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
    RAISE EXCEPTION 'gh1529_p2 KEPT-CHECK FAILED: expected anon EXECUTE to remain on %, but it does not -- this migration must not touch these (real pre-auth callers, see migration header)', v_missing;
  END IF;

  RAISE NOTICE 'gh1529_p2 KEPT-CHECK PASSED: anon EXECUTE untouched on get_lead_prefill, set_lead_role, update_lead_contact.';
END;
$gh1529_p2_kept$;

-- Everything above must be rolled back by the caller -- this file never
-- COMMITs its own REVOKEs. Run as:
--   BEGIN;
--   \i supabase/tests/gh1529_p2_anon_execute_probe.sql
--   ROLLBACK;
