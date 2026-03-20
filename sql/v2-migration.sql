-- ============================================================
-- ClaimShield v2 — Database Migration
-- Run in Supabase SQL Editor
-- ============================================================
-- This migration adds all new tables and columns for v2.
-- It is safe to run multiple times (uses IF NOT EXISTS / IF NOT EXISTS patterns).
-- ============================================================

-- ── 1. Carrier Profiles (D-043) ──────────────────────────────
-- Stores institutional knowledge about insurance carriers.
-- "Help Me" flows customize based on carrier selection.
CREATE TABLE IF NOT EXISTS carrier_profiles (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  carrier_name  TEXT NOT NULL UNIQUE,
  portal_url    TEXT,
  claims_email  TEXT,
  claims_phone  TEXT,
  typical_estimate_days INTEGER,
  process_notes TEXT,
  special_instructions TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- Seed top Indiana carriers
INSERT INTO carrier_profiles (carrier_name) VALUES
  ('State Farm'), ('Allstate'), ('Liberty Mutual'), ('USAA'),
  ('Erie Insurance'), ('Nationwide'), ('Progressive'), ('Farmers'),
  ('Auto-Owners Insurance'), ('Cincinnati Financial'),
  ('American Family'), ('Travelers'), ('Hartford'), ('Safeco'),
  ('West Bend Mutual')
ON CONFLICT (carrier_name) DO NOTHING;


-- ── 2. Adjusters Knowledge Base (D-046) ──────────────────────
-- Stores adjuster info, auto-fills for future homeowners.
CREATE TABLE IF NOT EXISTS adjusters (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  adjuster_name   TEXT NOT NULL,
  adjuster_email  TEXT,
  adjuster_phone  TEXT,
  carrier_id      UUID REFERENCES carrier_profiles(id),
  region          TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  -- Prevent exact duplicates
  UNIQUE(adjuster_name, adjuster_email, carrier_id)
);

CREATE INDEX IF NOT EXISTS idx_adjusters_carrier ON adjusters(carrier_id);
CREATE INDEX IF NOT EXISTS idx_adjusters_name ON adjusters(adjuster_name);


-- ── 3. Extend profiles table ─────────────────────────────────
-- Add fields for full lead capture (D-035)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='phone') THEN
    ALTER TABLE profiles ADD COLUMN phone TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='address_street') THEN
    ALTER TABLE profiles ADD COLUMN address_street TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='address_city') THEN
    ALTER TABLE profiles ADD COLUMN address_city TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='address_state') THEN
    ALTER TABLE profiles ADD COLUMN address_state TEXT DEFAULT 'IN';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='address_zip') THEN
    ALTER TABLE profiles ADD COLUMN address_zip TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='referral_source') THEN
    ALTER TABLE profiles ADD COLUMN referral_source TEXT; -- 'insurance_agent', 'realtor', 'web', 'other'
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='referring_agent_name') THEN
    ALTER TABLE profiles ADD COLUMN referring_agent_name TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='referring_agent_email') THEN
    ALTER TABLE profiles ADD COLUMN referring_agent_email TEXT;
  END IF;
END $$;


