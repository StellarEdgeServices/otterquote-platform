-- Rollback for v88: remove contractor read access to claim documents.
drop policy if exists "Contractors can view biddable claim docs" on storage.objects;
