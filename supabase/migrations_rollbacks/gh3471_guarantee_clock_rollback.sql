-- gh-3471 ROLLBACK. Run manually only if the gh-3471 change must be reverted. Never move into supabase/migrations/ (the CLI would replay it forward).
-- DELETES the stored clock values (the two columns). No other column, row or table is touched. Safe to run twice.
-- The Edge Function may stay deployed: when the columns are absent its order insert is rejected as PGRST204 (PostgREST) or 42703 (Postgres) and it retries without them, recording the paid order and raising an alert for each order.
BEGIN;
ALTER TABLE public.hover_orders DROP CONSTRAINT IF EXISTS hover_orders_guarantee_clock_chk;
ALTER TABLE public.hover_orders DROP COLUMN IF EXISTS guarantee_deadline_at;
ALTER TABLE public.hover_orders DROP COLUMN IF EXISTS guarantee_started_at;
COMMIT;
