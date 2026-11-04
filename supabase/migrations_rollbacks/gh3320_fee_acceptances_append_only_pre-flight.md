# gh-3320 pre-flight: public.fee_acceptances append-only for client roles (Tier 3B: RLS and privilege change; R-097 24-hour notice)

Forward: `supabase/migrations_drafts/gh3320_fee_acceptances_append_only.sql`. Rollback: `supabase/migrations_rollbacks/gh3320_fee_acceptances_append_only_rollback.sql`.
Proof: `supabase/tests/gh3320_fee_acceptances_append_only_proof.sql` (runner `..._run.sh`, schema `gh3320_throwaway_schema.sql`; throwaway Postgres only). The author made no production read; every figure on the issue is the filer's (CEO RUN 143, 2026-11-02) until the applier re-reads it below.

## What the change does
Drops the policy "Admin can update fee acceptances" and revokes UPDATE and DELETE on `public.fee_acceptances` from `anon` and `authenticated`. Rows, columns, INSERT/SELECT for every role, the other three policies, and `service_role`/`postgres` are untouched. A closing DO block refuses (rolling the whole migration back) if a client privilege or an UPDATE/DELETE/ALL policy survives.

## Who writes this table (repo search at main 33f7c8ae; the applier should also check anything not in the repo)
- INSERT, role `authenticated`: `contractor-bid-form.html` (the D-215 Layer 1 insert) and `react-app/app/contractor/bid/[claimId]/bid-form.tsx`. Both use INSERT then `.select('id')`; neither updates. Unaffected.
- SELECT, `service_role`: `stripe-webhook`, `get-business-lines-dashboard`. Unaffected.
- DELETE, `service_role`: `tests/e2e/seed/teardown.mjs` (clears NO ACTION FK children by `claim_id` before deleting test claims) and the one-off `sql/2026-07-13-purge-summit-ridge-543.sql` (SQL editor). Unaffected: this change does not touch `service_role` or `postgres`.
- UPDATE: nothing in the repo. The columns `invoice_url`, `rescinded_at` and `rescission_reason` are never written by any code (`rescind-bid` writes `quotes`, not this table).

## How to apply
The forward file carries its own `BEGIN ... COMMIT`, so `psql -v ON_ERROR_STOP=1 -f` (or a plain `-f`) is all-or-nothing: a failing guard leaves the policy and the grants as they were. If the applying tool wraps the file in its own transaction, the inner `BEGIN` is a warning and the outer transaction decides. Either way, read checks 1 and 2 after the apply.

