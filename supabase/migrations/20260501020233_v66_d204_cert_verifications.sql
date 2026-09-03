-- Migration: v66_d204_cert_verifications
-- Filed by: gh-1438 migration history backfill batch 1 (Code lane)
-- Date filed: 2026-09-02
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 1, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-05-01T02:02:33Z, recorded in
-- supabase_migrations.schema_migrations as version 20260501020233, name
-- "v66_d204_cert_verifications". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-02, gh-1438 backfill batch 1. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

-- =============================================================
-- v66 — D-204 cert verification system (soft mode launch)
-- Session 465, May 1, 2026 (chain terminus)
-- Builds on v62b (warranty_options) + v63b (cert_status JSONB + cert_verification_quality view)
-- Companion rollback: sql/v66r_d204_cert_verifications_rollback.sql
-- =============================================================

-- 1. Audit table — every scraper attempt + admin review writes a row.
CREATE TABLE IF NOT EXISTS public.contractor_cert_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id UUID NOT NULL REFERENCES public.contractors(id) ON DELETE CASCADE,
  manufacturer TEXT NOT NULL,
  cert_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('verified','pending','rejected','blocked_by_robots','scrape_failed')),
  source TEXT NOT NULL CHECK (source IN ('public_lookup','admin_upload','admin_review','manual_seed')),
  source_url TEXT,
  evidence_storage_path TEXT,
  verified_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  notes TEXT,
  reviewed_by_admin TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency: only one ACTIVE 'verified' row per (contractor, manufacturer, cert).
CREATE UNIQUE INDEX IF NOT EXISTS ix_ccv_unique_verified
  ON public.contractor_cert_verifications (contractor_id, manufacturer, cert_name)
  WHERE status = 'verified';

-- Profile-page reads
CREATE INDEX IF NOT EXISTS ix_ccv_contractor_status
  ON public.contractor_cert_verifications (contractor_id, status);

-- Admin queue reads
CREATE INDEX IF NOT EXISTS ix_ccv_status_created
  ON public.contractor_cert_verifications (status, created_at DESC);

-- updated_at maintenance
CREATE OR REPLACE FUNCTION public.touch_ccv_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ccv_updated_at ON public.contractor_cert_verifications;
CREATE TRIGGER trg_ccv_updated_at
  BEFORE UPDATE ON public.contractor_cert_verifications
  FOR EACH ROW EXECUTE FUNCTION public.touch_ccv_updated_at();

-- 2. Sync trigger: keep contractors.cert_status JSONB current from latest verified rows.
-- Shape: { "<cert_name>": { "verified_at": ts, "source_url": str, "verified_by": "scraper"|"admin" }, ... }
CREATE OR REPLACE FUNCTION public.sync_contractor_cert_status()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  rebuilt JSONB;
BEGIN
  -- Recompute cert_status JSONB from current 'verified' rows for the affected contractor.
  WITH active AS (
    SELECT cert_name,
           jsonb_build_object(
             'verified_at', verified_at,
             'source_url', source_url,
             'verified_by', CASE WHEN source = 'public_lookup' THEN 'scraper' ELSE 'admin' END,
             'manufacturer', manufacturer,
             'expires_at', expires_at
           ) AS payload
      FROM public.contractor_cert_verifications
     WHERE contractor_id = COALESCE(NEW.contractor_id, OLD.contractor_id)
       AND status = 'verified'
  )
  SELECT COALESCE(jsonb_object_agg(cert_name, payload), '{}'::jsonb)
    INTO rebuilt
    FROM active;

  UPDATE public.contractors
     SET cert_status = rebuilt
   WHERE id = COALESCE(NEW.contractor_id, OLD.contractor_id);

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_ccv_sync_status ON public.contractor_cert_verifications;
CREATE TRIGGER trg_ccv_sync_status
  AFTER INSERT OR UPDATE OR DELETE ON public.contractor_cert_verifications
  FOR EACH ROW EXECUTE FUNCTION public.sync_contractor_cert_status();