-- ── 4. Extend claims table ───────────────────────────────────
-- Add adjuster info, carrier link, ingest email, material selections
DO $$
BEGIN
  -- Carrier link
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='carrier_id') THEN
    ALTER TABLE claims ADD COLUMN carrier_id UUID REFERENCES carrier_profiles(id);
  END IF;

  -- Adjuster info (D-044) — denormalized for quick access
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='adjuster_id') THEN
    ALTER TABLE claims ADD COLUMN adjuster_id UUID REFERENCES adjusters(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='adjuster_name') THEN
    ALTER TABLE claims ADD COLUMN adjuster_name TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='adjuster_email') THEN
    ALTER TABLE claims ADD COLUMN adjuster_email TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='adjuster_phone') THEN
    ALTER TABLE claims ADD COLUMN adjuster_phone TEXT;
  END IF;

  -- Ingest email (auto-ingest system)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='ingest_email') THEN
    ALTER TABLE claims ADD COLUMN ingest_email TEXT UNIQUE;
  END IF;

  -- Material selection (D-037, D-049, D-050)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='material_category') THEN
    ALTER TABLE claims ADD COLUMN material_category TEXT; -- 'shingle' or 'metal'
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='shingle_type') THEN
    ALTER TABLE claims ADD COLUMN shingle_type TEXT; -- '3tab', 'architectural', 'designer'
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='impact_class') THEN
    ALTER TABLE claims ADD COLUMN impact_class TEXT; -- 'none', 'class3', 'class4'
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='designer_product') THEN
    ALTER TABLE claims ADD COLUMN designer_product TEXT; -- specific product if designer shingle
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='designer_manufacturer') THEN
    ALTER TABLE claims ADD COLUMN designer_manufacturer TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='metal_type') THEN
    ALTER TABLE claims ADD COLUMN metal_type TEXT; -- 'standing_seam', 'exposed_fastener'
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='metal_material') THEN
    ALTER TABLE claims ADD COLUMN metal_material TEXT; -- 'steel', 'aluminum'
  END IF;

  -- Color selection (D-058 — separate from material, happens after contractor selection)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='color_brand') THEN
    ALTER TABLE claims ADD COLUMN color_brand TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='color_name') THEN
    ALTER TABLE claims ADD COLUMN color_name TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='color_selected_at') THEN
    ALTER TABLE claims ADD COLUMN color_selected_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='color_addendum_signed') THEN
    ALTER TABLE claims ADD COLUMN color_addendum_signed BOOLEAN DEFAULT false;
  END IF;

  -- Hover measurement
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='hover_order_id') THEN
    ALTER TABLE claims ADD COLUMN hover_order_id TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='hover_status') THEN
    ALTER TABLE claims ADD COLUMN hover_status TEXT; -- 'pending', 'processing', 'complete'
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='hover_paid') THEN
    ALTER TABLE claims ADD COLUMN hover_paid BOOLEAN DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='hover_rebated') THEN
    ALTER TABLE claims ADD COLUMN hover_rebated BOOLEAN DEFAULT false;
  END IF;

  -- Document flags
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='has_estimate') THEN
    ALTER TABLE claims ADD COLUMN has_estimate BOOLEAN DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='has_measurements') THEN
    ALTER TABLE claims ADD COLUMN has_measurements BOOLEAN DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='has_material_selection') THEN
    ALTER TABLE claims ADD COLUMN has_material_selection BOOLEAN DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='ready_for_bids') THEN
    ALTER TABLE claims ADD COLUMN ready_for_bids BOOLEAN DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='bids_submitted_at') THEN
    ALTER TABLE claims ADD COLUMN bids_submitted_at TIMESTAMPTZ;
  END IF;

  -- Contract & escrow (D-058)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='selected_contractor_id') THEN
    ALTER TABLE claims ADD COLUMN selected_contractor_id UUID REFERENCES contractors(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='contract_signed_at') THEN
    ALTER TABLE claims ADD COLUMN contract_signed_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='docusign_envelope_id') THEN
    ALTER TABLE claims ADD COLUMN docusign_envelope_id TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='deductible_amount') THEN
    ALTER TABLE claims ADD COLUMN deductible_amount NUMERIC(10,2);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='deductible_collected') THEN
    ALTER TABLE claims ADD COLUMN deductible_collected BOOLEAN DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='deductible_stripe_id') THEN
    ALTER TABLE claims ADD COLUMN deductible_stripe_id TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='platform_fee_charged') THEN
    ALTER TABLE claims ADD COLUMN platform_fee_charged BOOLEAN DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='platform_fee_amount') THEN
    ALTER TABLE claims ADD COLUMN platform_fee_amount NUMERIC(10,2);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='platform_fee_stripe_id') THEN
    ALTER TABLE claims ADD COLUMN platform_fee_stripe_id TEXT;
  END IF;
END $$;


