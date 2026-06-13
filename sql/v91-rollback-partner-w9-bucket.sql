-- v91 rollback: Remove private partner-w9 bucket and its RLS policies
-- Run ONLY to undo 20260613000000_v91_partner_w9_private_bucket.sql.
-- After rollback, redeploy submit-partner-w9 EF pointing back to partner-photos
-- and revert the .from('partner-w9') in admin-referrals.html.

drop policy if exists "Admin read partner-w9" on storage.objects;
drop policy if exists "Partners read own w9" on storage.objects;
delete from storage.buckets where id = 'partner-w9';
