-- STATUS (gh-1438, as of 2026-10-14T15:58:46Z): NOT APPLIED
-- FILE ROLE: forward file of set gh2785_profiles_freeze_is_test_role_email (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: issue #2785 (triage comments 6171651955, 6172413408); production read-only 2026-10-14 (CTO RUN 67): authenticated holds table-level UPDATE on public.profiles, policy profiles_user_update has no column limit, the only trigger is BEFORE INSERT; rolled-back proof in supabase/tests/gh2785_profiles_freeze_proof.sql
-- REPO COPY: none in supabase/migrations/ yet
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- gh-2785 (SECURITY): a signed-in user cannot change their own profiles.is_test, profiles.email or (silently) profiles.role,
-- whether by UPDATE or by DELETE + re-INSERT of their own row (REVIEW: FAIL 6172743018, B1).
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
-- Change. (1) One SECURITY INVOKER trigger function profiles_freeze_privileged_columns() and one trigger of the same name,
-- BEFORE INSERT OR UPDATE OF is_test, role, email ON public.profiles. Only when current_user IN ('anon','authenticated') AND
-- the JWT role is not service_role (the test the live claims guards use):
--   - UPDATE, is_test or email changed (IS DISTINCT FROM): refused 42501. Re-sending the same value is not a change.
--   - UPDATE, role changed: NEW.role := OLD.role (silent pin).
--   - INSERT (profiles_user_insert lets a user insert their own row, and production also had an own-row DELETE policy, so
--     delete + re-insert was a bypass): NEW.role := 'homeowner', NEW.is_test := false, NEW.email := the JWT email
--     (auth.jwt()->>'email', NULL if the token has none). Forced, not refused, because dashboard.html:1690-1708,
--     use-dashboard-data.ts:179 and trade-selector page.tsx:855 insert/upsert a missing profile with role:'homeowner' and no
--     email. The existing BEFORE INSERT trigger profiles_set_is_test_for_internal_domain sorts AFTER this trigger
--     ('profiles_freeze...' < 'profiles_set...'), so an @otterquote-internal.test address is still flagged is_test=true.
--     An upsert's ON CONFLICT DO UPDATE sees the forced values as EXCLUDED, and the UPDATE branch then pins role.
--     Contractor signup is unaffected: handle_new_user() (SECURITY DEFINER, current_user = owner) creates the row with the
--     column defaults (role 'homeowner'), js/auth.js:1435 is an UPDATE of an existing row, and the contractor flip is
--     sync_contractor_profile_role() (SECURITY DEFINER, AFTER INSERT ON contractors).
-- (2) DROP POLICY "Users can delete own profile" ON public.profiles. No client code deletes profiles (grep of both apps:
--     only tests/e2e/flows/test-world-symmetry.spec.ts:193 and :225, which use the service_role client). Deleting a profile
--     cascades to messages and home_profiles, so the policy was also a data-loss lever. profiles_user_insert is KEPT (the
--     dashboard creates a missing profile client-side).
-- APPLY NOTE (N2): production has one contractor whose profiles.role is not 'contractor' (read-only 2026-10-14, rv6). The pin
-- removes the client heal path (js/auth.js:1435), so the same transaction repairs that row (idempotent UPDATE before COMMIT; review 6254384170).
-- SET LOCAL lock_timeout = '5s' after BEGIN makes the apply fail fast instead of stalling profile reads.
-- service_role (every Edge Function), postgres/owner-level sessions and SECURITY DEFINER functions (current_user is the
-- owner inside them) are untouched. SECURITY INVOKER on purpose: current_user must be the caller.
-- Not changed: any existing trigger or function, any other policy, any grant, any data.
-- Idempotent: CREATE OR REPLACE FUNCTION; DROP TRIGGER IF EXISTS before CREATE TRIGGER; DROP POLICY IF EXISTS. No GRANT or REVOKE.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.profiles_freeze_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $guard$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND COALESCE(auth.role(), '') <> 'service_role' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.role := 'homeowner';
      NEW.is_test := false;
      NEW.email := auth.jwt() ->> 'email';
      RETURN NEW;
    END IF;
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
  'gh-2785: BEFORE INSERT OR UPDATE OF is_test, role, email guard on public.profiles. Client roles (anon, authenticated) that are not service_role cannot change is_test or email on UPDATE (42501), cannot change role (silently pinned), and on INSERT get role homeowner, is_test false and email from the JWT. service_role, owner-level sessions and SECURITY DEFINER functions are untouched.';

DROP TRIGGER IF EXISTS profiles_freeze_privileged_columns ON public.profiles;
CREATE TRIGGER profiles_freeze_privileged_columns
  BEFORE INSERT OR UPDATE OF is_test, role, email ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_freeze_privileged_columns();

DROP POLICY IF EXISTS "Users can delete own profile" ON public.profiles;

-- N2 repair, in the same transaction (idempotent; runs as the migration owner, so the trigger does not touch it).
UPDATE public.profiles p SET role = 'contractor' FROM public.contractors c WHERE c.user_id = p.id AND p.role IS DISTINCT FROM 'contractor';

COMMIT;
