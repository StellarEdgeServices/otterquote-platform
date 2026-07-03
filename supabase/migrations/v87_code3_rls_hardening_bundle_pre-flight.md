# Pre-Flight: v87_code3_rls_hardening_bundle

**Migration**: v87_code3_rls_hardening_bundle.sql
**Date**: 2026-07-03
**Author**: Claude Code (run-work CODE-3 session rw-f22-20260703T214037-c1a7)
**D-numbers**: D-182 (Tier 3), D-220/D-261 (approval tiers), D-221

## Change Summary

CODE-3 RLS/trigger hardening bundle, per qz-20260703 Dustin approvals:
1. **contractor_templates** — BEFORE UPDATE trigger freezes admin-review columns (`status`, `reviewed_by`, `reviewed_at`, `admin_notes`) against contractor self-writes (86e1xpb3h #2 HIGH). Allowed writers: no-JWT connections, service_role JWTs, `is_admin_email()`, `template_review_role='admin'` reviewers.
2. **contractors** — BEFORE UPDATE trigger freezes 16 status/approval/gate columns against self-writes (86e1wquxq #1 HIGH + #2). Allowed writers: no-JWT, service_role, `is_admin_email()`.
3. **platform_settings** — authenticated SELECT policy restricted from `USING (true)` to the approved 4-key public whitelist (86e1zh5m9; approved 2026-07-03: "whitelist genuinely-public keys, restrict rest to service-role").
4. **log_bid_accepted()** — now writes the contractor's auth `user_id` (via `contractors` join) into `activity_log.user_id` instead of `contractors.id` (86e1wpx7y #2). SECURITY DEFINER + `search_path=public, pg_temp` preserved (verified against live pg_proc).

**NOT included:** 86e1xpb3h #1 / 86e1wquxq #3 (cert_verifications wrong-column RLS) — live re-verified 2026-07-03: policies already use the correct `contractors.user_id` join (fixed in a prior reconciliation). No change needed.

**Design note:** trigger-enforced column freeze instead of column-level GRANT/REVOKE because admin React pages do direct table UPDATEs under the `authenticated` role — column REVOKEs would break admin approve/reject. Client contracts unchanged.

## Row Count Estimate (live, 2026-07-03)

| Table | Row Count | Source |
|-------|-----------|--------|
| contractors | 7 | live query |
| contractor_templates | 6 | live query |
| platform_settings | 4 | live query |
| activity_log | n/a (insert-path only) | — |

## Lock Duration Estimate

| Operation | Lock Type | Estimated Duration |
|-----------|-----------|-------------------|
| CREATE TRIGGER / CREATE OR REPLACE FUNCTION | brief ACCESS EXCLUSIVE on tiny tables | <100 ms |
| DROP/CREATE POLICY | brief | <100 ms |

## Danger Pattern Check

| Pattern | Triggered? | Override? |
|---------|-----------|-----------|
| NOT NULL without DEFAULT | No | — |
| NOT NULL on >100K rows | No | — |
| Drop column | No | — |
| Type change rewrite | No | — |
| Index without CONCURRENTLY | No (no indexes) | — |
| RENAME | No | — |
| Truncate/DELETE all | No | — |
| CASCADE DROP | No | — |

## Supabase Branch Test Results

Branch: `migration-test-v87` (flrxcwexksehwbmfqxdd, $0.01344/hr, lived ~15 min, deleted)
⚠️ **Finding:** fresh branch reported `MIGRATIONS_FAILED` — the repo's `supabase/migrations` history does NOT replay onto an empty database (pre-existing repo/live schema drift; branch DB came up with zero public tables). Test methodology therefore: seeded the branch with a prod-faithful subset of the five touched objects (definitions captured live from pg_policies/pg_proc/information_schema the same hour), then tested.

Forward: ✅ Applied successfully
Functional battery: ✅ 9/9 —
- T1 contractor JWT self-write template `status` → blocked 42501
- T2 contractor JWT benign template update → allowed
- T3 contractor JWT self-write `status`/`verified` on contractors → blocked 42501
- T4 contractor JWT benign profile update (phone) → allowed
- T5 `is_admin_email()` JWT sets contractor status → allowed
- T6 `template_review_role='admin'` reviewer approves template → allowed
- T7 `SET ROLE authenticated` + JWT: 4 whitelisted platform_settings visible, seeded secret key hidden
- T8 quote award → `activity_log.user_id` = contractor's auth user_id (not contractors.id)
- T9 direct no-JWT connection updates privileged columns → allowed (migrations/pg_cron path safe)

Rollback: ✅ Applied cleanly — guard triggers/functions removed, permissive policy restored (`qual=true`), original `log_bid_accepted` body restored (verified `NEW.contractor_id` marker).

## Deploy Notes

- **D-182 Tier**: 3 — approvals recorded 2026-07-03: `[DUSTIN-APPROVED via qz-20260703]` comments on 86e1xpb3h and 86e1zh5m9, routed to "Code migration session CODE-3"; 86e1wquxq/86e1wpx7y items dispatched to CODE-3 by Dustin same day.
- **Apply path**: Supabase MCP `apply_migration` on prod (repo has no Supabase auto-run CI workflow; matches Tier3 Reconciliation PHASE1-APPLIED precedent). Repo PR carries the canonical files.
- **Rollback pre-authorized**: run `v87_code3_rls_hardening_bundle_rollback.sql` if elevated 42501 error rate from legitimate flows within 30 min post-deploy.
- **Monitoring**: watch Sentry + Supabase logs for unexpected 42501s from contractor profile saves, onboarding, template submissions, and admin review pages for 30 minutes.
- **Residual risks (documented, accepted)**: `validation_result`/`manual_overrides` on contractor_templates remain contractor-writable (admin reviews the actual PDF; freezing `validation_result` risks breaking the validate-contract-template EF write path — revisit with 86e1xpb3h #4). Any legitimate client flow that writes a frozen contractor column would now 42501 — none found in caller inventory (frozen set is admin/cron-written).

## Danger Overrides

None.
