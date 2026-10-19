<!-- STATUS (gh-1438, as of 2026-10-19T19:32:54Z): NOT APPLIED -->
<!-- FILE ROLE: pre-flight of set gh2442_dunning_retry_pass_column -->
<!-- EVIDENCE: the SELECTs below are to be run read-only by the applying session; the authoring session ran SELECT 1 and 2 on production, results in the PR body -->
<!-- REPO COPY: none -->
<!-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md -->

# Pre-flight: gh2442_dunning_retry_pass_column (Tier 3B, NOT APPLIED)

```sql
-- 1. column absent before (expect 0 rows); after apply expect 1 row, timestamp with time zone, nullable
select column_name, data_type, is_nullable from information_schema.columns
 where table_schema='public' and table_name='payment_failures' and column_name='retry_handled_at';
-- 2. negative control: the sibling column from the applied gh2442 set is present (expect 1 row)
select column_name from information_schema.columns
 where table_schema='public' and table_name='payment_failures' and column_name='retry_requested_at';
-- 3. rows (expect 0 unless a contractor is in dunning); the ADD COLUMN touches no row values
select count(*) from public.payment_failures;
```
Lock: ADD COLUMN with no default is a catalog-only change on PostgreSQL 11+.
Apply order: migration, then process-dunning deploy (Tier 3B, 24-hour R-097 notice, REVIEW, LEGAL-READ and R-177 SIGNED first), then the page publish, then (Stripe test mode first) DUNNING_RETRY_PASS_TEST_MODE=true + DUNNING_RETRY_PASS_ENABLED=true.
Undo: the rollback file; unset DUNNING_RETRY_PASS_ENABLED first.
