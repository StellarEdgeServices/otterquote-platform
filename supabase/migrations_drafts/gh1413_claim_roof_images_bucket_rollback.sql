-- STATUS (gh-1438, as of 2026-11-10): NOT APPLIED. New draft (rollback file), never run.
-- EVIDENCE: written by CTO RUN 102 builder (claim cto-2026-11-10T19:34:09Z) for #1413; no database access this session, nothing measured.
-- REPO COPY: none (this draft is the only copy; not in supabase/migrations/).
-- DO NOT RUN FROM THIS DIRECTORY: apply only via the Tier 3B path (migration-author, review, R-097 notice, recorded apply).
BEGIN;
DROP POLICY IF EXISTS "Homeowner can view own claim roof image" ON storage.objects;
-- Remove the bucket only when empty; delete stored objects via the Storage API first (direct deletes from storage.objects are not supported).
DELETE FROM storage.buckets WHERE id = 'claim-roof-images' AND NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'claim-roof-images');
COMMIT;
