-- STATUS (as of 2026-10-30): NOT APPLIED -- DRAFT
-- FILE ROLE: forward file of set gh3197_backfill_internal_test_is_test (rollback is a sibling)
-- EVIDENCE: production read-only 2026-10-30 (project yeszghaspzwwstvsrioa): 38 profiles with is_internal_test_email(email) and is_test<>true
--   (gmail dustinstohler1 base 18, stellaredgeservices 13, otterquote 4, stohlerroof 2, tryotterquote 1) and 3 claims owned by them
--   (gmail 1, otterquote 1, tryotterquote 1). No database was written to produce this file.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-- MUST RUN AS service_role / postgres: profiles_freeze_privileged_columns refuses is_test changes from client roles (gh-2785).
--
-- Backfill: GitHub #3197, Ben's rulings 6522509807 and 6522674646. Applied in the same R-097 window as
-- gh3197_internal_test_signups_is_test (apply that one FIRST). RAISE-ONLY: sets is_test=true, never lowers it.
-- Row-paste precondition dropped by Ben (6522674646): is_internal_test_email() matches five company domains exactly plus only the
-- gmail inboxes dustinstohler1 / stacymortonfitfan (+tag), so no real homeowner can match.
-- Rollback: gh3197_backfill_internal_test_is_test_rollback.sql (hard-coded ids below).
-- Tier: 3B with the sibling migration (R-097 24-hour notice, CTO applies).

BEGIN;

UPDATE public.profiles
   SET is_test = true
 WHERE public.is_internal_test_email(email)
   AND is_test IS NOT TRUE;
-- expected: 38 rows

UPDATE public.claims c
   SET is_test = true
  FROM public.profiles p
 WHERE p.id = c.user_id
   AND public.is_internal_test_email(p.email)
   AND c.is_test IS NOT TRUE;
-- expected: 3 rows

COMMIT;
