-- ============================================================
-- OtterQuote SQL Migration v15
-- Carrier Knowledge Base (D-043) + Adjuster Knowledge Base (D-046)
-- Run in Supabase SQL Editor
-- ============================================================

-- ----------------------------------------------------------------
-- 1. CARRIER PROFILES (D-043)
-- Populated by OtterQuote, not homeowners.
-- Powers carrier-specific "Help Me" tips in help-estimate.html
-- and the carrier dropdown on dashboard.html.
-- ----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS carrier_profiles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  carrier_name   text NOT NULL UNIQUE,
  claims_portal_url text,
  claims_email   text,
  claims_phone   text,
  typical_estimate_days int,     -- median days to receive estimate
  process_notes  text,           -- internal notes, shown to homeowner in Help Me flow
  special_instructions text,     -- carrier-specific steps (e.g., "Must file within 60 days")
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Seed: top Indiana carriers
-- Sources: carrier websites, public claims contact directories (Apr 2026)
INSERT INTO carrier_profiles (carrier_name, claims_portal_url, claims_email, claims_phone, typical_estimate_days, process_notes, special_instructions)
VALUES
  (
    'State Farm',
    'https://www.statefarm.com/claims',
    'claims@statefarm.com',
    '800-732-5246',
    7,
    'State Farm uses their own "State Farm Estimates" tool. Most claims are handled through their mobile app or website. Adjusters typically schedule within 3–5 business days of filing.',
    'File your claim online or via 1-800-SF-CLAIM before requesting an adjuster visit. Document all damage with photos first.'
  ),
  (
    'Allstate',
    'https://www.allstate.com/claims',
    NULL,
    '800-255-7828',
    8,
    'Allstate uses a network of preferred contractors called "Good Hands Repair Network." You are NOT required to use them — you can choose your own contractor. Estimates may come with a "Xactimate" itemized breakdown.',
    'Request a "proof of loss" document after the adjuster visit. This is your official estimate. Keep a copy — contractors will need it.'
  ),
  (
    'Farmers Insurance',
    'https://www.farmers.com/claims/',
    NULL,
    '800-435-7764',
    9,
    'Farmers handles claims through local agents or their national claims line. Estimates typically use Xactimate software. Some Indiana agents handle claims directly — check with your agent first.',
    'Have your policy number and date of loss ready. Take photos before any temporary repairs (tarps, board-ups).'
  ),
  (
    'Liberty Mutual',
    'https://www.libertymutual.com/claims',
    NULL,
    '800-225-2467',
    7,
    'Liberty Mutual uses both field adjusters and "virtual" photo-based inspections. Xactimate estimates are standard. Their mobile app allows photo uploads directly to your claim.',
    'Check if you qualify for virtual inspection — faster than waiting for a field visit. Upload high-quality photos of all damaged areas.'
  ),
  (
    'USAA',
    'https://www.usaa.com/inet/wc/insurance_claims_home',
    NULL,
    '800-531-8722',
    5,
    'USAA consistently ranks #1 for claims satisfaction. Estimates are typically prompt (3–5 days). Virtual inspections available. Xactimate standard.',
    'USAA members: use the USAA mobile app for the fastest claim experience. Virtual inspection is often faster than field visit.'
  ),
  (
    'Nationwide',
    'https://www.nationwide.com/personal/insurance/claims/',
    NULL,
    '800-421-3535',
    8,
    'Nationwide uses Xactimate. Field adjusters typically schedule within 5–7 days. "On Your Side" review available if you disagree with the estimate.',
    'If you disagree with the estimate, ask for an "On Your Side" review — it is a free re-evaluation included with your policy.'
  ),
  (
    'Progressive',
    'https://www.progressive.com/claims/',
    NULL,
    '800-776-4737',
    7,
    'Progressive handles homeowner claims through their National Catastrophe team during storm events. Estimates use Xactimate. Virtual inspections are common.',
    'During major storm events, Progressive deploys CAT (Catastrophe) teams to affected areas. Response times are usually faster than standard claims.'
  ),
  (
    'American Family Insurance',
    'https://www.amfam.com/claims',
    NULL,
    '800-374-1111',
    9,
    'American Family (AmFam) is headquartered in Madison, WI and has strong Indiana presence. Xactimate standard. Claims are often managed through local agents.',
    'Contact your local AmFam agent first — many handle first-contact claims. This can speed up the process compared to calling the national line.'
  ),
  (
    'Travelers',
    'https://www.travelers.com/claims',
    NULL,
    '800-252-4633',
    7,
    'Travelers is common for Indiana homeowners with mortgages. Xactimate standard. Field adjusters and virtual options available.',
    'If your mortgage lender is named on your policy, insurance checks may be made out to both you AND the lender. Plan for this — it affects your deductible escrow timing.'
  ),
  (
    'Erie Insurance',
    'https://www.erieinsurance.com/claims',
    NULL,
    '800-367-3743',
    6,
    'Erie Insurance has strong Indiana coverage and excellent claims ratings. Claims are typically handled through local agents. Xactimate standard.',
    'Erie agents are typically very involved in the claims process — call your agent directly before the national claims line for faster service.'
  ),
  (
    'Indiana Farm Bureau Insurance',
    'https://www.infarmbureau.com/claims',
    'claims@infarmbureau.com',
    '800-723-2722',
    8,
    'Indiana Farm Bureau is Indiana-specific and has strong relationships with local contractors. Claims go through local agents. Xactimate not always used — some use in-house estimating.',
    'Indiana Farm Bureau estimates may not follow standard Xactimate line items. If you receive an estimate that looks different from other carriers, this is normal.'
  ),
  (
    'Grange Insurance',
    'https://www.grangeinsurance.com/claims',
    NULL,
    '800-422-0550',
    9,
    'Grange Insurance covers Indiana through independent agents. Claims processed centrally. Xactimate standard.',
    'Grange claims can be slower than national carriers during peak storm season — submit promptly. Independent agent involvement varies.'
  ),
  (
    'Westfield Insurance',
    'https://www.westfieldinsurance.com/claims',
    NULL,
    '800-243-0210',
    9,
    'Westfield is popular in the Midwest, including Indiana. Claims handled through independent agents and regional offices. Xactimate standard.',
    'Westfield emphasizes working with local agents. Contact your agent immediately after loss — they coordinate the adjuster assignment.'
  ),
  (
    'Auto-Owners Insurance',
    'https://www.auto-owners.com/claims',
    NULL,
    '888-252-4626',
    8,
    'Auto-Owners is Indiana''s largest independent agency carrier. Strong reputation for fair estimates. All claims go through independent agents — the national line is rarely the right first call.',
    'Your local Auto-Owners agent is the primary contact. Call them before anyone else. They will file on your behalf and coordinate the adjuster.'
  ),
  (
    'Pekin Insurance',
    'https://www.pekininsurance.com/claims',
    'claimsreporting@pekininsurance.com',
    '800-322-0160',
    10,
    'Pekin Insurance is Illinois-based but covers Indiana through independent agents. Regional carrier with slower response during major storm events. Xactimate used.',
    'During Indiana storm events, Pekin may experience delays due to regional capacity. File promptly and follow up if no contact within 5 business days.'
  ),
  (
    'Other / Unknown',
    NULL,
    NULL,
    NULL,
    10,
    'For carriers not listed, the general process is: (1) call your carrier''s main claims line, (2) request a claim number and adjuster assignment, (3) ask the adjuster to provide an itemized estimate in writing.',
    'Always ask your adjuster: "Can you provide the estimate in Xactimate format?" This ensures OtterQuote can read and parse the document.'
  )
