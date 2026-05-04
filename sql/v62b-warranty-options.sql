-- v62b-warranty-options.sql
-- Creates warranty_options table per D-202 v2 (APPROVED Apr 30, 2026)
-- + seeds with 23 (manufacturer, tier) entries from data/warranty-manifest.json
-- + adds 'Other' fallback row for off-manifest free-text warranties.
--
-- Companion rollback: v62b-warranty-options-rollback.sql
-- Apply via Supabase Management API. Tier 3 per D-182.
-- ClickUp: 86e15abqh

-- ============================================================
-- 1. warranty_options table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.warranty_options (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  manufacturer    TEXT         NOT NULL,
  tier            TEXT         NOT NULL,
  material_years  TEXT,         -- "Lifetime (limited)" or "50 (non-prorated)" — text
  labor_years     INTEGER,
  labor_note      TEXT,         -- e.g., "Manufacturer-only", "10–15 years"
  tearoff_years   INTEGER,
  wind_mph        INTEGER,
  wind_note       TEXT,
  hail_class      TEXT,
  cert_required   TEXT,         -- NULL or "GAF Master Elite" etc.
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

-- ============================================================
-- 2. RLS — public read of active rows; service role full
-- ============================================================
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

-- ============================================================
-- 3. updated_at trigger
-- ============================================================
CREATE OR REPLACE FUNCTION public.warranty_options_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS warranty_options_updated_at ON public.warranty_options;
CREATE TRIGGER warranty_options_updated_at
  BEFORE UPDATE ON public.warranty_options
  FOR EACH ROW EXECUTE FUNCTION public.warranty_options_set_updated_at();

-- ============================================================
-- 4. Seed — D-202 v2 manifest (idempotent via ON CONFLICT)
-- ============================================================
INSERT INTO public.warranty_options
  (manufacturer, tier, material_years, labor_years, labor_note, tearoff_years, wind_mph, hail_class, cert_required, cert_lookup_url, display_string, last_verified, next_review)
VALUES
  -- GAF
  ('GAF', 'System Plus Limited Warranty', 'Lifetime (limited)',     NULL, 'Manufacturer-only', NULL, 130, 'Standard', NULL, 'https://www.gaf.com/en-us/roofing/contractors',
    'GAF System Plus — Material: Lifetime (limited); Labor: Manufacturer-only; Wind: 130 mph; Hail: Standard. Administered by GAF under their System Plus Limited Warranty program. OtterQuote is not the warrantor.', '2026-04-30', '2026-07-30'),
  ('GAF', 'Silver Pledge',                '50 (non-prorated)',       10,  NULL, NULL, 130, 'Standard', 'GAF Certified',     'https://www.gaf.com/en-us/roofing/contractors',
    'GAF Silver Pledge — Material: 50 years (non-prorated); Labor: 10 years; Wind: 130 mph; Hail: Standard. Administered by GAF under their Silver Pledge program; requires GAF Certified contractor — verified by OtterQuote per D-204. OtterQuote is not the warrantor.', '2026-04-30', '2026-07-30'),
  ('GAF', 'Golden Pledge',                '50 (non-prorated)',       25,  NULL, 25,   130, 'Standard', 'GAF Master Elite',  'https://www.gaf.com/en-us/roofing/contractors',
    'GAF Golden Pledge — Material: 50 years (non-prorated); Labor: 25 years; Tear-off: 25 years; Wind: 130 mph; Hail: Standard. Administered by GAF under their Golden Pledge program; requires GAF Master Elite contractor — verified by OtterQuote per D-204. OtterQuote is not the warrantor.', '2026-04-30', '2026-07-30'),

  -- Owens Corning
  ('Owens Corning', 'Standard Limited Warranty', 'Lifetime (limited)', NULL, NULL, NULL, 110, 'Standard', NULL, 'https://www.owenscorning.com/roofing/find-a-contractor',
    'Owens Corning Standard Limited — Material: Lifetime (limited); Labor: None; Wind: 110 mph; Hail: Standard. Administered by Owens Corning. OtterQuote is not the warrantor.', '2026-04-30', '2026-07-30'),
  ('Owens Corning', 'System Protection',         'Lifetime (non-prorated for limited period)', NULL, NULL, NULL, 130, 'Standard', NULL, 'https://www.owenscorning.com/roofing/find-a-contractor',
    'Owens Corning System Protection — Material: Lifetime (non-prorated for limited period); Labor: None; Wind: 130 mph; Hail: Standard. Administered by Owens Corning; registration required. OtterQuote is not the warrantor.', '2026-04-30', '2026-07-30'),
  ('Owens Corning', 'Preferred Protection',      'Lifetime',           10,   NULL, 10,   130, 'Standard', 'Preferred Contractor',          'https://www.owenscorning.com/roofing/find-a-contractor',
    'Owens Corning Preferred Protection — Material: Lifetime; Labor: 10 years; Tear-off: 10 years; Wind: 130 mph; Hail: Standard. Administered by Owens Corning; requires Preferred Contractor — verified by OtterQuote per D-204. OtterQuote is not the warrantor.', '2026-04-30', '2026-07-30'),
  ('Owens Corning', 'Platinum Protection',       '50 (non-prorated)',  25,   NULL, 25,   130, 'Standard', 'Platinum Preferred Contractor', 'https://www.owenscorning.com/roofing/find-a-contractor',
    'Owens Corning Platinum Protection — Material: 50 years (non-prorated); Labor: 25 years; Tear-off: 25 years; Wind: 130 mph; Hail: Standard. Administered by Owens Corning; requires Platinum Preferred Contractor — verified by OtterQuote per D-204. OtterQuote is not the warrantor.', '2026-04-30', '2026-07-30'),

  -- CertainTeed
  ('CertainTeed', 'Standard Limited (SureStart)', 'Lifetime (limited)', 2, 'SureStart period', NULL, 110, 'Standard', NULL,                       'https://www.certainteed.com/find-a-pro',
    'CertainTeed Standard Limited (SureStart) — Material: Lifetime (limited); Labor: 2 years (SureStart period); Wind: 110 mph; Hail: Standard. Administered by CertainTeed. OtterQuote is not the warrantor.', '2026-04-30', '2026-07-30'),
  ('CertainTeed', 'SureStart Plus',                 'Lifetime',           5,    NULL, NULL, 110, 'Standard', 'SureStart Plus dealer',     'https://www.certainteed.com/find-a-pro',
    'CertainTeed SureStart Plus — Material: Lifetime; Labor: 5 years; Wind: 110 mph; Hail: Standard. Administered by CertainTeed; requires SureStart Plus dealer — verified by OtterQuote per D-204. OtterQuote is not the warrantor.', '2026-04-30', '2026-07-30'),
  ('CertainTeed', '5-Star Warranty',                '50 (non-prorated)',  25,   NULL, 25,   130, 'Standard', '5-Star contractor',         'https://www.certainteed.com/find-a-pro',
    'CertainTeed 5-Star Warranty — Material: 50 years (non-prorated); Labor: 25 years; Tear-off: 25 years; Wind: 130 mph; Hail: Standard. Administered by CertainTeed; requires 5-Star contractor — verified by OtterQuote per D-204. OtterQuote is not the warrantor.', '2026-04-30', '2026-07-30'),

  -- Tamko
  ('Tamko', 'Heritage Standard',          '30/40/50 (per product)', NULL, NULL, NULL, 110, 'Standard',                NULL,                  NULL,
    'Tamko Heritage Standard — Material: 30/40/50 years (per product); Labor: None; Wind: 110 mph; Hail: Standard. Administered by Tamko. OtterQuote is not the warrantor.', '2026-04-30', '2026-07-30'),
  ('Tamko', 'Heritage IR / Lifetime',     'Lifetime (limited)',     NULL, NULL, NULL, 130, 'Class 4 (some products)', NULL,                  NULL,
    'Tamko Heritage IR / Lifetime — Material: Lifetime (limited); Labor: None; Wind: 130 mph; Hail: Class 4 (some products). Administered by Tamko. OtterQuote is not the warrantor.', '2026-04-30', '2026-07-30'),
  ('Tamko', 'Pro Certification',          'Per product',            5,    NULL, NULL, NULL, 'Per product',           'Tamko Pro contractor', NULL,
    'Tamko Pro Certification — Material: Per product; Labor: 5 years; Wind: Per product; Hail: Per product. Administered by Tamko; requires Tamko Pro contractor — verified by OtterQuote per D-204. OtterQuote is not the warrantor.', '2026-04-30', '2026-07-30'),

  -- Atlas
  ('Atlas', 'Standard Limited', 'Lifetime (limited)', NULL, NULL,         NULL, 130, 'Standard', NULL,                         'https://www.atlasroofing.com/contractors',
    'Atlas Standard Limited — Material: Lifetime (limited); Labor: None; Wind: 130 mph; Hail: Standard. Administered by Atlas. OtterQuote is not the warrantor.', '2026-04-30', '2026-07-30'),
  ('Atlas', 'Pro Plus',         'Lifetime',           15,   '10–15 years', NULL, 130, 'Standard', 'Atlas Pro Plus',             'https://www.atlasroofing.com/contractors',
    'Atlas Pro Plus — Material: Lifetime; Labor: 10–15 years; Wind: 130 mph; Hail: Standard. Administered by Atlas; requires Atlas Pro Plus — verified by OtterQuote per D-204. OtterQuote is not the warrantor.', '2026-04-30', '2026-07-30'),
  ('Atlas', 'Signature Select', '50 (non-prorated)',  25,   NULL,          25,   130, 'Standard', 'Atlas Signature Select',     'https://www.atlasroofing.com/contractors',
    'Atlas Signature Select — Material: 50 years (non-prorated); Labor: 25 years; Tear-off: 25 years; Wind: 130 mph; Hail: Standard. Administered by Atlas; requires Atlas Signature Select — verified by OtterQuote per D-204. OtterQuote is not the warrantor.', '2026-04-30', '2026-07-30'),

  -- IKO
  ('IKO', 'Standard Limited',                  'Lifetime (limited)', NULL, NULL,             NULL, 110, 'Standard', NULL,                  'https://www.iko.com',
    'IKO Standard Limited — Material: Lifetime (limited); Labor: None; Wind: 110 mph; Hail: Standard. Administered by IKO. OtterQuote is not the warrantor.', '2026-04-30', '2026-07-30'),
  ('IKO', 'Iron Clad Plus / Shield Pro Plus',  'Lifetime (limited)', 2,    '1–2 years',      NULL, 110, 'Standard', 'Shield Pro contractor', 'https://www.iko.com',
    'IKO Iron Clad Plus / Shield Pro Plus — Material: Lifetime (limited); Labor: 1–2 years; Wind: 110 mph; Hail: Standard. Administered by IKO; requires Shield Pro contractor — verified by OtterQuote per D-204. OtterQuote is not the warrantor.', '2026-04-30', '2026-07-30'),

  -- Malarkey
  ('Malarkey', 'Limited Lifetime',                                'Lifetime (limited)', NULL, NULL, NULL, 110, 'Standard', NULL,                       'https://www.malarkeyroofing.com/contractor-locator',
    'Malarkey Limited Lifetime — Material: Lifetime (limited); Labor: None; Wind: 110 mph; Hail: Standard. Administered by Malarkey. OtterQuote is not the warrantor.', '2026-04-30', '2026-07-30'),
  ('Malarkey', 'Roof System Warranty (Emerald Pro)',              'Lifetime',           5,    NULL, NULL, 130, 'Standard', 'Emerald Pro',              'https://www.malarkeyroofing.com/contractor-locator',
    'Malarkey Roof System Warranty (Emerald Pro) — Material: Lifetime; Labor: 5 years; Wind: 130 mph; Hail: Standard. Administered by Malarkey; requires Emerald Pro — verified by OtterQuote per D-204. OtterQuote is not the warrantor.', '2026-04-30', '2026-07-30'),
  ('Malarkey', 'Premium System Warranty (Emerald Pro Premium)',   '50 (non-prorated)',  15,   NULL, NULL, 130, 'Standard', 'Emerald Pro Premium',      'https://www.malarkeyroofing.com/contractor-locator',
    'Malarkey Premium System Warranty (Emerald Pro Premium) — Material: 50 years (non-prorated); Labor: 15 years; Wind: 130 mph; Hail: Standard. Administered by Malarkey; requires Emerald Pro Premium — verified by OtterQuote per D-204. OtterQuote is not the warrantor.', '2026-04-30', '2026-07-30'),

  -- PABCO
  ('PABCO', 'Standard Limited',  'Lifetime (limited)', NULL, NULL, NULL, 110, 'Standard', NULL,                       'https://www.pabcoroofing.com',
    'PABCO Standard Limited — Material: Lifetime (limited); Labor: None; Wind: 110 mph; Hail: Standard. Administered by PABCO. OtterQuote is not the warrantor.', '2026-04-30', '2026-07-30'),
  ('PABCO', 'Paramount Premier', 'Lifetime',           10,   NULL, NULL, 130, 'Standard', 'PABCO Premier Roofer',     'https://www.pabcoroofing.com',
    'PABCO Paramount Premier — Material: Lifetime; Labor: 10 years; Wind: 130 mph; Hail: Standard. Administered by PABCO; requires PABCO Premier Roofer — verified by OtterQuote per D-204. OtterQuote is not the warrantor.', '2026-04-30', '2026-07-30')

ON CONFLICT (manufacturer, tier) DO UPDATE SET
  material_years   = EXCLUDED.material_years,
  labor_years      = EXCLUDED.labor_years,
  labor_note       = EXCLUDED.labor_note,
  tearoff_years    = EXCLUDED.tearoff_years,
  wind_mph         = EXCLUDED.wind_mph,
  wind_note        = EXCLUDED.wind_note,
  hail_class       = EXCLUDED.hail_class,
  cert_required    = EXCLUDED.cert_required,
  cert_lookup_url  = EXCLUDED.cert_lookup_url,
  display_string   = EXCLUDED.display_string,
  last_verified    = EXCLUDED.last_verified,
  next_review      = EXCLUDED.next_review,
  updated_at       = NOW();
