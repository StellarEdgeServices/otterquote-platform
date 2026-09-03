-- Migration: v76-homeowner-video-upload
-- Filed by: gh-1438 migration history backfill batch 2 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 2, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-05-06T11:42:18Z, recorded in
-- supabase_migrations.schema_migrations as version 20260506114218, name
-- "v76-homeowner-video-upload". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 2. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

-- v76: Homeowner video upload — RLS policies + video_url column
-- Task: 86e0v8c28 (Phase 1 static HTML)
-- Applied: 2026-05-06 by executor (Ram)

-- Add video_url column to claims (homeowner project/claim record)
ALTER TABLE claims
ADD COLUMN IF NOT EXISTS video_url TEXT;

COMMENT ON COLUMN claims.video_url IS 
'Supabase Storage path to homeowner walkthrough video. Format: videos/{user_id}/{claim_id}.{ext}';

-- RLS: homeowner can upload their own videos
CREATE POLICY "homeowner_upload_own_video" ON storage.objects
FOR INSERT WITH CHECK (
  bucket_id = 'claim-documents'
  AND auth.uid()::text = (storage.foldername(name))[1]
  AND name LIKE 'videos/%'
);

-- RLS: homeowner can read their own videos
CREATE POLICY "homeowner_read_own_video" ON storage.objects
FOR SELECT USING (
  bucket_id = 'claim-documents'
  AND auth.uid()::text = (storage.foldername(name))[1]
  AND name LIKE 'videos/%'
);

-- RLS: homeowner can update/delete only their own videos (for future replace functionality)
CREATE POLICY "homeowner_update_own_video" ON storage.objects
FOR UPDATE USING (
  bucket_id = 'claim-documents'
  AND auth.uid()::text = (storage.foldername(name))[1]
  AND name LIKE 'videos/%'
);

CREATE POLICY "homeowner_delete_own_video" ON storage.objects
FOR DELETE USING (
  bucket_id = 'claim-documents'
  AND auth.uid()::text = (storage.foldername(name))[1]
  AND name LIKE 'videos/%'
);
