-- STATUS (as of 2026-11-11): NOT APPLIED -- DRAFT (re-headed to the live set; supersedes the 2026-11-01 40/3 version, R-097 notice 6806240445)
-- FILE ROLE: forward file of set gh3197_backfill_internal_test_is_test
-- EVIDENCE: production read-only 2026-11-11 ~20:20Z (project yeszghaspzwwstvsrioa, SELECT only): 34 profiles with is_internal_test_email(email) and is_test IS NOT TRUE,
--   and 2 claims owned by them with is_test IS NOT TRUE. Control (profiles NOT is_internal_test_email and is_test IS NOT TRUE): 10 rows, left(md5(string_agg(id::text, ',' ORDER BY id)),12) = 64f8f4a1eebd.
--   (6 of the earlier 40 profiles and 1 of the earlier 3 claims were flagged by something else after 2026-11-01 and are NOT in this set.) No database was written to produce this file.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-- MUST RUN AS service_role / postgres: profiles_freeze_privileged_columns refuses is_test changes from client roles (gh-2785).
--
-- Backfill: GitHub #3197, Ben's rulings 6522509807 and 6522674646. Applied after gh3197_internal_test_signups_is_test (already applied, ledger 20261031181105).
-- RAISE-ONLY: sets is_test=true, never lowers it; touches only rows whose is_test is currently not true.
-- Selection rule is UNCHANGED from the original draft: public.is_internal_test_email(email) (five company domains exactly, plus only the gmail inboxes
--   dustinstohler1 / stacymortonfitfan with or without +tag). Claims are selected through their owning profile (claims.user_id = profiles.id) by the same predicate.
-- The exact-count aborts are the guard: if live counts differ from 34 / 2 on the day of apply, re-derive by SELECT and re-head before applying.
-- Rollback: gh3197_backfill_internal_test_is_test_rollback.sql (hard-coded ids = exactly the rows this file changes).
-- Tier: 3B (R-097 24-hour notice 6806240445, CTO applies).

BEGIN;

DO $bf$
DECLARE
  n_profiles int; n_claims int;
  ctrl_n_before int; ctrl_h_before text; ctrl_n_after int; ctrl_h_after text;
  left_profiles int; left_claims int;
BEGIN
  -- Control: non-internal, unflagged profiles must not move.
  SELECT count(*), left(md5(string_agg(id::text, ',' ORDER BY id)), 12)
    INTO ctrl_n_before, ctrl_h_before
    FROM public.profiles
   WHERE NOT public.is_internal_test_email(email) AND is_test IS NOT TRUE;
  IF ctrl_n_before <> 10 OR ctrl_h_before IS DISTINCT FROM '64f8f4a1eebd' THEN
    RAISE EXCEPTION 'gh-3197 backfill: control set changed before apply (got % / %, expected 10 / 64f8f4a1eebd); re-read and re-head', ctrl_n_before, ctrl_h_before;
  END IF;

  UPDATE public.profiles
     SET is_test = true
   WHERE public.is_internal_test_email(email)
     AND is_test IS NOT TRUE;
  GET DIAGNOSTICS n_profiles = ROW_COUNT;
  IF n_profiles <> 34 THEN
    RAISE EXCEPTION 'gh-3197 backfill: expected 34 profiles updated, got % (rows changed since 2026-11-11; re-read and re-head before applying)', n_profiles;
  END IF;

  UPDATE public.claims c
     SET is_test = true
    FROM public.profiles p
   WHERE p.id = c.user_id
     AND public.is_internal_test_email(p.email)
     AND c.is_test IS NOT TRUE;
  GET DIAGNOSTICS n_claims = ROW_COUNT;
  IF n_claims <> 2 THEN
    RAISE EXCEPTION 'gh-3197 backfill: expected 2 claims updated, got % (rows changed since 2026-11-11; re-read and re-head before applying)', n_claims;
  END IF;

  -- Post-checks: both populations drained, control unchanged.
  SELECT count(*) INTO left_profiles FROM public.profiles
   WHERE public.is_internal_test_email(email) AND is_test IS NOT TRUE;
  SELECT count(*) INTO left_claims FROM public.claims c JOIN public.profiles p ON p.id = c.user_id
   WHERE public.is_internal_test_email(p.email) AND c.is_test IS NOT TRUE;
  IF left_profiles <> 0 OR left_claims <> 0 THEN
    RAISE EXCEPTION 'gh-3197 backfill: post-check failed, still unflagged profiles=% claims=% (want 0/0)', left_profiles, left_claims;
  END IF;

  SELECT count(*), left(md5(string_agg(id::text, ',' ORDER BY id)), 12)
    INTO ctrl_n_after, ctrl_h_after
    FROM public.profiles
   WHERE NOT public.is_internal_test_email(email) AND is_test IS NOT TRUE;
  IF ctrl_n_after <> ctrl_n_before OR ctrl_h_after IS DISTINCT FROM ctrl_h_before THEN
    RAISE EXCEPTION 'gh-3197 backfill: control set changed (% / % -> % / %)', ctrl_n_before, ctrl_h_before, ctrl_n_after, ctrl_h_after;
  END IF;
END
$bf$;

COMMIT;
