-- gh-3471 ROLLBACK. Run manually only if the gh-3471 change must be reverted. Never move into supabase/migrations/ (the CLI would replay it forward).
-- DELETES the stored clock values (the two columns). No other column, row or table is touched. Safe to run twice.
-- Roll the Edge Function back FIRST (or leave it: it retries the order insert without the clock columns on error 42703 and raises an alert for each order).
BEGIN;
ALTER TABLE public.hover_orders DROP CONSTRAINT IF EXISTS hover_orders_guarantee_clock_chk;
ALTER TABLE public.hover_orders DROP COLUMN IF EXISTS guarantee_deadline_at;
ALTER TABLE public.hover_orders DROP COLUMN IF EXISTS guarantee_started_at;
COMMIT;