ON CONFLICT (carrier_name) DO UPDATE SET
  claims_portal_url = EXCLUDED.claims_portal_url,
  claims_email = EXCLUDED.claims_email,
  claims_phone = EXCLUDED.claims_phone,
  typical_estimate_days = EXCLUDED.typical_estimate_days,
  process_notes = EXCLUDED.process_notes,
  special_instructions = EXCLUDED.special_instructions,
  updated_at = now();

-- Row-level security: public read, no write
ALTER TABLE carrier_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "carrier_profiles_public_read" ON carrier_profiles;
CREATE POLICY "carrier_profiles_public_read"
  ON carrier_profiles FOR SELECT
  USING (true);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_carrier_profiles_updated_at ON carrier_profiles;
CREATE TRIGGER set_carrier_profiles_updated_at
  BEFORE UPDATE ON carrier_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ----------------------------------------------------------------
-- 2. ADJUSTERS TABLE (D-046)
-- Auto-fills adjuster info for homeowners who name an adjuster
-- that OtterQuote has seen before on another claim.
-- ----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS adjusters (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  adjuster_name  text NOT NULL,
  adjuster_email text,
  adjuster_phone text,
  carrier_id     uuid REFERENCES carrier_profiles(id) ON DELETE SET NULL,
  territory      text,           -- e.g., "Indianapolis metro", "Central Indiana"
  times_seen     int NOT NULL DEFAULT 1,  -- how many OtterQuote claims this adjuster has appeared on
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (adjuster_email)        -- email is the canonical dedup key
);

