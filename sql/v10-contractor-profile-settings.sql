-- ============================================================
-- OtterQuote v10 Migration — Contractor Profile & Settings
-- Wire contractor-profile.html and contractor-settings.html
-- to real Supabase data.
-- ============================================================
-- Run in Supabase SQL Editor
-- Date: April 5, 2026
-- ============================================================

-- 1. Add profile fields to contractors table
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS about_us TEXT;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS why_choose_us TEXT;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS owner_photo_url TEXT;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS preferred_brands TEXT[];  -- e.g. {'GAF','Owens Corning'}
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS trades TEXT[];            -- e.g. {'roofing','gutters','siding'}
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS service_counties TEXT[];  -- e.g. {'Hamilton','Hendricks','Boone'}
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS service_area_description TEXT;

-- 2. Add review link fields to contractors table
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS google_reviews_url TEXT;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS bbb_url TEXT;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS angi_url TEXT;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS yelp_url TEXT;

-- 3. Add settings fields to contractors table
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS color_selection_enabled BOOLEAN DEFAULT true;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS notification_emails TEXT[];   -- multiple notification emails
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS notification_phones TEXT[];   -- multiple notification phones
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS notification_preferences JSONB DEFAULT '{"new_opportunity":true,"bid_accepted":true,"contract_signed":true,"color_complete":true,"deductible_collected":true,"reminder_48h":true}'::jsonb;

-- 4. Add status column if it doesn't exist (used by notify-contractors Edge Function)
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended', 'pending'));

-- 5. Add updated_at column if missing
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- 6. Create contractor_certifications table
CREATE TABLE IF NOT EXISTS contractor_certifications (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    contractor_id UUID NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
    certification_name TEXT NOT NULL,
    issuing_organization TEXT,
    certification_number TEXT,
    expiration_date DATE,
    verified BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contractor_certs_contractor_id ON contractor_certifications(contractor_id);

-- 7. Create notifications table (used by notify-contractors Edge Function)
CREATE TABLE IF NOT EXISTS notifications (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID,
    claim_id UUID,
    channel TEXT CHECK (channel IN ('email', 'sms', 'push', 'dashboard')),
    notification_type TEXT,
    recipient TEXT,
    message_preview TEXT,
    sent_at TIMESTAMPTZ DEFAULT NOW(),
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_claim_id ON notifications(claim_id);

-- 8. Add ready_for_bids and bids_submitted_at to claims if missing
ALTER TABLE claims ADD COLUMN IF NOT EXISTS ready_for_bids BOOLEAN DEFAULT false;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS bids_submitted_at TIMESTAMPTZ;

-- 9. RLS policies for new tables
ALTER TABLE contractor_certifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Contractor certifications: contractors can manage their own
CREATE POLICY "Contractors can view own certifications" ON contractor_certifications
    FOR SELECT USING (contractor_id IN (SELECT id FROM contractors WHERE user_id = auth.uid()));

CREATE POLICY "Contractors can insert own certifications" ON contractor_certifications
    FOR INSERT WITH CHECK (contractor_id IN (SELECT id FROM contractors WHERE user_id = auth.uid()));

CREATE POLICY "Contractors can delete own certifications" ON contractor_certifications
    FOR DELETE USING (contractor_id IN (SELECT id FROM contractors WHERE user_id = auth.uid()));

-- Notifications: users can see their own
CREATE POLICY "Users can view own notifications" ON notifications
    FOR SELECT USING (user_id = auth.uid());

-- Service role full access (for Edge Functions)
CREATE POLICY "Service role full access to contractor_certifications" ON contractor_certifications
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access to notifications" ON notifications
    FOR ALL USING (auth.role() = 'service_role');

-- 10. RLS policy: contractors can read claims that are ready for bids
-- (so the opportunities page can query claims)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'Contractors can view biddable claims' AND tablename = 'claims'
    ) THEN
        CREATE POLICY "Contractors can view biddable claims" ON claims
            FOR SELECT USING (
                ready_for_bids = true
                AND status IN ('active', 'bidding', 'pending')
                AND auth.uid() IN (SELECT user_id FROM contractors WHERE status = 'active')
            );
    END IF;
END
$$;

-- 11. RLS policy: contractors can update their own record
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'Contractors can update own record' AND tablename = 'contractors'
    ) THEN
        CREATE POLICY "Contractors can update own record" ON contractors
            FOR UPDATE USING (user_id = auth.uid());
    END IF;
END
$$;

-- 12. RLS policy: contractors can read their own record
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'Contractors can view own record' AND tablename = 'contractors'
    ) THEN
        CREATE POLICY "Contractors can view own record" ON contractors
            FOR SELECT USING (user_id = auth.uid());
    END IF;
END
$$;

-- ============================================================
-- DONE. Changes:
-- Modified: contractors (16 new columns)
-- New tables: contractor_certifications, notifications
-- New RLS policies: contractors CRUD, certifications CRUD,
--                   notifications read, biddable claims read
-- ============================================================
