<!-- STATUS (gh-1438, as of 2026-11-10T20:00:00Z): NOT APPLIED -->
<!-- FILE ROLE: pre-flight of set gh3256b_default_privs_no_anon_execute (forward and rollback beside it) -->
<!-- EVIDENCE: production read-only (SELECT) 2026-11-10 by CTO RUN 102 worker, project yeszghaspzwwstvsrioa; no database was written. -->
<!-- REPO COPY: none. DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md -->

# Pre-flight: gh3256b_default_privs_no_anon_execute (#3256)

Tier 3B: a default-privilege change. Follows the R-097 24-hour notice. Project P18. Scope addition to #3256 (the tables half is applied). Reviewed: REVIEW 6776836494 (PASS on the SQL; this file, the header reword and a production read were owed before apply).

## 1. What changes, in business terms

Today, every database function we create from now on is, by default, callable by anyone on the internet who holds our public app key, without signing in. That default is how one internal function (`fee_acceptance_quarantine_add`) became publicly callable by accident (fixed one-off in PR #3608). This change flips the default: a new function is callable only by the platform itself and by signed-in users, and a function that logged-out visitors must be able to call has to be opened on purpose, in its own migration.

Nothing that exists today changes. No table, no existing function and no existing permission is touched. No page, email or payment behaves differently the moment this is applied.

## 2. Who is affected

- Customers (homeowners, contractors, partners): nobody, today. Existing functions keep the permissions they have.
- Engineers and agents writing future migrations: yes. They must follow the rules in section 5.
- Logged-out visitors: only if a future function is meant for them and its migration forgets the explicit grant. The failure is then loud at runtime (a permission error), not silent exposure.

## 3. Risk

Low for production today; moderate for future work if the rules in section 5 are skipped.

- Blast radius today is zero rows and zero existing functions. It changes the default for functions created after the apply.
- The second statement is global for the migration role (it is not limited to schema public), so a future function postgres creates in a non-public schema gets EXECUTE for its owner only. This repo creates no functions outside `public` today (REVIEW 6776836494, 205 qualified plus 3 unqualified definitions, all public). Supabase-managed extensions are created by the superuser, not postgres, and are unaffected (tested with pgcrypto and pg_trgm).
- Row-level-security helper trap: a NEW helper function used in a policy that has no `TO` clause, or a DROP + CREATE of an existing anon-evaluated helper (for example `is_admin_email()` on `payout_approvals`, `platform_fee_config`, `claims`, `hover_orders`), makes every logged-out query on that table error (42501) instead of returning zero rows, unless the helper is granted to anon or the policy is scoped `TO authenticated`.
- Functions created by supabase_admin (platform-managed) keep the old defaults; postgres cannot alter that row (42501). This change does not cover them.
- A new anon-granting migration now needs the PR label `permissions-ratchet: reviewed` (the CI permissions ratchet fails a new `GRANT EXECUTE ... TO anon` otherwise).
- Locking: ALTER DEFAULT PRIVILEGES takes no table locks. The forward sets `lock_timeout = '5s'` anyway.
- The proof ran on PG 16; production is PG 17.6. Default-ACL semantics are the same for these statements.

## 4. Production facts (read-only, 2026-11-10, project yeszghaspzwwstvsrioa)

Function default privileges (`pg_default_acl`, objtype `f`; the full listing has 24 rows, none global):

| role | schema | ACL |
|---|---|---|
| postgres | public | `{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}` |
| postgres | storage | `{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}` |
| supabase_admin | public | `{postgres=X/supabase_admin,anon=X/supabase_admin,authenticated=X/supabase_admin,service_role=X/supabase_admin}` |
| supabase_admin | extensions, realtime, graphql_public, graphql, cron | platform rows, not altered by this change |
| supabase_auth_admin | auth | `{postgres=X/supabase_auth_admin,dashboard_user=X/supabase_auth_admin}` |

- There is NO global (schema-less) default row for postgres or supabase_admin, so the global PUBLIC revoke starts from the built-in default; the forward's probe would fail closed on an unknown global row.
- The (postgres, storage, f) row exists and is not touched by the forward (statement 1 is scoped to public; statement 2 removes only the built-in PUBLIC grant). It still lists anon and authenticated, so a postgres-created function in `storage` keeps those two.
- Functions in `public`: 159 total; 46 executable by anon; 36 executable by PUBLIC. These are existing functions and are not touched.

Raw output is on PR #3620 (comment posted with this file).

## 5. Rules after apply (for every future migration)

1. A function anon must call (an RPC or an RLS helper) needs `GRANT EXECUTE ON FUNCTION public.<fn>(<args>) TO anon` in the same migration, and the PR needs the label `permissions-ratchet: reviewed`.
2. A DROP FUNCTION + CREATE FUNCTION of an anon-callable function must repeat its GRANT. CREATE OR REPLACE keeps grants.
3. A new helper used in a policy with no `TO` clause must be granted to anon, or the policy must be scoped `TO authenticated`.
4. A function created outside `public` gets EXECUTE for the owner only; grant authenticated and/or service_role explicitly.
5. Keep the habit of an explicit REVOKE from PUBLIC/anon; it is now belt-and-braces.

## 6. Apply

1. Run the forward through the normal migration path, as `postgres`. Its post-assertions refuse the commit if anon keeps EXECUTE on a new function, or if authenticated or service_role lose it in public.
2. Verify (all read-only):
   - Re-run the default-ACL SELECT: `select defaclrole::regrole, defaclnamespace::regnamespace, defaclobjtype, defaclacl from pg_default_acl order by 1,2,3;` Expected: (postgres, public, f) no longer lists anon; a new (postgres, 0, f) row `{postgres=X/postgres}` appears; every other row is identical to section 4. Row count goes from 24 to 25.
   - Re-run `get_advisors` (security) and confirm the "new functions executable by anon" finding is gone or no longer attributes to future functions; no new finding appears.
   - Re-run the counts query: functions in public executable by anon and by PUBLIC must still be 46 and 36 (existing functions untouched).
3. File the forward under its ledger version in `supabase/migrations/`, and move the rollback and pre-flight to `supabase/migrations_rollbacks/`. Add the README row.

## 7. Rollback

Run `gh3256b_default_privs_no_anon_execute_rollback.sql` (exact inverse: re-grant EXECUTE to anon in public, and remove the global PUBLIC revoke). In the proof, `pg_default_acl` afterwards is identical to before (6 rows in the model, run twice). A function created while the forward was in force stays closed to anon; re-grant it by hand if needed. Existing functions are never changed by apply or rollback.

## 8. Proof

`bash supabase/tests/gh3256b_default_privs_functions_proof_run.sh` on a throwaway PG16 cluster bootstrapped as supabase_admin: 23/23 checks pass, 13/13 mutants killed. The independent reviewer re-ran it and added their own cases (REVIEW 6776836494).