## Read-only checks before the apply (all SELECTs; the runner extracts and runs this block against planted writers, see `supabase/tests/gh3320_planted_writers.sql`)
```sql
-- 1. grants (expect authenticated=arwd..., anon=arw... with UPDATE; see the issue's figures)
SELECT relrowsecurity, relforcerowsecurity, relacl FROM pg_class WHERE oid = 'public.fee_acceptances'::regclass;
SELECT r, p, has_table_privilege(r, 'public.fee_acceptances', p) FROM unnest(ARRAY['anon','authenticated','service_role']) r, unnest(ARRAY['INSERT','SELECT','UPDATE','DELETE','TRUNCATE']) p ORDER BY 1, 2;
-- 2. policies (expect 4; the one to drop is "Admin can update fee acceptances", FOR UPDATE)
SELECT policyname, cmd, roles, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'fee_acceptances' ORDER BY policyname;
-- 3. triggers (the issue says none)
SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'public.fee_acceptances'::regclass AND NOT tgisinternal;
-- 4. has anything ever updated or deleted rows? n_tup_upd / n_tup_del only count since the last stats reset, so read stats_reset beside them (NULL = never reset since the cluster's stats began; a recent value, or a restart after crash recovery, shortens the window)
SELECT s.n_tup_ins, s.n_tup_upd, s.n_tup_del, s.n_live_tup, d.stats_reset
  FROM pg_stat_user_tables s CROSS JOIN pg_stat_database d
 WHERE s.relid = 'public.fee_acceptances'::regclass AND d.datname = current_database();
-- 4b. per-role evidence (the counters do not say WHICH role updated): only if pg_stat_statements is installed; also read the API/Postgres logs for PATCH or DELETE on /rest/v1/fee_acceptances (Supabase Logs Explorer)
SELECT r.rolname, s.calls, left(s.query, 120) AS query FROM pg_stat_statements s JOIN pg_roles r ON r.oid = s.userid WHERE s.query ~* 'fee_accept' AND s.query ~* '^\s*(update|delete|truncate)' ORDER BY s.calls DESC;
-- 5. any writer elsewhere in the database. Read every hit: the name is matched alone ('fee_accept'), not a write-statement shape, so quoted names, UPDATE ONLY, extra spaces or newlines, dynamic EXECUTE format(...) and TRUNCATE all show up.
-- 5a. functions and procedures (aggregates are excluded because pg_get_functiondef raises on them; the materialized CTE makes sure it only runs on what survives the filter)
WITH f AS MATERIALIZED (
  SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prokind <> 'a' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
)
SELECT f.oid::regprocedure AS fn, p.prosecdef AS security_definer, pg_get_userbyid(p.proowner) AS owner,
       has_function_privilege('authenticated', f.oid, 'EXECUTE') AS authenticated_can_call
  FROM f JOIN pg_proc p ON p.oid = f.oid
 WHERE pg_get_functiondef(f.oid) ~* 'fee_accept';
-- 5b. views, materialized views and rules that depend on the table (an updatable view owned by postgres with UPDATE granted to a client role writes the table without any policy or grant on it)
SELECT DISTINCT c.oid::regclass AS dependent, c.relkind, pg_get_userbyid(c.relowner) AS owner, c.reloptions,
       has_table_privilege('anon', c.oid, 'UPDATE') AS anon_upd, has_table_privilege('authenticated', c.oid, 'UPDATE') AS authenticated_upd,
       has_table_privilege('authenticated', c.oid, 'DELETE') AS authenticated_del, has_table_privilege('authenticated', c.oid, 'INSERT') AS authenticated_ins
  FROM pg_depend d JOIN pg_rewrite r ON d.classid = 'pg_rewrite'::regclass AND r.oid = d.objid JOIN pg_class c ON c.oid = r.ev_class
 WHERE d.refclassid = 'pg_class'::regclass AND d.refobjid = 'public.fee_acceptances'::regclass AND c.oid <> 'public.fee_acceptances'::regclass;
SELECT schemaname, tablename, rulename, definition FROM pg_rules WHERE tablename = 'fee_acceptances';
-- 5c. scheduled jobs (skip if the cron schema is absent)
SELECT jobid, jobname FROM cron.job WHERE command ~* 'fee_accept';
-- 6. rows are unchanged by this migration; record the count and a whole-row digest (every column, so accepted_at, ip_address, user_agent and fee_pct are covered) to compare after
SELECT count(*), md5(string_agg(to_jsonb(t)::text, ',' ORDER BY t.id)) AS digest FROM public.fee_acceptances t;
```
## After the apply (read-only)
Repeat checks 1, 2 and 6 (save the before-output of 1 and 2 first: the rollback file restores the modelled state, not a different production ACL). Expect: no `UPDATE`/`DELETE` for `anon`/`authenticated`, three policies (no UPDATE), `service_role` unchanged, count and digest equal to before. Then an INSERT through a real bid submission on an `is_test` contractor still works.
Closes-on (issue #3320, as amended by the triager): a read of the table on production showing no client-role UPDATE/DELETE privilege and no UPDATE policy, pasted beside the issue's failing baseline.

## Rollback
Run the rollback file. It recreates the admin UPDATE policy verbatim and re-grants UPDATE, DELETE to `authenticated` and UPDATE to `anon` (the measured state). No row is touched either way.
