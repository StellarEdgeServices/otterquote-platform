-- v62b-warranty-options-rollback.sql
-- Reverts v62b-warranty-options.sql.
-- Drops the warranty_options table, the trigger function, and the policies.
-- Safe to run multiple times.

DROP TRIGGER IF EXISTS warranty_options_updated_at ON public.warranty_options;
DROP FUNCTION IF EXISTS public.warranty_options_set_updated_at();
DROP POLICY IF EXISTS "warranty_options_admin_write" ON public.warranty_options;
DROP POLICY IF EXISTS "warranty_options_public_read" ON public.warranty_options;
DROP INDEX IF EXISTS public.warranty_options_cert_required_idx;
DROP INDEX IF EXISTS public.warranty_options_manufacturer_idx;
DROP TABLE IF EXISTS public.warranty_options;
