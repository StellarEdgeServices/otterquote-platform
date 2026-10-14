-- STATUS (gh-1438, as of 2026-10-14T15:58:46Z): NOT APPLIED
-- FILE ROLE: forward file of set gh2785_profiles_freeze_is_test_role_email (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: issue #2785 (triage comments 6171651955, 6172413408); production read-only 2026-10-14 (CTO RUN 67): authenticated holds table-level UPDATE on public.profiles, policy profiles_user_update has no column limit, the only trigger is BEFORE INSERT; rolled-back proof in supabase/tests/gh2785_profiles_freeze_proof.sql
-- REPO COPY: none in supabase/migrations/ yet
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- gh-2785 (SECURITY): a signed-in user cannot change their own profiles.is_test, profiles.email or (silently) profiles.role.
-- Tier: 3B (new trigger on a user table). Protective only (R-134): it only removes capability from client roles.
-- NOT APPLIED by the authoring session or by CI. R-097 notice applies.
-- Rollback: supabase/migrations_rollbacks/gh2785_profiles_freeze_is_test_role_email_rollback.sql
-- Pre-flight: supabase/migrations_rollbacks/gh2785_profiles_freeze_is_test_role_email_pre-flight.md
-- Proof (throwaway Postgres): supabase/tests/gh2785_profiles_freeze_proof.sql, run by ..._proof_run.sh
--
-- Why a trigger and not a column REVOKE. authenticated holds TABLE-level UPDATE on public.profiles, so
-- REVOKE UPDATE (col) is a no-op; the fix would be REVOKE UPDATE ON profiles + a column-list re-grant, which changes the
-- privilege surface of every current and future column (and of PostgREST upserts, which need UPDATE on every column in
-- the SET list). A BEFORE UPDATE OF trigger is additive, matches the contractors_freeze_privileged_columns precedent (#2443)
-- and is reversible by dropping two objects.
--
-- Client paths that write profiles (enumerated 2026-10-14, see the PR body for the command and raw output):
--   email    : no client or user-JWT Edge Function writes it. profiles.email is set once by handle_new_user() (SECURITY
--              DEFINER, AFTER INSERT ON auth.users). No code path propagates an auth email change to profiles (no
--              auth.users UPDATE trigger, no updateUser({email}) call anywhere), so freezing it removes no working feature.
--   is_test  : no client path writes it. Test seeds (tests/e2e/seed/seed.mjs, test-world-symmetry.spec.ts) use service_role.
--   role     : THREE client paths write it, so a hard refusal would break them: trade-selector page.tsx upsert and
--              dashboard use-dashboard-data.ts upsert / Auth.updateProfile send role:'homeowner'; js/auth.js
--              handleAuthCallback sends role:'contractor' on contractor signup. role is NOT NULL DEFAULT 'homeowner' and the
--              row always exists first (handle_new_user), and the real contractor flip is done by
--              sync_contractor_profile_role() (SECURITY DEFINER, AFTER INSERT ON contractors), which runs as the owner and
--              is untouched. So role is PINNED (NEW.role := OLD.role, no error): the legacy writes still succeed for their other
--              columns (full_name, phone, address) and cannot change role.
--
-- Change. One SECURITY INVOKER trigger function profiles_freeze_privileged_columns() and one trigger of the same name,
-- BEFORE UPDATE OF is_test, role, email ON public.profiles. Only when current_user IN ('anon','authenticated') AND the JWT
-- role is not service_role (the test the live claims guards use):
--   - is_test or email changed (IS DISTINCT FROM): refused 42501. Re-sending the same value is not a change.
--   - role changed: NEW.role := OLD.role (silent pin).
-- service_role (every Edge Function), postgres/owner-level sessions and SECURITY DEFINER functions (current_user is the
-- owner inside them) are untouched. SECURITY INVOKER on purpose: current_user must be the caller.
-- Not changed: any existing trigger or function, any policy, any grant, any data. INSERT is out of scope (the existing
-- BEFORE INSERT trigger profiles_set_is_test_for_internal_domain handles is_test at creation).
-- Idempotent: CREATE OR REPLACE FUNCTION; DROP TRIGGER IF EXISTS before CREATE TRIGGER. No GRANT or REVOKE.

BEGIN;

CREATE OR REPLACE FUNCTION public.profiles_freeze_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $guard$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND COALESCE(auth.role(), '') <> 'service_role' THEN
    IF NEW.is_test IS DISTINCT FROM OLD.is_test THEN
      RAISE EXCEPTION 'profiles.is_test can only be changed by service_role (gh-2785)' USING ERRCODE = '42501';
    END IF;
    IF NEW.email IS DISTINCT FROM OLD.email THEN
      RAISE EXCEPTION 'profiles.email can only be changed by service_role (gh-2785)' USING ERRCODE = '42501';
    END IF;
    IF NEW.role IS DISTINCT FROM OLD.role THEN
      NEW.role := OLD.role;
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;

COMMENT ON FUNCTION public.profiles_freeze_privileged_columns() IS
  'gh-2785: BEFORE UPDATE OF is_test, role, email guard on public.profiles. Client roles (anon, authenticated) that are not service_role cannot change is_test or email (42501) and cannot change role (silently pinned to the old value). service_role, owner-level sessions and SECURITY DEFINER functions are untouched.';

DROP TRIGGER IF EXISTS profiles_freeze_privileged_columns ON public.profiles;
CREATE TRIGGER profiles_freeze_privileged_columns
  BEFORE UPDATE OF is_test, role, email ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_freeze_privileged_columns();

COMMIT;
