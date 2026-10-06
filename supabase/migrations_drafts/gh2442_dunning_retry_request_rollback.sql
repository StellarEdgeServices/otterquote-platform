-- STATUS (gh-1438, as of 2026-10-06T21:00Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh2442_dunning_retry_request (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: forward file not applied; see gh2442_dunning_retry_request.sql
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback for gh2442_dunning_retry_request. Run by hand, only after the forward file was applied.
-- Drops the function and the column (any stored retry requests are lost; nothing else reads them until the retry
-- pass ships, and if that has shipped, roll that back first). The last statement restores the three anon grants the
-- forward file revoked, so the table returns to its prior grant state; skip it if you want the revoke to stay.
BEGIN;
DROP FUNCTION IF EXISTS public.request_dunning_retry(uuid);
ALTER TABLE public.payment_failures DROP COLUMN IF EXISTS retry_requested_at;
GRANT UPDATE, TRUNCATE, TRIGGER ON public.payment_failures TO anon;
COMMIT;
