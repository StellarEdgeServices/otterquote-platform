-- Migration: 20261019224248_gh2154_internal_test_email_add_otterquote_com
-- GitHub: #2154 (shared partner foundation P-1..P-5, D-333). Ruling: Ben, CEO RUN 111, comment 6274019475, item 1:
--   "RULED: add otterquote.com to the test-domain list. No is_test=false window."
-- Tier: 3B (changes which referral_agents rows are born is_test). NOT APPLIED. Dustin's word in Marty's chat
--   is required before apply (R-077/R-135); R-097 notice per the migration-author protocol.
-- Rollback: supabase/migrations_rollbacks/20261019224248_gh2154_internal_test_email_add_otterquote_com_rollback.sql
-- Pre-flight: supabase/migrations/20261019224248_gh2154_internal_test_email_add_otterquote_com_pre-flight.md
-- Proof: supabase/tests/gh2154_otterquote_com_test_domain_proof.sql (BEGIN ... ROLLBACK only)
--
-- WHAT CHANGES: exactly one domain, 'otterquote.com', is added to the IN-list of
-- public.is_internal_test_email(text). Nothing else in the rule moves. The only caller is the BEFORE INSERT
-- trigger function public.referral_agents_flag_internal_test() (gh-2310 Gap 2; SELECT of pg_proc/pg_views/
-- pg_indexes/pg_policies on 2026-10-19 found no other dependent), so the effect is: a NEW referral_agents row
-- whose email is @otterquote.com (including plus-addresses such as sloane+walk1@otterquote.com) is born
-- is_test = true. Existing rows are untouched (INSERT-only trigger; no backfill here). On 2026-10-19 there is
-- one referral_agents row at @otterquote.com and it is already is_test = true.
-- Exact domain match: otterquote.com.evil.io, nototterquote.com and otterquotes.com do NOT match.
--
-- STACY'S ADDRESS IS STILL NOT IN THIS REPO. The helper body embeds her gmail base local part (gh-2310
-- ruling 5912247548). This migration re-derives it at apply time exactly as 20261003014844 did, from
-- referral_agents row 0a934e11-5cac-4607-a63c-7446fe446f81, with the same fail-closed RAISEs, and then
-- asserts the rebuilt helper agrees with the deployed one on the old rule (so it cannot silently drop her).
--
-- PRIVILEGES: unchanged from 20261003014844 (REVOKE ALL FROM PUBLIC, anon, authenticated; no GRANT).

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
    RAISE EXCEPTION 'gh2154 test-domain: referral_agents row % not found; cannot derive the second staff base address', c_stacy_id;
  END IF;
  IF v_email IS NULL OR btrim(v_email) = '' THEN
    RAISE EXCEPTION 'gh2154 test-domain: referral_agents row % has a null/blank email', c_stacy_id;
  END IF;

  v_domain := split_part(lower(btrim(v_email)), '@', 2);
  IF v_domain <> 'gmail.com' THEN
    RAISE EXCEPTION 'gh2154 test-domain: referral_agents row % email domain is not gmail.com (got %)', c_stacy_id, v_domain;
  END IF;

  v_base := split_part(split_part(lower(btrim(v_email)), '@', 1), '+', 1);
  IF v_base = '' THEN
    RAISE EXCEPTION 'gh2154 test-domain: referral_agents row % yields an empty base local part', c_stacy_id;
  END IF;
  IF v_base !~ '^[a-z0-9.]+$' THEN
    RAISE EXCEPTION 'gh2154 test-domain: referral_agents row % base local part has characters outside [a-z0-9.]', c_stacy_id;
  END IF;

  -- Guard: the deployed helper must already accept Stacy's base (i.e. we are rebuilding what 20261003014844 built).
  IF public.is_internal_test_email(v_base || '+gh2154guard@' || 'gmail.com') IS NOT TRUE THEN
    RAISE EXCEPTION 'gh2154 test-domain: deployed is_internal_test_email does not accept the derived staff base; refusing to rebuild';
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
          split_part(lower(btrim(p_email)), '@', 2) IN ('stellaredgeservices.com', 'tryotterquote.com', 'stohlerroof.com', 'otterquote-internal.test', 'otterquote.com')
          OR (
            split_part(lower(btrim(p_email)), '@', 2) = 'gmail.com'
            AND split_part(split_part(lower(btrim(p_email)), '@', 1), '+', 1) IN ('dustinstohler1', %L)
          )
      END
    $body$
  $fn$, v_base);

  -- Post-conditions (fail closed: any miss aborts the whole transaction).
  IF public.is_internal_test_email('sloane+walk1@otterquote.com') IS NOT TRUE
     OR public.is_internal_test_email('Sloane@OtterQuote.com') IS NOT TRUE THEN
    RAISE EXCEPTION 'gh2154 test-domain: otterquote.com not accepted after rebuild';
  END IF;
  IF public.is_internal_test_email('x@otterquote.com.evil.io')
     OR public.is_internal_test_email('x@nototterquote.com')
     OR public.is_internal_test_email('x@otterquotes.com')
     OR public.is_internal_test_email('x@example.com') THEN
    RAISE EXCEPTION 'gh2154 test-domain: a near-miss domain was accepted after rebuild';
  END IF;
  IF public.is_internal_test_email(v_base || '+gh2154guard@' || 'gmail.com') IS NOT TRUE
     OR public.is_internal_test_email('dustinstohler1+gh2154guard@' || 'gmail.com') IS NOT TRUE
     OR public.is_internal_test_email('x@stellaredgeservices.com') IS NOT TRUE THEN
    RAISE EXCEPTION 'gh2154 test-domain: an existing rule was lost in the rebuild';
  END IF;
END
$mig$;

COMMENT ON FUNCTION public.is_internal_test_email(text) IS
'gh-2310 Gap 2 + gh-2154: true for staff-test emails (5 internal domains incl. otterquote.com per Ben 6274019475; gmail plus-addressing of two staff base addresses). Single source of truth for the referral_agents is_test trigger. Body embeds Stacy''s base local part, derived at apply time.';

REVOKE ALL ON FUNCTION public.is_internal_test_email(text) FROM PUBLIC, anon, authenticated;

COMMIT;
