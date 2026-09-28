-- Migration: 20260928233000_gh2310_backfill_legacy_internal_test_profiles
-- GitHub: #2310 Gap 1 (residual of #1961). Gap 2 (referral_agents) is NOT in this migration.
-- Tier: 3B (production data UPDATE). NOT APPLIED. Do not apply, merge or deploy without R-097 notice.
-- Rollback: supabase/migrations_rollbacks/20260928233000_gh2310_backfill_legacy_internal_test_profiles_rollback.sql
-- Proof: supabase/tests/gh2310_backfill_proof.sql (BEGIN ... ROLLBACK only)
--
-- Summary: one-time backfill of is_test=true for profiles on @otterquote-internal.test
-- created before #1961's INSERT-only trigger (migration 20260927183251) went live.
-- Measured on production (yeszghaspzwwstvsrioa) 2026-09-28T23:2xZ, SELECT only:
--   profiles on the .test domain, is_test=false: 26   (this migration's target)
--   profiles on the .test domain, is_test=true : 33   (already correct, untouched)
--   profiles NOT on .test domain, is_test=true : 17   (untouched; not matched by predicate)
--   claims / contractors owned by the 26 target profiles with is_test=false: 0 / 0
-- The dependent-table UPDATEs below are therefore expected to touch 0 rows today; they are
-- kept so the migration stays correct if rows appear between measurement and apply.
--
-- Guard: the DO block aborts (whole transaction rolls back) if the profiles update touches
-- more than 60 rows or any row whose email is not on the .test domain.
-- Idempotent: second run matches 0 rows.

BEGIN;

DO $$
DECLARE
  v_profiles int;
  v_bad int;
BEGIN
  WITH upd AS (
    UPDATE public.profiles
       SET is_test = true
     WHERE email ILIKE '%@otterquote-internal.test'
       AND is_test = false
    RETURNING email
  )
  SELECT count(*), count(*) FILTER (WHERE email NOT ILIKE '%@otterquote-internal.test')
    INTO v_profiles, v_bad FROM upd;

  IF v_bad <> 0 OR v_profiles > 60 THEN
    RAISE EXCEPTION 'gh2310 guard tripped: profiles=%, off-domain=%', v_profiles, v_bad;
  END IF;

  UPDATE public.claims c SET is_test = true
    FROM public.profiles p
   WHERE c.user_id = p.id AND p.is_test = true
     AND p.email ILIKE '%@otterquote-internal.test' AND c.is_test = false;

  UPDATE public.contractors c SET is_test = true
    FROM public.profiles p
   WHERE c.user_id = p.id AND p.is_test = true
     AND p.email ILIKE '%@otterquote-internal.test' AND c.is_test = false;

  RAISE NOTICE 'gh2310: backfilled % profiles', v_profiles;
END
$$;

COMMIT;
