-- Rollback v73: remove e2e-artifacts bucket and its RLS policy
DROP POLICY IF EXISTS "admin_read_e2e_artifacts" ON storage.objects;
DELETE FROM storage.buckets WHERE id = 'e2e-artifacts';
