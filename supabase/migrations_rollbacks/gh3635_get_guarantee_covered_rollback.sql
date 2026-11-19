-- Rollback for supabase/migrations_drafts/gh3635_get_guarantee_covered.sql (gh-3635). Drops only the function; no data is touched.
BEGIN;
DROP FUNCTION IF EXISTS public.get_guarantee_covered(uuid);
COMMIT;
