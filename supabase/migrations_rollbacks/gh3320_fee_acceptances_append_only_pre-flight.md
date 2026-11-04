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

## Read-only checks before the apply (all SELECTs)
```sql
-- 1. grants (expect authenticated=arwd..., anon=arw... with UPDATE; see the issue's figures)
SELECT relrowsecurity, relforcerowsecurity, relacl FROM pg_class WHERE oid = 'public.fee_acceptances'::regclass;
SELECT r, p, has_table_privilege(r, 'public.fee_acceptances', p) FROM unnest(ARRAY['anon','authenticated','service_role']) r, unnest(ARRAY['INSERT','SELECT','UPDATE','DELETE','TRUNCATE']) p ORDER BY 1, 2;
-- 2. policies (expect 4; the one to drop is "Admin can update fee acceptances", FOR UPDATE)
SELECT policyname, cmd, roles, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'fee_acceptances' ORDER BY policyname;
-- 3. triggers (the issue says none)
SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'public.fee_acceptances'::regclass AND NOT tgisinternal;
-- 4. has anything ever updated or deleted rows since stats reset? (n_tup_upd / n_tup_del; a nonzero n_tup_upd needs an explanation before the policy goes)
SELECT n_tup_ins, n_tup_upd, n_tup_del, n_live_tup FROM pg_stat_user_tables WHERE relid = 'public.fee_acceptances'::regclass;
-- 5. any function, view or policy elsewhere that writes this table
SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND pg_get_functiondef(p.oid) ~* '(update|delete from)\s+(public\.)?fee_acceptances';
SELECT jobid, jobname FROM cron.job WHERE command ~* 'fee_acceptances';
-- 6. rows are unchanged by this migration; record the count and a digest to compare after
SELECT count(*), md5(string_agg(id::text || fee_text_displayed || fee_amount::text, ',' ORDER BY id)) FROM public.fee_acceptances;
```
## After the apply (read-only)
Repeat checks 1, 2 and 6. Expect: no `UPDATE`/`DELETE` for `anon`/`authenticated`, three policies (no UPDATE), `service_role` unchanged, count and digest equal to before. Then an INSERT through a real bid submission on an `is_test` contractor still works.
Closes-on (issue #3320, as amended by the triager): a read of the table on production showing no client-role UPDATE/DELETE privilege and no UPDATE policy, pasted beside the issue's failing baseline.

## Rollback
Run the rollback file. It recreates the admin UPDATE policy verbatim and re-grants UPDATE, DELETE to `authenticated` and UPDATE to `anon` (the measured state). No row is touched either way.
