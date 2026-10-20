<!-- STATUS (gh-1438, as of 2026-10-19T20:58:00Z): NOT APPLIED -->
<!-- FILE ROLE: pre-flight of set gh2442_dunning_retry_pass_lease -->
<!-- EVIDENCE: the SELECTs below are to be run read-only by the applying session -->
<!-- REPO COPY: none -->
<!-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md -->

# Pre-flight: gh2442_dunning_retry_pass_lease (Tier 3B, NOT APPLIED)

```sql
-- 1. table absent before (expect 0 rows); after apply expect 1 row
select table_name from information_schema.tables where table_schema='public' and table_name='dunning_retry_pass_lease';
-- 2. after apply: RLS on, one seed row, no grant to anon / authenticated, service_role holds SELECT, UPDATE
select relrowsecurity from pg_class where oid='public.dunning_retry_pass_lease'::regclass;
select id, holder, locked_until from public.dunning_retry_pass_lease;
select grantee, privilege_type from information_schema.role_table_grants where table_schema='public' and table_name='dunning_retry_pass_lease' order by 1,2;
```
Apply order: column migration, RPC guard migration, THIS migration, then the process-dunning deploy (pass still off).
Undo: the rollback file (unset DUNNING_RETRY_PASS_ENABLED first).
