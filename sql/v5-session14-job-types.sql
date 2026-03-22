-- ============================================================
-- OtterQuote v5 Migration — Session 14: Job Types, Urgency,
-- Decking Contingency, Multi-License, Homeowner Notes
-- ============================================================
-- Run in Supabase SQL Editor
-- Date: March 20, 2026
-- ============================================================

-- 1. Add job type and related fields to claims table
ALTER TABLE claims ADD COLUMN IF NOT EXISTS job_type TEXT CHECK (job_type IN ('insurance_rcv', 'insurance_acv', 'retail', 'repair'));
ALTER TABLE claims ADD COLUMN IF NOT EXISTS rcv_amount DECIMAL(10,2);
ALTER TABLE claims ADD COLUMN IF NOT EXISTS acv_amount DECIMAL(10,2);
ALTER TABLE claims ADD COLUMN IF NOT EXISTS deductible_amount DECIMAL(10,2);
ALTER TABLE claims ADD COLUMN IF NOT EXISTS roof_squares DECIMAL(6,1);
ALTER TABLE claims ADD COLUMN IF NOT EXISTS repair_squares DECIMAL(6,1);
ALTER TABLE claims ADD COLUMN IF NOT EXISTS existing_shingle_brand TEXT;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS existing_shingle_product TEXT;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS existing_shingle_color TEXT;

-- 2. Add urgency fields to claims
ALTER TABLE claims ADD COLUMN IF NOT EXISTS urgency TEXT DEFAULT 'flexible' CHECK (urgency IN ('flexible', '30_days', '2_weeks', 'asap'));
ALTER TABLE claims ADD COLUMN IF NOT EXISTS urgency_deadline DATE;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS urgency_reason TEXT;

-- 3. Add homeowner notes to claims
ALTER TABLE claims ADD COLUMN IF NOT EXISTS homeowner_notes TEXT;

-- 4. Add decking contingency fields to quotes table
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS decking_price_per_sheet DECIMAL(8,2);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS full_redeck_price DECIMAL(10,2);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS supplement_acknowledged BOOLEAN DEFAULT false;

-- 5. Create contractor_licenses table (replaces single license on contractors)
CREATE TABLE IF NOT EXISTS contractor_licenses (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    contractor_id UUID REFERENCES contractors(id) ON DELETE CASCADE,
    municipality TEXT NOT NULL,
    license_number TEXT,
    license_document_url TEXT,
    expiration_date DATE,
    verified BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for quick lookup by contractor
CREATE INDEX IF NOT EXISTS idx_contractor_licenses_contractor_id ON contractor_licenses(contractor_id);

-- 6. Add no_license_required flag to contractors
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS no_license_required BOOLEAN DEFAULT false;

-- 7. Create claim_trade_items table (per-trade breakdown from insurance estimate)
CREATE TABLE IF NOT EXISTS claim_trade_items (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    claim_id UUID REFERENCES claims(id) ON DELETE CASCADE,
    trade TEXT NOT NULL, -- 'roof', 'gutters', 'siding', 'windows', 'paint', etc.
    scope TEXT CHECK (scope IN ('full_replacement', 'partial_replacement', 'repair')),
    estimated_amount DECIMAL(10,2),
    depreciation_amount DECIMAL(10,2),
    sides_affected TEXT, -- e.g. 'north,east' for directional damage
    homeowner_decision TEXT CHECK (homeowner_decision IN ('keep_money', 'do_work', 'supplement', 'undecided')),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claim_trade_items_claim_id ON claim_trade_items(claim_id);

-- 8. RLS policies for new tables
ALTER TABLE contractor_licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_trade_items ENABLE ROW LEVEL SECURITY;

-- Contractor licenses: contractors can see their own, admins can see all
CREATE POLICY "Contractors can view own licenses" ON contractor_licenses
    FOR SELECT USING (contractor_id IN (SELECT id FROM contractors WHERE user_id = auth.uid()));

CREATE POLICY "Contractors can insert own licenses" ON contractor_licenses
    FOR INSERT WITH CHECK (contractor_id IN (SELECT id FROM contractors WHERE user_id = auth.uid()));

CREATE POLICY "Contractors can update own licenses" ON contractor_licenses
    FOR UPDATE USING (contractor_id IN (SELECT id FROM contractors WHERE user_id = auth.uid()));

-- Claim trade items: homeowners can see their own claim's items
CREATE POLICY "Homeowners can view own claim trade items" ON claim_trade_items
    FOR SELECT USING (claim_id IN (SELECT id FROM claims WHERE user_id = auth.uid()));

CREATE POLICY "Homeowners can update own claim trade items" ON claim_trade_items
    FOR UPDATE USING (claim_id IN (SELECT id FROM claims WHERE user_id = auth.uid()));

-- Service role can do everything (for Edge Functions)
CREATE POLICY "Service role full access to contractor_licenses" ON contractor_licenses
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access to claim_trade_items" ON claim_trade_items
    FOR ALL USING (auth.role() = 'service_role');

-- ============================================================
-- DONE. New tables: contractor_licenses, claim_trade_items
-- Modified tables: claims (8 new columns), quotes (3 new columns),
--                  contractors (1 new column)
-- ============================================================
