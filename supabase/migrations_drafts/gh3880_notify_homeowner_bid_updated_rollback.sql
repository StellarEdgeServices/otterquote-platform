-- STATUS (gh-1438, as of 2026-11-23T12:53:24Z): NOT APPLIED (new draft under #3880; this rollback is NOT run)
-- FILE ROLE: rollback of set gh3880_notify_homeowner_bid_updated
-- EVIDENCE: drafted 2026-11-23 under #3880. Production was read by SELECT only; the forward and this rollback were proven on a throwaway local PGlite database (PR body).
-- REPO COPY: none.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-- Notification rows already inserted are left in place (they are ordinary dashboard notifications).
BEGIN;
DROP FUNCTION IF EXISTS public.notify_homeowner_bid_updated(uuid);
COMMIT;
