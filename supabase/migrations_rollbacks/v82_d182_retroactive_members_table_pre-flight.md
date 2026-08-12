# Pre-flight: v82_d182_retroactive_members_table

**Migration**: `v82_d182_retroactive_members_table.sql`
**Date**: 2026-05-19
**Author**: Wingman F-22 (wm-86e1f9q4a-a7c2)
**Task**: ClickUp 86e1f9q4a
**Branch test**: Forward ✅ Rollback ✅ (branch: wm-v82-members-migration-test)

---

## What This Migration Does

Creates the `members` table in Supabase public schema as a retroactive D-182 compliance filing. The table already exists in production (project `yeszghaspzwwstvsrioa`) but was never created via a migration file, violating D-182. This migration documents the table creation so the schema is fully tracked.

---

## Danger Pattern Check

| # | Pattern | Result |
|---|---------|--------|
| 1 | NOT NULL column without DEFAULT on existing table | ✅ CLEAR — This is CREATE TABLE, not ALTER TABLE |
| 2 | NOT NULL column on table > 100K rows with default | ✅ CLEAR — Row count: 0 at time of filing |
| 3 | DROP COLUMN | ✅ CLEAR — Not present in forward migration |
| 4 | Type change requiring table rewrite | ✅ CLEAR — Not present |
| 5 | Index without CONCURRENTLY on hot table | ✅ CLEAR — Table has 0 rows; no lock risk |
| 6 | RENAME TABLE or RENAME COLUMN | ✅ CLEAR — Not present |
| 7 | TRUNCATE or DELETE all rows | ✅ CLEAR — Not present in forward migration |
| 8 | CASCADE DROP | ✅ CLEAR — Not present in forward; rollback uses plain DROP TABLE |

**Rollback danger**: The rollback uses `DROP TABLE IF EXISTS members`. This is **not** pre-authorized. Requires explicit Dustin sign-off and verified backup before running.

---

## Schema Verified Against Production (2026-05-19)

All 17 columns match production exactly. RLS confirmed enabled with 2 policies:
- "Allow public registration" (INSERT, public role, `WITH CHECK (true)`)
- "Block public reads" (SELECT, public role, `USING (false)`)

5 indexes confirmed (plus pkey and unique constraint).

---

## Forward Migration Idempotency

Every statement uses IF NOT EXISTS or DO $$ BEGIN ... END $$ guards:
- `CREATE TABLE IF NOT EXISTS` — safe no-op if table exists
- Unique constraint added via DO block check on `information_schema.table_constraints`
- `ALTER TABLE ENABLE ROW LEVEL SECURITY` — idempotent (safe to call when already enabled)
- Policies added via DO block check on `pg_policies`
- `CREATE INDEX IF NOT EXISTS` — safe no-op if index exists

**Production behavior**: Every statement will be a no-op because the table and all its objects already exist.

---

## Row Count at Filing

```
SELECT COUNT(*) FROM members; → 0
```

The table is empty. No data loss risk from rollback **at this time**.

---

## D-182 Tier

**Tier 3** — SQL migration. Requires Dustin approval before deploy.

## D-221 Deploy Path

Path A: `commit_via_api.py` → GitHub PR to main → merge → GitHub Actions deploys.

---

## Deployment Notes

1. This migration is a **documentation migration** — it has no effect on production since the table already exists. Running it on production is safe and produces no schema changes.
2. The rollback is **not pre-authorized** and must never be run without explicit Dustin sign-off + data backup.
3. For new environments (fresh Supabase branches), this migration will correctly create the `members` table with all columns, constraints, RLS, and indexes.