-- Index for fast lookups by email and carrier
CREATE INDEX IF NOT EXISTS idx_adjusters_email ON adjusters(adjuster_email);
CREATE INDEX IF NOT EXISTS idx_adjusters_carrier ON adjusters(carrier_id);
CREATE INDEX IF NOT EXISTS idx_adjusters_name ON adjusters(adjuster_name);

-- RLS: authenticated homeowners can read; service role writes
ALTER TABLE adjusters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "adjusters_auth_read" ON adjusters;
CREATE POLICY "adjusters_auth_read"
  ON adjusters FOR SELECT
  TO authenticated
  USING (true);

DROP TRIGGER IF EXISTS set_adjusters_updated_at ON adjusters;
CREATE TRIGGER set_adjusters_updated_at
  BEFORE UPDATE ON adjusters
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ----------------------------------------------------------------
-- 3. ADD ADJUSTER FK TO CLAIMS TABLE (D-044 + D-046)
-- Links a claim to a known adjuster in the knowledge base.
-- Separate from the denormalized adjuster_name/email/phone fields
-- which are kept for quick access and backward compat.
-- ----------------------------------------------------------------

ALTER TABLE claims ADD COLUMN IF NOT EXISTS adjuster_id uuid REFERENCES adjusters(id) ON DELETE SET NULL;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS ingest_email_address text UNIQUE; -- unique inbound email per claim for auto-ingest (D-059)
ALTER TABLE claims ADD COLUMN IF NOT EXISTS color_confirmation_envelope_id text; -- DocuSign envelope for color addendum

-- Index for adjuster lookup
CREATE INDEX IF NOT EXISTS idx_claims_adjuster_id ON claims(adjuster_id);


-- ----------------------------------------------------------------
-- 4. FUNCTION: upsert_adjuster_from_claim
-- Called when a homeowner enters adjuster info on a claim.
-- Either inserts new adjuster or updates existing record's
-- times_seen counter and last_seen_at. Returns the adjuster id.
-- ----------------------------------------------------------------

CREATE OR REPLACE FUNCTION upsert_adjuster_from_claim(
  p_adjuster_name  text,
  p_adjuster_email text,
  p_adjuster_phone text,
  p_carrier_id     uuid DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_adjuster_id uuid;
BEGIN
  -- If no email, we can't reliably deduplicate — just insert
  IF p_adjuster_email IS NULL OR trim(p_adjuster_email) = '' THEN
    INSERT INTO adjusters (adjuster_name, adjuster_phone, carrier_id)
    VALUES (p_adjuster_name, p_adjuster_phone, p_carrier_id)
    RETURNING id INTO v_adjuster_id;
    RETURN v_adjuster_id;
  END IF;

  -- Upsert on email
  INSERT INTO adjusters (adjuster_name, adjuster_email, adjuster_phone, carrier_id, times_seen, last_seen_at)
  VALUES (p_adjuster_name, lower(trim(p_adjuster_email)), p_adjuster_phone, p_carrier_id, 1, now())
  ON CONFLICT (adjuster_email) DO UPDATE SET
    adjuster_name  = COALESCE(EXCLUDED.adjuster_name, adjusters.adjuster_name),
    adjuster_phone = COALESCE(EXCLUDED.adjuster_phone, adjusters.adjuster_phone),
    carrier_id     = COALESCE(EXCLUDED.carrier_id, adjusters.carrier_id),
    times_seen     = adjusters.times_seen + 1,
    last_seen_at   = now(),
    updated_at     = now()
  RETURNING id INTO v_adjuster_id;

  RETURN v_adjuster_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute to authenticated users (called from dashboard.html)
GRANT EXECUTE ON FUNCTION upsert_adjuster_from_claim TO authenticated;


-- ----------------------------------------------------------------
-- 5. REPAIR OPT-IN + SHOW-UP GUARANTEE (D-100, D-102)
-- ----------------------------------------------------------------

ALTER TABLE contractors ADD COLUMN IF NOT EXISTS repairs_accepted   boolean NOT NULL DEFAULT false;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS guarantee_accepted boolean NOT NULL DEFAULT false;
  -- guarantee_accepted: contractor agreed to the show-up guarantee terms
  -- ($100 paid to homeowner, $250 charged to contractor if no-show)

-- Done.

-- ----------------------------------------------------------------
-- 6. RATE LIMIT CONFIG for get-hover-pdf
-- ----------------------------------------------------------------
INSERT INTO rate_limit_config (function_name, enabled, daily_limit, monthly_limit, description)
VALUES ('get-hover-pdf', true, 20, 50, 'On-demand Hover PDF fetch — 20/day, 50/month per claim')
ON CONFLICT (function_name) DO UPDATE SET
  daily_limit = EXCLUDED.daily_limit,
  monthly_limit = EXCLUDED.monthly_limit,
  description = EXCLUDED.description;
