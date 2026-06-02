# Pre-Flight: v84_rls_policy_consolidation

**Migration**: v84_rls_policy_consolidation.sql  
**Date**: 2026-06-01 (applied) / 2026-06-02 (reconciled into repo)  
**Author**: Dustin Stohler (direct apply) — reconciled by migration-author skill (Cowork)  
**D-numbers**: D-182 (Tier 3), D-221 (Path A)  
**ClickUp reconciliation task**: 86e1nz4uj  

## Change Summary

Consolidates RLS policies across 22 public tables. Addresses two classes of Supabase advisor warnings: (1) `auth_rls_initplan` — policies calling `auth.uid()` directly caused per-row function re-evaluation; fixed by wrapping in `(select auth.uid())` for improved query plan caching. (2) `multiple_permissive_policies` — 5 duplicate/redundant policies dropped: "Users can view own notifications" (dup of notifications_user_read), "Contractors can update own record" (dup of "Contractors can update own profile"), "Contractors can view own record", "admin_select_contractors", "Contractors can insert own quotes" (dup of "Contractors can insert quotes").

Applied directly to production on 2026-06-01 (version `20260601170449`). Reconciled into repo 2026-06-02 per ClickUp 86e1nz4uj to close the D-182 audit trail gap.

## Tables Affected (22)

activity_log, adjuster_email_requests, claims, contractor_cert_verifications, contractor_certifications, contractor_licenses, contractor_payment_methods, contractor_templates, contractors, expansion_waitlist, fee_acceptances, home_profiles, hover_orders, messages, notifications, payment_failures, payout_approvals, profiles, quotes, referral_agents, referrals, warranty_manifest_drift

## Row Count Estimates (at time of apply, 2026-06-01 — pre-revenue)

All tables: <50 rows. Lock risk negligible.

## Lock Duration Estimate

| Operation | Lock Type | Estimated Duration |
|-----------|-----------|-------------------|
| DROP POLICY (per policy) | ACCESS SHARE (brief) | <1ms at pre-revenue scale |
| CREATE POLICY (per policy) | ACCESS SHARE (brief) | <1ms at pre-revenue scale |

No table rewrites, no index changes, no data modifications. Total duration at apply: <500ms.

## Danger Pattern Check

| # | Pattern | Triggered? | Override? |
|---|---------|-----------|-----------|
| 1 | NOT NULL without DEFAULT | ❌ No | — |
| 2 | NOT NULL on table >100K rows | ❌ No | — |
| 3 | DROP COLUMN | ❌ No (DROP POLICY only) | — |
| 4 | Type change / table rewrite | ❌ No | — |
| 5 | CREATE INDEX without CONCURRENTLY | ❌ No | — |
| 6 | RENAME TABLE or RENAME COLUMN | ❌ No | — |
| 7 | TRUNCATE or DELETE all rows | ❌ No | — |
| 8 | CASCADE DROP | ❌ No | — |

**All 8 patterns: CLEAR.**

## Supabase Branch Test Results

**Branch**: migration-test-v84-rls-reconcile (ref: iufapbpmjnvrdqixmxnk) — created and deleted 2026-06-02  
**Method**: Branch created as no-data clone; 22 stub tables + RLS + required functions created; forward + rollback applied and verified.

**Forward apply**: ✅ All policies created with `( SELECT auth.uid() AS uid)` pattern  
**Verification query (sample)**:
```sql
SELECT policyname, qual FROM pg_policies
WHERE tablename = 'claims' AND policyname = 'Users can view own claims';
-- Result: qual = "(user_id = ( SELECT auth.uid() AS uid))" ✅
```

**Rollback apply**: ✅ Applied cleanly  
**Rollback verification**:
```sql
-- claims: qual = "(user_id = auth.uid())"           ✅ direct auth.uid() restored
-- profiles: qual = "(id = auth.uid())"              ✅ direct auth.uid() restored
-- notifications_user_read: qual uses auth.uid()     ✅
-- "Users can view own notifications": present       ✅ Phase 1A policy restored
-- "Contractors can view own record": present        ✅ Phase 1A policy restored
-- "admin_select_contractors": present               ✅ Phase 1A policy restored
-- "Contractors can insert own quotes": present      ✅ Phase 1A policy restored
```

**Branch deleted**: ✅

## Deploy Notes

- **D-182 Tier**: 3 (SQL migration — Dustin approved and applied directly 2026-06-01)
- **D-221 Deploy Path**: Retroactive — migration already in production. Files committed via GitHub PR for audit trail only. Do NOT re-apply to production.
- **Rollback pre-authorized**: Yes — run v84_rls_policy_consolidation_rollback.sql if revert needed
- **Monitoring**: Policy-only change, no data affected. No Sentry monitoring required.
- **Idempotency**: Fully idempotent (DROP IF EXISTS + CREATE). Safe to re-run if ever needed.

## Compliance Note

Migration was applied directly to production on 2026-06-01 without a repo file — D-182 compliance gap. Reconciled 2026-06-02 per ClickUp 86e1nz4uj. Forward + rollback committed to repo to restore audit trail.

## Danger Overrides

None.
