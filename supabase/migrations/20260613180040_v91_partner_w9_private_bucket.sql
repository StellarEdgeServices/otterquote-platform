-- v91: Create private partner-w9 bucket and RLS policies
-- CORRECTED 2026-09-26 (gh-1438 part 2): this file was previously filed at
-- version 20260613000000; the real supabase_migrations.schema_migrations
-- row is 20260613180040 (name v91_partner_w9_private_bucket, confirmed
-- read-only this session). Content below unchanged.
-- Security item 86e1v6nnh Item 4 -- moves W-9 PDFs off the public partner-photos bucket.
-- W-9s were publicly readable via CDN (RLS is bypassed on public buckets).
-- partner-photos remains public for headshots; this new bucket is private by design.
-- Writes go through the service role (submit-partner-w9 EF) -- no INSERT/UPDATE/DELETE
-- policy needed (service role bypasses RLS).
-- Companion rollback: sql/v91-rollback-partner-w9-bucket.sql

insert into storage.buckets (id, name, public)
values ('partner-w9', 'partner-w9', false)
on conflict (id) do nothing;

create policy "Admin read partner-w9"
on storage.objects for select to authenticated
using (bucket_id = 'partner-w9' and (auth.jwt() ->> 'email') = 'dustinstohler1@gmail.com');

create policy "Partners read own w9"
on storage.objects for select to authenticated
using (bucket_id = 'partner-w9' and (storage.foldername(name))[2] = (auth.uid())::text);
