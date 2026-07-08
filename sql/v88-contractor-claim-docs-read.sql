-- v88: contractors can read claim documents (loss sheets, measurement files)
-- for claims that are biddable to them or awarded to them.
-- E2E walk 2026-07-08: claim-documents SELECT was owner-only, so the
-- Loss Sheet / measurement doc buttons failed for every contractor.
-- Path convention: {homeowner_uid}/{claim_id}/{filename} -> foldername[2] = claim_id.
-- Mirrors the "Contractors can view biddable claims" RLS on public.claims (v10)
-- plus post-award access via selected_contractor_id.
-- Applied to production via Supabase MCP migration v88_contractor_claim_docs_read (2026-07-08).
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
