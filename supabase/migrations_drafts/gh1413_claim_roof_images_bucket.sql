-- STATUS (gh-1438, as of 2026-11-10): NOT APPLIED. New draft (forward file), never run.
-- EVIDENCE: written by CTO RUN 102 builder (claim cto-2026-11-10T19:34:09Z) for #1413; no database access this session, nothing measured.
-- REPO COPY: none (this draft is the only copy; not in supabase/migrations/).
-- DO NOT RUN FROM THIS DIRECTORY: apply only via the Tier 3B path (migration-author, review, R-097 notice, recorded apply).
-- FILE ROLE: forward file of set gh1413_claim_roof_images_bucket
-- Tier 3B: new storage bucket and two storage.objects SELECT policies. Applied only through the Tier 3B path (migration-author, review, R-097 notice, recorded apply), never by a worker, never from this directory.
-- Rollback: supabase/migrations_drafts/gh1413_claim_roof_images_bucket_rollback.sql
--
-- #1413 / D-317 cl. 6, spec = comment 5899683996: a private bucket claim-roof-images, path {claim_id}/roof.jpg,
-- written by the fetch-roof-image Edge Function with the service role ONLY (no INSERT/UPDATE/DELETE policy for any client role),
-- readable by (1) the homeowner who owns the claim and (2) an active contractor on a biddable claim. The vendor measurement
-- PDF path (claim-documents, D-317 cl. 7, internal-only) is untouched.
BEGIN;
SET LOCAL lock_timeout = '5s';

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('claim-roof-images', 'claim-roof-images', false, 2097152, ARRAY['image/jpeg'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Homeowner can view own claim roof image" ON storage.objects;
CREATE POLICY "Homeowner can view own claim roof image"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'claim-roof-images'
  AND EXISTS (
    SELECT 1 FROM public.claims c
    WHERE c.id::text = (storage.foldername(objects.name))[1]
      AND c.user_id = auth.uid()
  )
);

DROP POLICY IF EXISTS "Contractor can view biddable claim roof image" ON storage.objects;
CREATE POLICY "Contractor can view biddable claim roof image"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'claim-roof-images'
  AND EXISTS (
    SELECT 1
    FROM public.claims c
    JOIN public.contractors ct ON ct.user_id = auth.uid() AND ct.status = 'active'
    WHERE c.id::text = (storage.foldername(objects.name))[1]
      AND c.ready_for_bids = true
      AND c.status = ANY (ARRAY['active', 'bidding', 'pending'])
      AND c.is_test = ct.is_test   -- same world fence as the biddable-claims policy (v96)
  )
);
COMMIT;
