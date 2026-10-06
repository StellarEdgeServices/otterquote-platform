-- Rollback for 20261006171747_gh2559_claim_docs_world_fence.sql (gh-2559).
-- WARNING: this RE-OPENS the hole of #2559: every active contractor login, test-flagged ones included,
-- can again read every file in the folder of any claim that is open for bids, real homeowners' claims
-- included. Run it only if the fence refuses a read a legitimate contractor needs, and say so on #2559.
-- It restores the v88 policy text (20260708002834) exactly: the same policy without
-- "and c.is_test = ct.is_test". Nothing else is touched.
-- If the migration was applied, also delete its supabase_migrations.schema_migrations row
-- (name '20261006171024_gh2559_claim_docs_world_fence').
BEGIN;

SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS "Contractors can view biddable claim docs" ON storage.objects;

CREATE POLICY "Contractors can view biddable claim docs"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'claim-documents'
  AND EXISTS (
    SELECT 1
    FROM public.claims c
    JOIN public.contractors ct
      ON ct.user_id = auth.uid()
     AND ct.status = 'active'
    WHERE c.id::text = (storage.foldername(objects.name))[2]
      AND (
        (c.ready_for_bids = true AND c.status IN ('active', 'bidding', 'pending'))
        OR c.selected_contractor_id = ct.id
      )
  )
);

COMMIT;
