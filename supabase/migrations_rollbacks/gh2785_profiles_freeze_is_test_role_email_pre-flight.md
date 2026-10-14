# Pre-flight: gh2785_profiles_freeze_is_test_role_email (Tier 3B, security)

NOT APPLIED. Refs #2785. Protective only (R-134). R-097 24-hour notice applies before apply.

## What it does
Adds `public.profiles_freeze_privileged_columns()` (SECURITY INVOKER, `search_path = public, pg_temp`) and the trigger of the same name (`BEFORE UPDATE OF is_test, role, email ON public.profiles`). For `anon`/`authenticated` callers whose JWT role is not `service_role`: a changed `is_test` or `email` is refused 42501; a changed `role` is silently pinned to the old value. Re-sent unchanged values are not a change. `service_role`, owner-level sessions and SECURITY DEFINER functions are untouched.

## Who writes the columns today
- `email`: nothing in the apps or in a user-JWT Edge Function. Set once by `handle_new_user()`. No auth-email-change propagation exists today (no `auth.users` UPDATE trigger, no `updateUser({email})`), so freezing breaks nothing; a future email-change feature must write through service_role or a SECURITY DEFINER function.
- `is_test`: nothing in the apps. E2E seeds use service_role.
- `role`: `react-app/app/trade-selector/page.tsx` and `use-dashboard-data.ts` upserts (role:'homeowner'), `js/auth.js` `updateProfile` (role from signup blob) and contractor-signup update (role:'contractor'). Pinned, not refused, so those writes still land their other columns. The real contractor flip is `sync_contractor_profile_role()` (SECURITY DEFINER), unaffected.

## Re-run before apply (SELECT only)
- `select tgname, tgenabled from pg_trigger where tgrelid='public.profiles'::regclass and not tgisinternal;` (expect only `profiles_set_is_test_for_internal_domain`, plus the notify triggers; no `profiles_freeze_privileged_columns`).
- `select proname, prosecdef from pg_proc where pronamespace='public'::regnamespace and prosrc ilike '%update%profiles%';` and read each body: apply must not proceed if a SECURITY INVOKER function called with a user JWT writes is_test/email/role.
- `select count(*) from public.profiles p join auth.users u on u.id=p.id where p.email is distinct from u.email;` (informational: pre-existing drift the freeze neither causes nor repairs).
- Apply requires `auth.role()` (live).

## Rollback
`supabase/migrations_rollbacks/gh2785_profiles_freeze_is_test_role_email_rollback.sql` drops the trigger and function only.

## Proof
`supabase/tests/gh2785_profiles_freeze_proof.sql` via `gh2785_profiles_freeze_proof_run.sh` (throwaway Postgres).