-- 3. SOFT/HARD feature flag row in platform_settings (default SOFT).
INSERT INTO public.platform_settings (key, value)
VALUES ('D204_HARD_FILTER', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 4. Per-manufacturer verification quality view.
-- Threshold rule (comment-only, evaluated by Executive Mode + manual review):
--   Recommend flipping D204_HARD_FILTER = true when >= 3 of {GAF, Owens Corning,
--   CertainTeed, Atlas} reach verification_coverage_pct >= 80.
--   Until then, SOFT mode runs (see Tier dropdown in contractor-bid-form.html).
CREATE OR REPLACE VIEW public.cert_verification_quality_by_manufacturer AS
WITH mfrs AS (
  SELECT DISTINCT manufacturer
    FROM public.warranty_options
   WHERE active = true
),
verified_contractors AS (
  SELECT manufacturer, COUNT(DISTINCT contractor_id) AS contractors_verified_count
    FROM public.contractor_cert_verifications
   WHERE status = 'verified'
   GROUP BY manufacturer
),
last_scrape AS (
  SELECT manufacturer,
         MAX(verified_at) AS last_successful_scrape_at
    FROM public.contractor_cert_verifications
   WHERE status = 'verified' AND source = 'public_lookup'
   GROUP BY manufacturer
),
bids_30d AS (
  SELECT wo.manufacturer,
         COUNT(*) AS bids_30d_count,
         COUNT(*) FILTER (
           WHERE EXISTS (
             SELECT 1 FROM public.contractor_cert_verifications ccv
              WHERE ccv.contractor_id = q.contractor_id
                AND ccv.manufacturer = wo.manufacturer
                AND ccv.status = 'verified'
           )
         ) AS bids_30d_with_verified_cert_count
    FROM public.quotes q
    JOIN public.warranty_options wo ON wo.id = q.warranty_option_id
   WHERE q.created_at >= now() - interval '30 days'
     AND q.warranty_option_id IS NOT NULL
   GROUP BY wo.manufacturer
)
SELECT m.manufacturer,
       COALESCE(vc.contractors_verified_count, 0) AS contractors_verified_count,
       COALESCE(b.bids_30d_count, 0) AS bids_30d_count,
       COALESCE(b.bids_30d_with_verified_cert_count, 0) AS bids_30d_with_verified_cert_count,
       CASE WHEN COALESCE(b.bids_30d_count, 0) = 0
            THEN NULL
            ELSE ROUND(100.0 * b.bids_30d_with_verified_cert_count / b.bids_30d_count, 1)
       END AS verification_coverage_pct,
       ls.last_successful_scrape_at,
       CASE WHEN ls.last_successful_scrape_at IS NULL
            THEN NULL
            ELSE EXTRACT(DAY FROM (now() - ls.last_successful_scrape_at))::int
       END AS days_since_last_scrape
  FROM mfrs m
  LEFT JOIN verified_contractors vc USING (manufacturer)
  LEFT JOIN last_scrape ls USING (manufacturer)
  LEFT JOIN bids_30d b USING (manufacturer);

-- 5. cert-letters storage bucket (private; admins read all, contractors read/write own folder).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'cert-letters',
  'cert-letters',
  false,
  10 * 1024 * 1024,
  ARRAY['image/jpeg','image/png','image/webp','application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- Storage policies on storage.objects scoped to bucket_id = 'cert-letters'
-- Path convention: <contractor_id>/<filename>
DO $$
BEGIN
  -- Drop pre-existing policies under our names to keep this migration idempotent.
  DROP POLICY IF EXISTS "cert-letters contractor read own" ON storage.objects;
  DROP POLICY IF EXISTS "cert-letters contractor insert own" ON storage.objects;
  DROP POLICY IF EXISTS "cert-letters contractor update own" ON storage.objects;
  DROP POLICY IF EXISTS "cert-letters service role full" ON storage.objects;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

CREATE POLICY "cert-letters contractor read own"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'cert-letters'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "cert-letters contractor insert own"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'cert-letters'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "cert-letters contractor update own"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'cert-letters'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'cert-letters'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "cert-letters service role full"
  ON storage.objects FOR ALL TO service_role
  USING (bucket_id = 'cert-letters')
  WITH CHECK (bucket_id = 'cert-letters');

-- 6. RLS on contractor_cert_verifications.
ALTER TABLE public.contractor_cert_verifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ccv contractor read own" ON public.contractor_cert_verifications;
DROP POLICY IF EXISTS "ccv contractor insert pending own" ON public.contractor_cert_verifications;
DROP POLICY IF EXISTS "ccv service role full" ON public.contractor_cert_verifications;

CREATE POLICY "ccv contractor read own"
  ON public.contractor_cert_verifications FOR SELECT TO authenticated
  USING (contractor_id = auth.uid());

-- Contractors can self-claim a cert (status='pending', source='admin_upload').
-- Admins/scraper write verified rows via service_role.
CREATE POLICY "ccv contractor insert pending own"
  ON public.contractor_cert_verifications FOR INSERT TO authenticated
  WITH CHECK (
    contractor_id = auth.uid()
    AND status = 'pending'
    AND source = 'admin_upload'
  );

CREATE POLICY "ccv service role full"
  ON public.contractor_cert_verifications FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- 7. Comment block — for the next reader / future Forge audit.
COMMENT ON TABLE public.contractor_cert_verifications IS
  'D-204 audit log of manufacturer cert verifications. Sync trigger keeps contractors.cert_status JSONB current from latest verified rows. SOFT/HARD filter behavior governed by platform_settings.D204_HARD_FILTER (see contractor-bid-form.html, Session 465).';

COMMENT ON VIEW public.cert_verification_quality_by_manufacturer IS
  'D-204 per-manufacturer verification quality. Recommend flipping D204_HARD_FILTER=true when >=3 of {GAF, Owens Corning, CertainTeed, Atlas} reach verification_coverage_pct >= 80.';