-- ── 5. Adjuster Email Requests ───────────────────────────────
-- Tracks emails sent to adjusters and their responses (auto-ingest)
CREATE TABLE IF NOT EXISTS adjuster_email_requests (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  claim_id        UUID NOT NULL REFERENCES claims(id),
  adjuster_id     UUID REFERENCES adjusters(id),
  to_email        TEXT NOT NULL,
  to_name         TEXT,
  request_type    TEXT NOT NULL, -- 'estimate', 'measurements', 'both'
  ingest_email    TEXT NOT NULL, -- unique reply-to address
  sent_at         TIMESTAMPTZ DEFAULT now(),
  response_received BOOLEAN DEFAULT false,
  response_at     TIMESTAMPTZ,
  followup_sent   BOOLEAN DEFAULT false,
  followup_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aer_claim ON adjuster_email_requests(claim_id);
CREATE INDEX IF NOT EXISTS idx_aer_ingest ON adjuster_email_requests(ingest_email);


-- ── 6. Material Catalog ──────────────────────────────────────
-- Manually curated product catalog (D-052)
CREATE TABLE IF NOT EXISTS material_catalog (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  category        TEXT NOT NULL, -- 'shingle', 'metal'
  subcategory     TEXT NOT NULL, -- '3tab', 'architectural', 'designer', 'standing_seam', 'exposed_fastener'
  manufacturer    TEXT,
  product_name    TEXT,
  impact_class    TEXT, -- 'none', 'class3', 'class4' (shingles only)
  description     TEXT,
  price_tier      TEXT, -- 'standard', 'mid', 'premium'
  image_url       TEXT,
  visualizer_url  TEXT, -- link to manufacturer's color visualizer
  active          BOOLEAN DEFAULT true,
  sort_order      INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- Seed architectural shingles (generic entries — brand doesn't matter per D-049)
INSERT INTO material_catalog (category, subcategory, impact_class, product_name, description, price_tier, sort_order) VALUES
  ('shingle', 'architectural', 'none', 'Architectural Shingle — Standard', 'The most popular residential roofing option. Dimensional look, 130+ mph wind rating, 25-30 year warranty. Included in most insurance claims at no additional cost.', 'standard', 1),
  ('shingle', 'architectural', 'class3', 'Architectural Shingle — Class 3 Impact Resistant', 'Same great architectural shingle with added hail protection. Withstands 1.75" steel ball impact. May qualify for insurance premium discounts.', 'standard', 2),
  ('shingle', 'architectural', 'class4', 'Architectural Shingle — Class 4 Impact Resistant', 'Maximum hail protection with SBS polymer-modified asphalt. Withstands 2" steel ball impact (UL 2218 Class 4). Often qualifies for significant insurance premium discounts.', 'mid', 3),
  ('shingle', '3tab', 'none', '3-Tab Shingle', 'Basic flat appearance. Rarely used on new installations. Lower cost but shorter lifespan. Most contractors will recommend upgrading to architectural.', 'standard', 10),
  ('shingle', 'designer', 'none', 'Designer Shingle', 'Premium appearance mimicking slate, cedar shake, or tile. Significant price variation by manufacturer and design. Expect out-of-pocket cost above what insurance covers.', 'premium', 20),
  ('metal', 'standing_seam', 'none', 'Standing Seam Metal Roof', 'Premium concealed-fastener metal roof. 24-gauge steel standard. 40+ year lifespan. ~$12-13/sqft installed. Significant upgrade cost over architectural shingles.', 'premium', 30),
  ('metal', 'exposed_fastener', 'none', 'Exposed Fastener Metal Roof', 'Budget metal option with visible screws through panel. 26-29 gauge steel. ~$8-9/sqft installed. Upgrade over architectural shingles.', 'mid', 31)
ON CONFLICT DO NOTHING;


-- ── 7. Hover Orders ──────────────────────────────────────────
-- Tracks Hover measurement purchases (D-036)
CREATE TABLE IF NOT EXISTS hover_orders (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  claim_id        UUID NOT NULL REFERENCES claims(id),
  user_id         UUID NOT NULL,
  hover_job_id    TEXT, -- from Hover API
  status          TEXT DEFAULT 'pending', -- 'pending', 'photos_submitted', 'processing', 'complete', 'failed'
  hover_link      TEXT, -- link sent to homeowner for photo capture
  amount_charged  NUMERIC(10,2),
  stripe_payment_id TEXT,
  rebated         BOOLEAN DEFAULT false,
  rebate_stripe_id TEXT,
  report_url      TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hover_claim ON hover_orders(claim_id);


-- ── 8. Notifications Log ─────────────────────────────────────
-- Tracks all SMS and email notifications sent
CREATE TABLE IF NOT EXISTS notifications (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         UUID,
  claim_id        UUID REFERENCES claims(id),
  channel         TEXT NOT NULL, -- 'sms', 'email', 'push'
  notification_type TEXT NOT NULL, -- 'bid_received', 'estimate_arrived', 'followup_call', 'contract_ready', etc.
  recipient       TEXT NOT NULL, -- phone or email
  message_preview TEXT,
  sent_at         TIMESTAMPTZ DEFAULT now(),
  delivered       BOOLEAN,
  twilio_sid      TEXT, -- for SMS tracking
  mailgun_id      TEXT  -- for email tracking
);

CREATE INDEX IF NOT EXISTS idx_notif_claim ON notifications(claim_id);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id);


-- ── 9. Row Level Security ────────────────────────────────────
-- Enable RLS on new tables
ALTER TABLE carrier_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE adjusters ENABLE ROW LEVEL SECURITY;
ALTER TABLE adjuster_email_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE hover_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Carrier profiles: readable by all authenticated users
DO $$ BEGIN
  CREATE POLICY "carrier_profiles_read" ON carrier_profiles FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Adjusters: readable by all authenticated users
DO $$ BEGIN
  CREATE POLICY "adjusters_read" ON adjusters FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Material catalog: readable by everyone (including anon for public pages)
DO $$ BEGIN
  CREATE POLICY "material_catalog_read" ON material_catalog FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Adjuster email requests: users can only see their own claims' requests
DO $$ BEGIN
  CREATE POLICY "aer_user_read" ON adjuster_email_requests FOR SELECT TO authenticated USING (claim_id IN (SELECT id FROM claims WHERE user_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Hover orders: users can only see their own
DO $$ BEGIN
  CREATE POLICY "hover_user_read" ON hover_orders FOR SELECT TO authenticated USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Notifications: users can only see their own
DO $$ BEGIN
  CREATE POLICY "notifications_user_read" ON notifications FOR SELECT TO authenticated USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ── 10. Updated_at triggers ──────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_carrier_profiles_updated') THEN
    CREATE TRIGGER trg_carrier_profiles_updated BEFORE UPDATE ON carrier_profiles
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_adjusters_updated') THEN
    CREATE TRIGGER trg_adjusters_updated BEFORE UPDATE ON adjusters
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_hover_orders_updated') THEN
    CREATE TRIGGER trg_hover_orders_updated BEFORE UPDATE ON hover_orders
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;


-- ============================================================
-- DONE. Run this in Supabase SQL Editor.
-- Next: Configure RLS policies for INSERT/UPDATE as needed
--       based on application logic.
-- ============================================================
