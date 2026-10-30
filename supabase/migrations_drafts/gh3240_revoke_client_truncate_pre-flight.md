<!--
STATUS (gh-1438, as of 2026-10-30T16:00:00Z): NOT APPLIED
FILE ROLE: pre-flight file of set gh3240_revoke_client_truncate (the STATUS is the set's; it describes the forward migration)
EVIDENCE: drafted 2026-10-30 under #3240; production read-only queries the same day (project yeszghaspzwwstvsrioa, PostgreSQL 17.6). No database was written to produce this file.
REPO COPY: none. When applied, move to supabase/migrations_rollbacks/.
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-flight: gh3240_revoke_client_truncate

Issue #3240 (P18), follow-up (a) of Ben's R-177 SIGNED on #3225 (6524259012). Tier 3B (grant change), R-134 protective-only. Needs REVIEW + R-097 notice; CTO applies.

## What it changes
`REVOKE TRUNCATE ... FROM anon, authenticated` on the 50 public relations that grant it today, `public.referrals` included, then a guard that refuses (rolling the whole migration back) if any public relation still grants TRUNCATE to either role. Nothing else changes: other table privileges, column grants (#3217 B's referrals allow-list, the claims column list), RLS policies, `postgres` and `service_role` are untouched.

## Scope grew: 49 more relations
The issue asked to check every public table. Live, 50 of the 74 public relations grant TRUNCATE to a client role:
- 43 tables, both roles: adjuster_email_requests, adjusters, admin_dispute_queue, carrier_profiles, claims, coming_soon_waitlist, contractor_cert_verifications, contractor_certifications, contractor_licenses, contractor_payment_methods, contractor_templates, contractors, cpa_versions, cron_health, disputes, expansion_waitlist, feature_requests, fee_acceptances, funnel_abandonment_facts, home_profiles, hover_orders, hover_tokens, imported_hover_jobs, leads, material_catalog, members, messages, notifications, partner_onboarding_sends, payout_approvals, platform_fee_config, platform_settings, profiles, quotes, rate_limit_config, rate_limits, referrals, scope_records, stripe_webhook_events, support_tickets, warranty_manifest_drift, warranty_options; plus activity_log (authenticated only).
- 7 views: cert_verification_quality, cert_verification_quality_by_manufacturer, contribution_summary, org_summary, referral_network, state_summary (both roles); admin_contractor_last_logins (authenticated only). A view cannot be truncated, so for these the revoke is hygiene only.
All 50 are owned by and granted by `postgres`.

## Live state read (2026-10-30, read-only)
- Re-run before apply; the list must match the forward file:
  ```sql
  select c.relname, c.relkind, has_table_privilege('anon',c.oid,'TRUNCATE') anon, has_table_privilege('authenticated',c.oid,'TRUNCATE') authenticated
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind in ('r','p','v','m','f')
     and (has_table_privilege('anon',c.oid,'TRUNCATE') or has_table_privilege('authenticated',c.oid,'TRUNCATE'))
   order by 1;   -- 2026-10-30: 50 rows (anon true on 48)
  ```
- No function outside the system schemas issues TRUNCATE (the one `prosrc ~* 'truncate'` hit is `storage.list_objects_with_delimiter`, not a TRUNCATE statement); no `cron.job` command contains it (18 jobs). Edge functions use the service-role client, which keeps TRUNCATE. PostgREST has no TRUNCATE verb. Nothing in the repo issues TRUNCATE as a client role.
- `pg_default_acl` (postgres and supabase_admin, schema public) still grants `arwdDxtm` to anon and authenticated on tables created later, so a NEW table will hold TRUNCATE again. Out of scope here (changing default privileges affects every future migration); flagged in the PR for a decision. The proof records it as an INFO line.

## Apply
Single transaction as `postgres`. If the guard refuses, a public relation not in the list grants TRUNCATE: re-run the query above, add it to the forward and both rollback lists, re-run the proof.

## Verify (closes-on)
```sql
select has_table_privilege('anon','public.referrals','TRUNCATE'), has_table_privilege('authenticated','public.referrals','TRUNCATE');
-- before: true,true   after: false,false
```
and the sweep query above returns 0 rows.

## Proof
`PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh3240_revoke_client_truncate_proof_run.sh --mutations` on a throwaway Postgres (run on 16.15): BEFORE fails C1-C6 (negative control), AFTER / RERUN / REAPPLIED pass 10/10, ROLLBACK restores the catalog byte-for-byte, the guard refuses a late table atomically, 6/6 mutants killed. The scratch setup mirrors the 74 live relacl values; MAINTAIN (`m`, PG17-only) is omitted on 16.

## Rollback
`gh3240_revoke_client_truncate_rollback.sql` grants TRUNCATE back to anon on the 48 and authenticated on the 50 relations that held it; relacl returns to the exact pre-apply text. It re-opens client TRUNCATE; use only if a reader breaks.
