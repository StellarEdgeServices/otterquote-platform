/**
 * OtterQuote SQL Migration v35: Admin Verification Fields
 * Adds admin notes, license verification, insurance verification,
 * approval tracking, and RLS policies for admin access.
 */

-- Add columns to contractors table for admin verification workflow
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS admin_notes TEXT;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS license_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS license_verified_at TIMESTAMPTZ;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS insurance_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS insurance_verified_at TIMESTAMPTZ;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS insurance_verification_sent_at TIMESTAMPTZ;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS insurance_verification_email TEXT;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- RLS Policies for Admin Access (dustinstohler1@gmail.com)

-- Admin can read all contractors
CREATE POLICY "admin_select_contractors" ON contractors
  FOR SELECT USING (
    auth.jwt() ->> 'email' = 'dustinstohler1@gmail.com'
  );

-- Admin can update all contractors
CREATE POLICY "admin_update_contractors" ON contractors
  FOR UPDATE USING (
    auth.jwt() ->> 'email' = 'dustinstohler1@gmail.com'
  );

-- Admin can read all contractor_licenses
CREATE POLICY "admin_select_licenses" ON contractor_licenses
  FOR SELECT USING (
    auth.jwt() ->> 'email' = 'dustinstohler1@gmail.com'
  );

-- Admin can read all contractor_payment_methods
CREATE POLICY "admin_select_payment_methods" ON contractor_payment_methods
  FOR SELECT USING (
    auth.jwt() ->> 'email' = 'dustinstohler1@gmail.com'
  );
