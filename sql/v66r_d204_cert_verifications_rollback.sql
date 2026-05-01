-- =============================================================
-- v66r — Rollback for v66 D-204 cert verification system
-- Companion to sql/v66_d204_cert_verifications.sql (Session 465, May 1, 2026)
--
-- WARNING: This rollback drops contractor_cert_verifications and resets
-- contractors.cert_status JSONB to '{}' for any contractor whose cert claims
-- were tracked only in the audit table. Use only if v66 needs to be reversed
-- before broad adoption.
--
-- The unschedule of pg_cron job 'manufacturer-cert-scrape' is part of this
-- rollback and is also written below.
-- =============================================================

-- 0. Stop the scraper cron first to prevent any new writes during rollback.
SELECT cron.unschedule('manufacturer-cert-scrape')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'manufacturer-cert-scrape');

-- 1. Drop view.
DROP VIEW IF EXISTS public.cert_verification_quality_by_manufacturer;

-- 2. Drop sync trigger + function.
DROP TRIGGER IF EXISTS trg_ccv_sync_status ON public.contractor_cert_verifications;
DROP TRIGGER IF EXISTS trg_ccv_updated_at ON public.contractor_cert_verifications;
DROP FUNCTION IF EXISTS public.sync_contractor_cert_status();
DROP FUNCTION IF EXISTS public.touch_ccv_updated_at();

-- 3. Drop RLS policies.
DROP POLICY IF EXISTS "ccv contractor read own" ON public.contractor_cert_verifications;
DROP POLICY IF EXISTS "ccv contractor insert pending own" ON public.contractor_cert_verifications;
DROP POLICY IF EXISTS "ccv service role full" ON public.contractor_cert_verifications;

-- 4. Drop audit table (will cascade indexes).
DROP TABLE IF EXISTS public.contractor_cert_verifications;

-- 5. Reset contractor cert_status JSONB to empty for the soft-mode era.
UPDATE public.contractors SET cert_status = '{}'::jsonb WHERE cert_status IS NOT NULL;

-- 6. Drop storage policies.
DROP POLICY IF EXISTS "cert-letters contractor read own" ON storage.objects;
DROP POLICY IF EXISTS "cert-letters contractor insert own" ON storage.objects;
DROP POLICY IF EXISTS "cert-letters contractor update own" ON storage.objects;
DROP POLICY IF EXISTS "cert-letters service role full" ON storage.objects;

-- 7. Storage bucket — leave the bucket in place if it has objects;
-- otherwise drop. Manual review before purge.
-- DELETE FROM storage.buckets WHERE id = 'cert-letters' AND NOT EXISTS (
--   SELECT 1 FROM storage.objects WHERE bucket_id = 'cert-letters'
-- );

-- 8. Remove SOFT/HARD flag.
DELETE FROM public.platform_settings WHERE key = 'D204_HARD_FILTER';
