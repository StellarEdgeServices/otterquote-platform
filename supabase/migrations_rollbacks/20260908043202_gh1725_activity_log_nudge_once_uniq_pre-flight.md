# Pre-Flight: 20260908043202_gh1725_activity_log_nudge_once_uniq

**Migration**: `20260908043202_gh1725_activity_log_nudge_once_uniq.sql`
**Rollback**: `20260908043202_gh1725_activity_log_nudge_once_uniq_rollback.sql`
**Date**: 2026-09-08 (all timestamps from `In Flight/bin/stamp.py`: `2026-09-08T04:32:02Z`)
**Author**: Claude Code (Code lane, CEO RUN 35 dispatch, claim `ceo-2026-09-07T20:08:08Z`)
**D-numbers**: D-182 / D-261 — **tier:3b**, label `tier:3b-approved` present on #1725 from creation
**Issue**: gh-1725 (decomposed out of gh-1580)

## ⚠ NOT APPLIED

**This migration has not been run.** Not against production (`yeszghaspzwwstvsrioa`),
not against a branch, not anywhere. It is filed as a reviewable artifact only. Applying
it is a separate, explicitly-authorised step.

## Change Summary

One statement: a unique partial index on `activity_log` that makes the homeowner-nudge
mailer's existing duplicate-send guard reachable.

```sql
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS activity_log_nudge_once_uniq
  ON activity_log (user_id, event_type, (metadata->>'claim_id'), (metadata->>'nudge_stage'))
  WHERE metadata->>'nudge_stage' IS NOT NULL
    AND event_type = 'next_steps_nudge_sent';
```

No column added, no data changed, no constraint on existing rows beyond uniqueness
within the predicate, no trigger, no default, no backfill.

## The one-word data-mapping call, and why

The CTO ruling (#1580 comment `5532497935`) wrote the predicate against
`metadata->>'stage'`. The merged function writes `nudge_stage`:

```
supabase/functions/send-homeowner-next-steps/index.ts:521
    metadata: { claim_id: claim.id, nudge_stage: stage, system_generated: true },
```

and documents the same shape in its own header docblock (lines 54–55). `git grep`
for a `'stage'` key in that function returns nothing.

**DECIDED: `nudge_stage`.**
**REJECTED ALTERNATIVE: the ruling's literal `stage`** — an index on
`metadata->>'stage'` with `WHERE metadata->>'stage' IS NOT NULL` matches zero rows
forever. It creates without error and never fires: the guard would look built, the
migration would look applied, and the double-send defect would be silently
reintroduced behind a green checkmark. That is strictly worse than today, where the
guard is at least visibly dead.

## R-147 pre-flight measurements (production, read-only, `2026-09-08T04:27:32Z`)

| Check | Query | Result |
|---|---|---|
| Index absent (negative control) | `select indexname from pg_indexes where tablename='activity_log'` | `activity_log_pkey`, `idx_activity_log_created_at`, `idx_activity_log_user_created`, `idx_activity_log_user_id` — **no `activity_log_nudge_once_uniq`** |
| Rows in scope | `select count(*) from activity_log where event_type='next_steps_nudge_sent'` | **0** |
| Pre-existing violations | `group by (user_id, event_type, claim_id, nudge_stage) having count(*)>1` | **0 rows** |
| Table size | `select count(*) from activity_log` | 1050 |

**No pre-existing duplicate can fail the CREATE.** The index is created over an empty
predicate set.

## Locking

`CREATE INDEX CONCURRENTLY` is used deliberately: a plain `CREATE UNIQUE INDEX` takes
an `ACCESS EXCLUSIVE`-blocking write lock on `activity_log`, which is on the money-path
write set. `CONCURRENTLY` cannot run inside a transaction block, so this file carries no
`BEGIN`/`COMMIT` and is the only statement in the file — matching the established
precedent at `20260903184350_gh1544_contractors_email_lower_uniq.sql`.

The runner must therefore execute this file **outside** a transaction. If it wraps
migrations in one, this file will fail with `25001`.

## Blast radius

`select status, is_test, count(*) from claims group by 1,2` returns **no rows with
`status='documents_needed' AND is_test=false`** — the nudge candidate set is empty, so
no real homeowner can be double-emailed today. The exposure opens with the first real
signup. Applying this before that event is the whole point of the sequencing.

## Post-apply verification owed (the issue's `closes-on`)

1. Re-read `pg_indexes` / `pg_index` for `activity_log_nudge_once_uniq`, pasted beside
   the empty pre-apply result above as the negative control.
2. Confirm `indisvalid = true` (CONCURRENTLY can leave an INVALID index).
3. Prove the guard fires: two inserts of the same `(user_id, event_type, claim_id,
   nudge_stage)` in one transaction, the second raising `23505`, then `ROLLBACK`.

None of the three has been run, because the migration has not been applied.
