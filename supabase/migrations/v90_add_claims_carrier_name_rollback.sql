-- Rollback v90
ALTER TABLE public.claims DROP COLUMN IF EXISTS carrier_name;
