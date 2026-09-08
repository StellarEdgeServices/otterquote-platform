-- Migration: v88_contractor_claim_docs_read
-- Filed by: gh-1438 migration history backfill batch 3 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 3, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-07-08T00:28:34Z, recorded in
-- supabase_migrations.schema_migrations as version 20260708002834, name
-- "v88_contractor_claim_docs_read". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 3. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

-- v88: contractors can read claim documents (loss sheets, measurement files)
-- for claims that are biddable to them or awarded to them.
-- E2E walk 2026-07-08: claim-documents SELECT was owner-only, so the
-- Loss Sheet / measurement doc buttons failed for every contractor.
-- Path convention: {homeowner_uid}/{claim_id}/{filename} → foldername[2] = claim_id.
-- Mirrors the "Contractors can view biddable claims" RLS on public.claims (v10)
-- plus post-award access via selected_contractor_id.
create policy "Contractors can view biddable claim docs"
on storage.objects for select
to authenticated
using (
  bucket_id = 'claim-documents'
  and exists (
    select 1
    from public.claims c
    join public.contractors ct
      on ct.user_id = auth.uid()
     and ct.status = 'active'
    where c.id::text = (storage.foldername(name))[2]
      and (
        (c.ready_for_bids = true and c.status in ('active','bidding','pending'))
        or c.selected_contractor_id = ct.id
      )
  )
);
