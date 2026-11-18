-- STATUS (gh-1438, as of 2026-11-16T14:15:14Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh3783_claims_refuse_windows_trade (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: drafted under #3783 (D-375); the forward file is not applied (see its header)
-- REPO COPY: none in supabase/migrations/ yet
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback of gh3783_claims_refuse_windows_trade.sql: drops only its own two objects. Also the way to open Windows once Dustin says it is live.

BEGIN;
DROP TRIGGER IF EXISTS claims_refuse_windows_trade ON public.claims;
DROP FUNCTION IF EXISTS public.claims_refuse_windows_trade();
COMMIT;
