-- v73: Create e2e-artifacts Supabase Storage bucket for DocuSign E2E artifact capture
-- Deployed: 2026-05-03
-- Related: D-P7-003 (preserve Phase 1+2 executed PDF artifacts)
--
-- Bucket is private. Service role (test scripts) bypasses RLS automatically.
-- Admin read policy allows Dustin to browse artifacts via Supabase Storage console.
--
-- Companion rollback: v73-rollback-e2e-artifacts-bucket.sql

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'e2e-artifacts',
  'e2e-artifacts',
  false,
  52428800,
  ARRAY['application/pdf', 'application/json']
)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "admin_read_e2e_artifacts"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'e2e-artifacts'
  AND (auth.jwt() ->> 'email') = 'dustinstohler1@gmail.com'
);
