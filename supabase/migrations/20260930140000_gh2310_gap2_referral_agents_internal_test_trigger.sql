-- Migration: 20260930140000_gh2310_gap2_referral_agents_internal_test_trigger
-- GitHub: #2310 Gap 2 (forward mechanism; the 9-id backfill shipped in PR #2400 / 20260930130000_...).
-- Tier: 3B (new trigger on a payout-adjacent table). NOT APPLIED. R-097 notice required before apply.
-- Rollback: supabase/migrations_rollbacks/20260930140000_gh2310_gap2_referral_agents_internal_test_trigger_rollback.sql
-- Pre-flight: supabase/migrations/20260930140000_gh2310_gap2_referral_agents_internal_test_trigger_pre-flight.md
-- Proof: supabase/tests/gh2310_gap2_internal_test_trigger_proof.sql (BEGIN ... ROLLBACK only)
-- Rulings: Ben on #2310: 5911272800 (domain trigger; Carlos stays real) and 5912247548 (include Stacy, base-address rule).
--
-- Summary: a BEFORE INSERT trigger on public.referral_agents sets is_test := true when the new row's email
-- belongs to Dustin or Stacy, so founder self-testing stops contaminating non-test partner counts (the #1961
-- defect class). One helper, public.is_internal_test_email(text), is the single source of truth.
--
-- RULE (exactly this, nothing broader):
--   1. lower(domain) IN (stellaredgeservices.com, tryotterquote.com, stohlerroof.com, otterquote-internal.test)
--      (exact domain match; a lookalike such as stellaredgeservices.com.evil.io does NOT match).
--   2. lower(domain) = gmail.com AND the local part with any +tag stripped equals Dustin's base
--      ('dustinstohler1') or Stacy's base local part. No other gmail rule.
--
-- STACY'S ADDRESS IS NOT IN THIS REPO. At apply time the DO block below reads her address from
-- referral_agents row 0a934e11-5cac-4607-a63c-7446fe446f81, strips any +tag, asserts the domain is gmail.com,
-- and embeds the base local part in the helper via EXECUTE format(... %L ...). It RAISEs (aborting the whole
-- transaction) if the row is missing, the email is null/blank, the domain is not gmail.com, or the base is
-- empty: there is no silent no-op. Consequence, accepted by Ben's ruling: the DEPLOYED FUNCTION BODY
-- (pg_proc.prosrc, in the database, not in git) contains that local part. The repo does not.
--
-- gh-886 GUARD TRIGGER ANALYSIS (referral_agents_guard_payout_columns): it is declared BEFORE UPDATE only
-- (20260818210921_gh886_referral_agents_payout_guard.sql), so it does not fire on INSERT and cannot reject
-- this trigger's is_test write. Trigger-name ordering therefore does not interact with it. Ordering against
-- the two other BEFORE INSERT triggers (referral_agents_generate_code, referral_agents_generate_recruit_code)
-- is also irrelevant (they touch unique_code / recruit_code, not is_test/email); the new name
-- referral_agents_set_is_test_internal sorts after both regardless. The AFTER INSERT alert trigger
-- trg_notify_admin_new_partner runs after BEFORE triggers, sees is_test=true and (per notify-admin-new-partner)
-- still alerts Dustin with a "[TEST] " prefix, so staff-test alerts are not lost.
-- Caveat: INSERT ... ON CONFLICT DO UPDATE would run its UPDATE path through the gh-886 guard, but the guard
-- only objects if the DO UPDATE clause itself changes is_test; this trigger never does that.
--
-- Trigger never sets is_test false and leaves an explicit is_test=true alone. Only INSERT is covered
-- (Ben's ruling). An UPDATE of email to an internal address later does NOT flip is_test (see pre-flight Q1).
--
-- PRIVILEGES (danger pattern 9): both new functions are in public, so Supabase default privileges would grant
-- EXECUTE to anon/authenticated. Each gets REVOKE ALL FROM PUBLIC, anon, authenticated, with NO GRANT lines
-- (service_role keeps its default grant). The trigger function is SECURITY DEFINER (owner runs it) so that an
-- anon/authenticated INSERT still works with those revokes; it reads only NEW and calls the helper. The
-- helper is SECURITY INVOKER + IMMUTABLE with a pinned search_path. No table, column, or data change.

BEGIN;

DO $mig$
DECLARE
  c_stacy_id constant uuid := '0a934e11-5cac-4607-a63c-7446fe446f81'::uuid;
  v_email    text;
  v_domain   text;
  v_base     text;
BEGIN
  SELECT email INTO v_email FROM public.referral_agents WHERE id = c_stacy_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gh2310 gap2 trigger: referral_agents row % not found; cannot derive the second staff base address', c_stacy_id;
  END IF;
  IF v_email IS NULL OR btrim(v_email) = '' THEN
    RAISE EXCEPTION 'gh2310 gap2 trigger: referral_agents row % has a null/blank email', c_stacy_id;
  END IF;

  v_domain := split_part(lower(btrim(v_email)), '@', 2);
  IF v_domain <> 'gmail.com' THEN
    RAISE EXCEPTION 'gh2310 gap2 trigger: referral_agents row % email domain is not gmail.com (got %); refusing to build a gmail base rule from it', c_stacy_id, v_domain;
  END IF;

  v_base := split_part(split_part(lower(btrim(v_email)), '@', 1), '+', 1);
  IF v_base = '' THEN
    RAISE EXCEPTION 'gh2310 gap2 trigger: referral_agents row % yields an empty base local part', c_stacy_id;
  END IF;
  -- Gmail local parts are letters, digits and dots only. Anything else (e.g. a '$' that could end the
  -- $body$ quote in the EXECUTE below) means the row is not what Ben's ruling assumed: fail closed.
  IF v_base !~ '^[a-z0-9.]+$' THEN
    RAISE EXCEPTION 'gh2310 gap2 trigger: referral_agents row % base local part has characters outside [a-z0-9.]', c_stacy_id;
  END IF;

  EXECUTE format($fn$
    CREATE OR REPLACE FUNCTION public.is_internal_test_email(p_email text)
    RETURNS boolean
    LANGUAGE sql
    IMMUTABLE
    SECURITY INVOKER
    SET search_path = pg_catalog, public
    AS $body$
      SELECT CASE
        WHEN p_email IS NULL THEN false
        ELSE
          split_part(lower(btrim(p_email)), '@', 2) IN ('stellaredgeservices.com', 'tryotterquote.com', 'stohlerroof.com', 'otterquote-internal.test')
          OR (
            split_part(lower(btrim(p_email)), '@', 2) = 'gmail.com'
            AND split_part(split_part(lower(btrim(p_email)), '@', 1), '+', 1) IN ('dustinstohler1', %L)
          )
      END
    $body$
  $fn$, v_base);
END
$mig$;

COMMENT ON FUNCTION public.is_internal_test_email(text) IS
'gh-2310 Gap 2: true for Dustin/Stacy staff-test emails (4 internal domains; gmail plus-addressing of two staff base addresses). Single source of truth for the referral_agents is_test trigger. Body embeds Stacy''s base local part, derived at apply time.';

REVOKE ALL ON FUNCTION public.is_internal_test_email(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.referral_agents_flag_internal_test()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.is_test IS NOT TRUE AND public.is_internal_test_email(NEW.email) THEN
    NEW.is_test := true;
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.referral_agents_flag_internal_test() IS
'gh-2310 Gap 2: BEFORE INSERT trigger function; sets is_test=true for staff-test emails via is_internal_test_email(). Never sets false.';

REVOKE ALL ON FUNCTION public.referral_agents_flag_internal_test() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS referral_agents_set_is_test_internal ON public.referral_agents;
CREATE TRIGGER referral_agents_set_is_test_internal
  BEFORE INSERT ON public.referral_agents
  FOR EACH ROW
  EXECUTE FUNCTION public.referral_agents_flag_internal_test();

COMMENT ON TRIGGER referral_agents_set_is_test_internal ON public.referral_agents IS
'gh-2310 Gap 2: flags staff-test partner sign-ups is_test=true at INSERT. INSERT-only by design.';

COMMIT;
