-- Rollback: v82_d182_retroactive_members_table_rollback.sql
-- Reverts: v82_d182_retroactive_members_table.sql
-- Author: Wingman F-22 (wm-86e1f9q4a-a7c2)
-- Date: 2026-05-19
--
-- ⚠️ DATA-LOSS WARNING — READ BEFORE EXECUTING ⚠️
-- DANGER-OVERRIDE: This rollback permanently drops the `members` table and ALL
-- rows it contains. At time of filing (2026-05-19) the table had 0 rows, so
-- no data loss would result TODAY. However, if this rollback is run after any
-- members have registered, all member records will be permanently destroyed.
--
-- REQUIRED BEFORE RUNNING THIS ROLLBACK:
--   1. Explicit written confirmation from Dustin Stohler
--   2. Verified data backup (pg_dump or Supabase point-in-time snapshot)
--   3. Confirmation that table is still empty OR that losing all rows is accepted
--
-- This is NOT a pre-authorized rollback. It requires Dustin sign-off every time.
-- Do NOT run this rollback as part of an automated deployment.

BEGIN;

DROP TABLE IF EXISTS members;

COMMIT;
