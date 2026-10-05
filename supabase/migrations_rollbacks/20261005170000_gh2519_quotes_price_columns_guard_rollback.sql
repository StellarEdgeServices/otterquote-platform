-- Rollback for 20261005170000_gh2519_quotes_price_columns_guard.sql (gh-2519).
-- WARNING: this RE-OPENS #2519 (a claim owner can set quotes.total_price / fee columns, and with them the
-- $10,000 commission floor). Run it only if the guard blocks a legitimate writer, and re-close the hole
-- as soon as that writer is moved to service_role or the guard is corrected.
-- The migration added only a trigger and its function; nothing else existed before it.
BEGIN;
DROP TRIGGER IF EXISTS quotes_guard_price_columns ON public.quotes;
DROP FUNCTION IF EXISTS public.quotes_guard_price_columns();
COMMIT;
