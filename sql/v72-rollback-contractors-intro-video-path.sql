-- Rollback for v72-contractors-intro-video-path.sql
-- Drops the intro_video_path column from contractors.
--
-- ⚠️  Storage objects in contractor-documents are NOT deleted by this rollback —
-- any uploaded videos at {user_id}/intro-video/ must be cleaned up separately if needed.
--
-- Before running: flip INTRO_VIDEO_ENABLED back to false in contractor-profile.html
-- and redeploy, so the upload UI is hidden before the column is dropped.

ALTER TABLE contractors
  DROP COLUMN IF EXISTS intro_video_path;
