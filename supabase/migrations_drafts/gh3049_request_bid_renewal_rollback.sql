-- STATUS (gh-1438, as of 2026-10-24): NOT APPLIED
-- FILE ROLE: rollback of set gh3049_request_bid_renewal
-- EVIDENCE: drafted 2026-10-24 under #3049. No database was written to produce this file.
-- REPO COPY: none.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-- Notification rows already inserted are left in place (they are ordinary dashboard notifications).
BEGIN;
DROP FUNCTION IF EXISTS public.request_bid_renewal(uuid);
COMMIT;
