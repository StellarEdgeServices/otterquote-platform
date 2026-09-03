-- Migration: v73_e2e_artifacts_bucket
-- Filed by: gh-1438 migration history backfill batch 2 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 2, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-05-03T04:03:49Z, recorded in
-- supabase_migrations.schema_migrations as version 20260503040349, name
-- "v73_e2e_artifacts_bucket". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 2. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.


-- Create e2e-artifacts bucket (private — test PDF storage for CTO/GC review)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'e2e-artifacts',
  'e2e-artifacts',
  false,
  52428800,
  ARRAY['application/pdf', 'application/json']
)
ON CONFLICT (id) DO NOTHING;

-- Allow admin (Dustin) to view artifacts via authenticated session.
-- Service role (used by test scripts via service role key) bypasses RLS automatically.
CREATE POLICY "admin_read_e2e_artifacts"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'e2e-artifacts'
  AND (auth.jwt() ->> 'email') = 'dustinstohler1@gmail.com'
);
