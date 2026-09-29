# Pre-Flight: 20260929180000_gh2345_referral_rpc_age_check

**Migration**: `supabase/migrations/20260929180000_gh2345_referral_rpc_age_check.sql`
**Rollback**: `supabase/migrations_rollbacks/20260929180000_gh2345_referral_rpc_age_check_rollback.sql`
**Proof**: `supabase/tests/gh2345_referral_age_check_proof.sql` (BEGIN ... ROLLBACK only)
**Issue**: #2345 (Refs #2062, PR #2321). **Author**: worker of Marty, CTO RUN 50 (claim cto-2026-09-29T17:39:06Z).
**Tier**: 3B (recreates two live SECURITY DEFINER functions on a money/attribution path). **NOT APPLIED.** Needs Marty's R-097 notice and Dustin's approval.

## Live measurements (production `yeszghaspzwwstvsrioa`, read-only, 2026-09-29)
- Both functions had no age predicate: `advance_referral_registered(uuid)` advanced any `clicked` row; `claims_advance_referral()` advanced any `clicked`/`registered` row.
- Click time = `referrals.created_at` (NOT NULL, default now(); the row is inserted by `track_referral_click`). There is no separate click column.
- Old-click rows in prod today: 9 non-test `clicked` rows and 2 `clicked` + 1 `registered` test rows are older than 30 days.
- ACLs: `advance_referral_registered` = postgres, authenticated, service_role; `claims_advance_referral` = postgres, service_role. Both SECURITY DEFINER, `search_path=public, pg_temp`. All unchanged by this migration.

## What changes
- New internal helper `referral_attribution_window()` returns `interval '30 days'` (the one place the window lives). EXECUTE revoked from PUBLIC, anon, authenticated, service_role (SECURITY DEFINER callers run as the owner).
- Both functions add `AND created_at >= now() - referral_attribution_window()` to their UPDATE. Nothing else in either body changes (the gh-916 partner-status email block is copied verbatim).
- No-op signal: `advance_referral_registered` returns `false` (return type is fixed by the signature) and writes a `RAISE LOG` naming the reason; the trigger simply does not advance, so `v_rows_updated = 0` and no email fires.

## Danger pattern check
No table change, no data write, no DROP of anything that exists, no NOT NULL, no index, no CASCADE. Only CREATE OR REPLACE of two functions and a new helper.

## NOT covered (see PR body)
`apply_referral_commission()` (claims trigger) selects the referral by `claims.referral_id` and accrues the payout with no status or age check, so the payout path itself is not gated by this migration.
