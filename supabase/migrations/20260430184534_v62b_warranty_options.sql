-- Migration: v62b_warranty_options
-- Filed by: gh-1438 migration history backfill batch 1 (Code lane)
-- Date filed: 2026-09-02
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 1, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-04-30T18:45:34Z, recorded in
-- supabase_migrations.schema_migrations as version 20260430184534, name
-- "v62b_warranty_options". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-02, gh-1438 backfill batch 1. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

CREATE TABLE IF NOT EXISTS public.warranty_options (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  manufacturer    TEXT         NOT NULL,
  tier            TEXT         NOT NULL,
  material_years  TEXT,
  labor_years     INTEGER,
  labor_note      TEXT,
  tearoff_years   INTEGER,
  wind_mph        INTEGER,
  wind_note       TEXT,
  hail_class      TEXT,
  cert_required   TEXT,
  cert_lookup_url TEXT,
  display_string  TEXT         NOT NULL,
  active          BOOLEAN      NOT NULL DEFAULT TRUE,
  source_url      TEXT,
  last_verified   DATE,
  next_review     DATE,
  notes           TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (manufacturer, tier)
);

CREATE INDEX IF NOT EXISTS warranty_options_manufacturer_idx
  ON public.warranty_options (manufacturer)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS warranty_options_cert_required_idx
  ON public.warranty_options (cert_required)
  WHERE active = TRUE AND cert_required IS NOT NULL;

ALTER TABLE public.warranty_options ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "warranty_options_public_read" ON public.warranty_options;
CREATE POLICY "warranty_options_public_read"
  ON public.warranty_options
  FOR SELECT
  TO anon, authenticated
  USING (active = TRUE);

DROP POLICY IF EXISTS "warranty_options_admin_write" ON public.warranty_options;
CREATE POLICY "warranty_options_admin_write"
  ON public.warranty_options
  FOR ALL
  TO authenticated
  USING (auth.jwt() ->> 'email' = 'dustinstohler1@gmail.com')
  WITH CHECK (auth.jwt() ->> 'email' = 'dustinstohler1@gmail.com');

CREATE OR REPLACE FUNCTION public.warranty_options_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS warranty_options_updated_at ON public.warranty_options;
CREATE TRIGGER warranty_options_updated_at
  BEFORE UPDATE ON public.warranty_options
  FOR EACH ROW EXECUTE FUNCTION public.warranty_options_set_updated_at();
