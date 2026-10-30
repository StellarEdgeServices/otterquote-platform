-- STATUS (as of 2026-10-30): NOT APPLIED -- DRAFT
-- FILE ROLE: forward file of set gh3212_freeze_claims_is_test (rollback and pre-flight are siblings in this directory; proof in supabase/tests/)
-- EVIDENCE: production read-only 2026-10-30 (project yeszghaspzwwstvsrioa), SELECT / pg_get_functiondef only:
--   has_column_privilege(role, 'public.claims', 'is_test', 'UPDATE') is true for anon, authenticated and service_role (INSERT also true for all three);
--   none of the 18 non-internal triggers on public.claims touches is_test on UPDATE (claims_guard_referral_columns freezes referral_id,
--   completion_date, created_at and status only); no public function has an UPDATE claims ... is_test statement. 38 claims: 31 is_test, 7 not.
--   No database was written to produce this file.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3212_freeze_claims_is_test
-- GitHub: #3212. Tier: 3B (security, new trigger on claims; R-097 24-hour notice, CTO applies).
-- Rollback: supabase/migrations_drafts/gh3212_freeze_claims_is_test_rollback.sql
-- Pre-flight: supabase/migrations_drafts/gh3212_freeze_claims_is_test_pre-flight.md
-- Proof: supabase/tests/gh3212_freeze_claims_is_test_proof.sql
--
-- Why: a homeowner JWT (role authenticated) holds column UPDATE on claims.is_test and no trigger freezes it, so an owner can flip
-- their own claim to is_test=true (hides it from the admin alerts and from real counts) or a test claim to false (pollutes counts).
--
-- Design: mirrors profiles_freeze_privileged_columns() (gh-2785): refuse a CHANGE of is_test from a client role, 42501. Same test
-- as that function: current_user IN ('anon','authenticated') AND auth.role() <> 'service_role'. service_role and postgres (and every
-- SECURITY DEFINER function owned by postgres) are unaffected. No admin exemption, as for profiles.is_test: no admin page writes it.
-- A write that leaves is_test unchanged is allowed, so a whole-row client UPDATE is not broken.
-- Separate function + trigger (not an edit of claims_guard_referral_columns()) so this file does not conflict with PR #3209 (gh-3197),
-- which replaces that function to add an INSERT-only is_test inheritance block. This trigger is UPDATE-only; INSERT is #3209's.
-- Trigger is BEFORE UPDATE OF is_test, so it does not run on updates that do not name is_test.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.claims_freeze_is_test()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND COALESCE(auth.role(), '') <> 'service_role' THEN
    IF NEW.is_test IS DISTINCT FROM OLD.is_test THEN
      RAISE EXCEPTION 'claims.is_test can only be changed by service_role (gh-3212)' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS claims_freeze_is_test ON public.claims;
CREATE TRIGGER claims_freeze_is_test
  BEFORE UPDATE OF is_test ON public.claims
  FOR EACH ROW EXECUTE FUNCTION public.claims_freeze_is_test();

COMMIT;
