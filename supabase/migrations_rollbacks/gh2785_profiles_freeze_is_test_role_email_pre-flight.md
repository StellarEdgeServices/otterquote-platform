# Pre-flight: gh2785_profiles_freeze_is_test_role_email (Tier 3B, security)

NOT APPLIED. Refs #2785. Protective only (R-134). R-097 24-hour notice applies before apply.

## What it does
Drops the own-row DELETE policy `"Users can delete own profile"` (no client code deletes profiles; only service_role e2e cleanup does) and adds `public.profiles_freeze_privileged_columns()` (SECURITY INVOKER, `search_path = public, pg_temp`) and the trigger of the same name (`BEFORE INSERT OR UPDATE OF is_test, role, email ON public.profiles`). On INSERT by a client (the delete + re-insert bypass found in REVIEW 6172743018) it forces role 'homeowner', is_test false and email from the JWT. On UPDATE, for `anon`/`authenticated` callers whose JWT role is not `service_role`: a changed `is_test` or `email` is refused 42501; a changed `role` is silently pinned to the old value. Re-sent unchanged values are not a change. `service_role`, owner-level sessions and SECURITY DEFINER functions are untouched.

## Who writes the columns today
- `email`: nothing in the apps or in a user-JWT Edge Function. Set once by `handle_new_user()`. No auth-email-change propagation exists today (no `auth.users` UPDATE trigger, no `updateUser({email})`), so freezing breaks nothing; a future email-change feature must write through service_role or a SECURITY DEFINER function.
- `is_test`: nothing in the apps. E2E seeds use service_role.
- `role`: `react-app/app/trade-selector/page.tsx` and `use-dashboard-data.ts` upserts (role:'homeowner'), `js/auth.js` `updateProfile` (role from signup blob) and contractor-signup update (role:'contractor'). Pinned, not refused, so those writes still land their other columns. The real contractor flip is `sync_contractor_profile_role()` (SECURITY DEFINER), unaffected.

## Re-run before apply (SELECT only)
- `select tgname, tgenabled from pg_trigger where tgrelid='public.profiles'::regclass and not tgisinternal;` (expect exactly one non-internal trigger, `profiles_set_is_test_for_internal_domain` (BEFORE INSERT), as read 2026-10-14 by rv6; no `profiles_freeze_privileged_columns`; a different list means re-read before apply).
- `select proname, prosecdef from pg_proc where pronamespace='public'::regnamespace and prosrc ilike '%update%profiles%';` and read each body: apply must not proceed if a SECURITY INVOKER function called with a user JWT writes is_test/email/role.
- `select count(*) from public.profiles p join auth.users u on u.id=p.id where p.email is distinct from u.email;` (informational: pre-existing drift the freeze neither causes nor repairs).
- Apply requires `auth.role()` (live).

- `select policyname, cmd, roles from pg_policies where tablename='profiles';` (expect the DELETE policy "Users can delete own profile", profiles_user_insert, profiles_user_update, profiles_user_read).
- Repair (now folded into the forward transaction per review 6254384170, so the UPDATE below is NOT a separate step; use this select as the before/after check): `select p.id, p.role from public.profiles p join public.contractors c on c.user_id=p.id where p.role is distinct from 'contractor';` (rv6 read 1 row on 2026-10-14); then `update public.profiles p set role='contractor' from public.contractors c where c.user_id=p.id and p.role is distinct from 'contractor';`. The pin removes the client heal path.
- Closes-on wording: role is pinned, not refused, so the production check for role reads "refused or pinned".

## Rollback
`supabase/migrations_rollbacks/gh2785_profiles_freeze_is_test_role_email_rollback.sql` drops the trigger and function and re-creates the DELETE policy.

## Proof
`supabase/tests/gh2785_profiles_freeze_proof.sql` via `gh2785_profiles_freeze_proof_run.sh` (throwaway Postgres).
