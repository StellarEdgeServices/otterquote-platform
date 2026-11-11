-- gh-3471 coverage ROLLBACK. Run manually only if the covered-state column must be reverted. Never move into supabase/migrations/ (the CLI would replay it forward).
-- DELETES the stored coverage values (one column). The clock columns, their CHECK and every other column, row and table are untouched. Safe to run twice.
-- It does NOT delete a platform_settings 'guarantee_excluded_states' row (configuration, not schema; remove it separately only if asked).
-- The Edge Function may stay deployed: when the column is absent its insert is rejected as PGRST204/42703, it retries without guarantee_covered (keeping the clock) and alerts.
BEGIN;
ALTER TABLE public.hover_orders DROP CONSTRAINT IF EXISTS hover_orders_guarantee_covered_chk;
ALTER TABLE public.hover_orders DROP COLUMN IF EXISTS guarantee_covered;
COMMIT;
