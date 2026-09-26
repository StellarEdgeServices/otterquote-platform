-- Rollback for supabase/migrations/20260920195654_gh2055_add_notifications_suppressed_and_is_synthetic.sql
-- Issue #2055.
--
-- Purely additive forward migration (two new nullable columns, no backfill,
-- no other column touched), so rollback is a plain DROP COLUMN on each.
-- No guard needed: neither column is referenced by any FK, view, RLS
-- policy, constraint, or application code as of this migration (that is
-- the tier:3a safety argument), so dropping them cannot destroy data
-- anywhere else and cannot change the meaning of any existing row's
-- `is_test` value on either table.
--
-- Post-rollback verification query (expect 0 rows):
--   select table_name, column_name from information_schema.columns
--   where table_schema='public' and table_name in ('contractors','leads')
--     and column_name in ('notifications_suppressed','is_synthetic');

BEGIN;

ALTER TABLE public.contractors
  DROP COLUMN IF EXISTS notifications_suppressed;

ALTER TABLE public.leads
  DROP COLUMN IF EXISTS is_synthetic;

COMMIT;
