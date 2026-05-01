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
