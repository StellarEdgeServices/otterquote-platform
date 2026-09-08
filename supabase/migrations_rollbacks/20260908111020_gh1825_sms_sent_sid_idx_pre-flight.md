# Pre-Flight: 20260908111020_gh1825_sms_sent_sid_idx

**Migration**: `20260908111020_gh1825_sms_sent_sid_idx.sql`
**Rollback**: `20260908111020_gh1825_sms_sent_sid_idx_rollback.sql`
**Date**: 2026-09-08T11:10:20Z (`In Flight/bin/stamp.py`)
**Author**: Claude Code (Code lane, `rw-f22-20260908T103400-ifdl`, worker `w9-sms`)
**Tier**: 3a (CTO ruling, #1825 comment 5583955467 — observability, no send-behaviour change)
**Issue**: gh-1825 (code half; vendor/compliance half stays on #1843)

## NOT APPLIED

**This migration has not been run.** Not against production (`yeszghaspzwwstvsrioa`),
not against a branch, not anywhere. It is filed as a reviewable artifact only.

## Change Summary

One statement: a partial index on `activity_log ((metadata->>'sid')) WHERE event_type =
'sms_sent'`. No column added, no data changed, no constraint, no trigger, no default,
no backfill.

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS activity_log_sms_sent_sid_idx
  ON activity_log ((metadata->>'sid'))
  WHERE event_type = 'sms_sent';
```

## Why this migration exists, and why it is not required for the alarm to work

gh-1825's code half asks for the final-delivery-status alarm to "still function [before
any migration lands] (e.g. compute from Twilio directly)". This PR's alarm
(`platform-health-check`'s Phase 4, `sms-delivery-check.ts`) does exactly that: it reads
Twilio's `Messages.json` list directly on every cron tick and never touches
`activity_log`. **This migration is not on that path at all.**

Separately, this PR adds a `send-sms` write of one `activity_log` row per successful
send (`event_type: 'sms_sent'`, `metadata: {sid, to_last4, status}`), so there is a
durable trail of what we sent. `activity_log.metadata` is already `jsonb` — a future
phase that wants to patch a polled final `status`/`error_code` back onto the row for a
given SID needs **no new column**, only a `WHERE metadata->>'sid' = $1` lookup. This
migration is the index that makes that lookup cheap once written, nothing more.

## Pre-flight measurements (production, read-only, `2026-09-08T11:10:20Z`)

| Check | Query | Result |
|---|---|---|
| Index absent (negative control) | `select indexname from pg_indexes where tablename='activity_log'` | `activity_log_pkey`, `idx_activity_log_user_id`, `idx_activity_log_created_at`, `idx_activity_log_user_created` — **no `activity_log_sms_sent_sid_idx`** |
| Rows in scope | `select count(*) from activity_log where event_type='sms_sent'` | **0** (send-sms does not log yet on `main` — this PR adds that write) |
| Table size | `select count(*) from activity_log` | 1051 |

No pre-existing row can violate anything — the index has no uniqueness constraint and
matches zero rows today regardless.

## Locking

`CREATE INDEX CONCURRENTLY` is used deliberately: `activity_log` is written from many
Edge Functions on hot paths (notifications, DocuSign webhook, payouts). A plain `CREATE
INDEX` takes a blocking `SHARE` lock against writes for the build's duration;
`CONCURRENTLY` avoids that at the cost of two table scans instead of one. It cannot run
inside a transaction block, so this file carries no `BEGIN`/`COMMIT` and is the only
statement in the file — same precedent as
`20260908043202_gh1725_activity_log_nudge_once_uniq.sql`.

## Blast radius

None today: zero rows match the predicate. Exposure is bounded by `send-sms` call
volume once its logging write ships (rate-limited to 20/day, 100/month per D-063 —
`SPENDING-CONTROLS.md`), and the write itself is a plain jsonb insert with no schema
dependency on this index existing.

## Post-apply verification owed (not run — migration not applied)

1. Re-read `pg_indexes` for `activity_log_sms_sent_sid_idx`, pasted beside the empty
   pre-apply result above as the negative control.
2. Confirm `indisvalid = true` (`CONCURRENTLY` can leave an `INVALID` index on failure).
3. `explain` a `select * from activity_log where event_type='sms_sent' and
   metadata->>'sid' = '<a real SID>'` and confirm an Index Scan, not a Seq Scan.
