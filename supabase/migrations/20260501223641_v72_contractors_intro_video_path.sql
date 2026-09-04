-- Migration: v72_contractors_intro_video_path
-- Filed by: gh-1438 migration history backfill batch 2 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 2, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-05-01T22:36:41Z, recorded in
-- supabase_migrations.schema_migrations as version 20260501223641, name
-- "v72_contractors_intro_video_path". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 2. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

-- v72: Intro Video on Contractor Profile
-- Companion to ClickUp 86e169f1y / feature task 86e0v8ca1
-- NOTE: v67 was reserved for this migration; filed as v72 per deploy session (W4-P4).
--
-- Adds optional intro_video_path column to contractors table.
-- Storage: contractor-documents bucket (private, existing RLS from Session 47)
-- Path convention: {user_id}/intro-video/intro-{timestamp}.{ext}
-- Read access via signed URL (private bucket, 1-hour TTL).
-- Feature is gated by INTRO_VIDEO_ENABLED flag in contractor-profile.html (flipped post-apply).
-- Display: contractor-about.html — null-safe, auto-surfaces when path is present.

ALTER TABLE contractors
  ADD COLUMN intro_video_path TEXT;

COMMENT ON COLUMN contractors.intro_video_path IS
  'Optional storage path within contractor-documents bucket for the contractor''s intro video (MP4/MOV, max 200 MB). Null when no video uploaded. Surfaced via signed URL on read.';
