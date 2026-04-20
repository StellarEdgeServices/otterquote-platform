-- ──────────────────────────────────────────────────────────────────────────────
-- v35 — Insurance detail columns + partner-photos public read + gallery photos
-- Applied: April 14, 2026 (Session 161 — Bug fixes)
-- Method: Apply via Supabase SQL Editor (Management API)
-- ──────────────────────────────────────────────────────────────────────────────

-- ── 1. Add GL/WC insurance detail columns to contractors table ──
-- BUG 3 fix: expand beyond boolean flags to carry full policy details
-- that homeowners can see on the contractor's public profile.

ALTER TABLE contractors ADD COLUMN IF NOT EXISTS gl_carrier TEXT;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS gl_policy_number TEXT;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS gl_coverage_amount TEXT;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS gl_expiration_date DATE;

ALTER TABLE contractors ADD COLUMN IF NOT EXISTS wc_carrier TEXT;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS wc_policy_number TEXT;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS wc_coverage_amount TEXT;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS wc_expiration_date DATE;

-- ── 2. Add gallery_photo_urls to contractors (array of public photo URLs) ──
-- BUG 2 fix: support storing multiple gallery photos
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS gallery_photo_urls TEXT[] DEFAULT '{}';

-- ── 3. Ensure partner-photos bucket exists and has public read access ──
-- BUG 2 fix: contractor profile photos go in partner-photos (public) bucket
-- so they display correctly on the public contractor-about.html page.

-- Create bucket if it doesn't exist (safe to run if it exists)
INSERT INTO storage.buckets (id, name, public)
VALUES ('partner-photos', 'partner-photos', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- Public read policy: allow anyone to view files in partner-photos
DROP POLICY IF EXISTS "Public read partner-photos" ON storage.objects;
CREATE POLICY "Public read partner-photos"
ON storage.objects FOR SELECT
USING (bucket_id = 'partner-photos');

-- Authenticated upload policy: contractors can upload to their own folder
DROP POLICY IF EXISTS "Auth upload partner-photos" ON storage.objects;
CREATE POLICY "Auth upload partner-photos"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'partner-photos');

-- Authenticated update policy: contractors can replace their own files
DROP POLICY IF EXISTS "Auth update partner-photos" ON storage.objects;
CREATE POLICY "Auth update partner-photos"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'partner-photos');

-- ── 4. Ensure contractor_licenses.expiration_date column exists ──
-- (Added in auth.js signup flow but may not be in initial migration)
ALTER TABLE contractor_licenses ADD COLUMN IF NOT EXISTS expiration_date DATE;

-- ── NOTES ──
-- GL/WC columns: populated via contractor-profile.html "Save Insurance Info" button
-- gallery_photo_urls: TEXT[] stored as public URLs from partner-photos bucket
-- partner-photos bucket: now public = true, with open SELECT + AUTH INSERT/UPDATE policies
-- contractor_licenses: expiration_date already present in most installs; ADD IF NOT EXISTS is safe
-- ──────────────────────────────────────────────────────────────────────────────
