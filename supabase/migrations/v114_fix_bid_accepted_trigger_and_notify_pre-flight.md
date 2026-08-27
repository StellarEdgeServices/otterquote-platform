# Pre-Flight: v114_fix_bid_accepted_trigger_and_notify

**Migration**: v114_fix_bid_accepted_trigger_and_notify.sql
**Date**: 2026-08-26
**Author**: Claude Code (migration-author-code v1.1)
**D-numbers**: D-182 (Tier 3), D-221 (Path A), D-261 (ALTER-class change)
**Issue**: gh-1293 (P0 — bid acceptance has no working state transition)

## Change Summary

`log_bid_accepted()` fires `AFTER UPDATE ON quotes` and only logs/notifies
when `NEW.status = 'awarded'`. `quotes_status_check` has never permitted
`'awarded'` (`draft|submitted|selected|declined|expired` only), and every
accept-bid code path (`bids.html:2143`, `contractor-about.html:992`) writes
`'selected'` to `quotes.status` — never `'awarded'`. The trigger's condition
was therefore always false. Measured against production: `activity_log` has
665 `bid_submitted` rows and **zero** `bid_accepted` rows, ever.

This migration changes the trigger to fire on `'selected'` (the value the
app actually writes) instead of widening the constraint to add `'awarded'`
— no `ALTER TABLE` / no front-end write-path change needed. It also adds a
contractor `notifications` row, which never existed for this event anywhere
in the codebase (gh-1293 acceptance criteria 2/3/5), and tightens this
function's EXECUTE grant (danger pattern 9).

`claims.selected_contractor_id` / `claims.status = 'awarded'` already write
correctly today — `claims` has no status CHECK constraint at all (confirmed
via `pg_constraint`) — so this migration does not touch `claims` writes.

## Row Count Estimate

| Table | Row Count | Source |
|-------|-----------|--------|
| quotes | 5 | `SELECT COUNT(*) FROM quotes` on `yeszghaspzwwstvsrioa` |

Trivially small; this is a function/grant change only, not a data migration.

## Lock Duration Estimate

| Operation | Lock Type | Estimated Duration |
|-----------|-----------|---------------------|
| `CREATE OR REPLACE FUNCTION` | none on `quotes` rows | instant |
| `REVOKE`/`GRANT` on function | catalog lock only | instant |

No `ALTER TABLE`, no index operation, no table lock of any kind.

## Danger Pattern Check

| # | Pattern | Triggered? | Notes |
|---|---------|-----------|-------|
| 1 | NOT NULL, no DEFAULT | No | — |
| 2 | NOT NULL on >100K rows | No | — |
| 3 | Drop column | No | — |
| 4 | Type change rewrite | No | — |
| 5 | Index without CONCURRENTLY | No | — |
| 6 | RENAME | No | — |
| 7 | TRUNCATE/DELETE all | No | — |
| 8 | CASCADE DROP | No | Rollback drops trigger then function explicitly, in dependency order — no CASCADE used |
| 9 | New/replaced function EXECUTE grants | **Yes** | Pre-existing `proacl` showed `PUBLIC`, `anon`, `authenticated`, `service_role`, `postgres` all had EXECUTE on this trigger-only function. Forward migration explicitly `REVOKE`s from `PUBLIC`/`anon`/`authenticated` (leaves `service_role`/owner untouched). Verified via `has_function_privilege` probes before and after, on the branch (below), that revoking does not stop the trigger from firing — Postgres invokes trigger functions via the executor, not via a normal privileged CALL. |

## Supabase Branch Test Results

Branch: `migration-test-v114` (project_ref `zvsycasqpnrkmraoyehw`, deleted after test)
Cost: $0.01344/hour, confirmed with Dustin before creation.

**Note:** branch replay is missing at least one column present in production
(`activity_log.is_test` — added via a hand-applied `sql/` file, per the
skill's own documented `sql/` vs `supabase/migrations/` split; ~226 files in
`sql/` never ran through CLI tracking). Added `is_test` to the branch's
`activity_log` manually before testing so the test matched production's
actual live shape. This is a branch-replay gap unrelated to this migration
and worth flagging separately (not fixed here — out of scope).

Test data: one `auth.users`/`claims`/`contractors`/`quotes` row (`is_auto_bid
= true` to bypass the unrelated D-199 bid-template gate, which is orthogonal
to this fix).

| Step | Result |
|------|--------|
| Forward applied | ✅ |
| `UPDATE quotes SET status = 'selected'` fires trigger | ✅ — one `bid_accepted` row in `activity_log` (`is_test: true` propagated correctly) |
| Contractor `notifications` row created | ✅ — `notification_type: 'bid_accepted'`, correct `user_id` (contractor's), correct message |
| `has_function_privilege('anon', ..., 'EXECUTE')` after forward | `false` (was `true`) |
| `has_function_privilege('authenticated', ..., 'EXECUTE')` after forward | `false` (was `true`) |
| `has_function_privilege('service_role', ..., 'EXECUTE')` after forward | `true` (unchanged, as intended) |
| Rollback applied | ✅ |
| Function body restored to exact original (`pg_get_functiondef` matches pre-migration capture) | ✅ |
| Grants restored (`anon`/`authenticated` EXECUTE) | ✅ — both `true` again |
| Re-firing `UPDATE quotes SET status = 'selected'` after rollback creates NO new `bid_accepted` row | ✅ — count stayed at 1 (the one row from the forward-migration test), confirming rollback truly reverts to the original (always-false) condition |
| Branch deleted | ✅ |

## Deploy Notes

- **D-182 Tier**: 3 (SQL migration — requires Dustin approval)
- **D-221 Deploy Path**: GitHub PR → merge → Supabase migration auto-run
- **Rollback pre-authorized**: Yes — run `v114_..._rollback.sql` if error rate spikes within 5 minutes post-deploy
- **Monitoring**: watch for `bid_accepted` activity_log/notifications rows actually appearing on the next real bid acceptance; watch for any error surfaced from the trigger on the `quotes` UPDATE path

## Related, Not Fixed Here

- `create-docusign-envelope/index.ts` (main branch, pre-BoldSign-cutover code, gh-1244): two `defaultReturnUrl` values redirect back into `contract-signing.html` without `role=`. The `handleHomeownerSign` one (line ~1447) is fixed in the same PR as this migration (adds `role=homeowner`), since it is the exact code path this session's live browser reproduction hit. The `handleLegacyFlow` one (`document_type === "contract"`, ~line 1604) was NOT changed — its `signer` role is ambiguous from the code alone (both parties could be the caller) and it may be dead code (the current UI/EF path goes through `handleHomeownerSign`/`handleContractorSign`, not `handleLegacyFlow`). Flagging rather than guessing.
- Branch-replay gap: Supabase branches created from this project are missing at least one production column (`activity_log.is_test`) because it was applied via a hand-run `sql/` script, not a CLI-tracked migration. Worth a follow-up to understand the full drift, not attempted here.

## Danger Overrides

None.
