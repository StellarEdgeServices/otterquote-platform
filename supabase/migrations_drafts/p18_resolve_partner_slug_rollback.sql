-- STATUS (gh-1438, as of 2026-10-30T13:30:00Z): NOT APPLIED
-- EVIDENCE: rollback half of p18_resolve_partner_slug.sql (#3232). Read-only production read 2026-10-30: the function does not exist yet. This file removes exactly that one function and touches no table, grant on another object, or data.
-- REPO COPY: none (draft). Safe to run when the function is absent (IF EXISTS). Run it BEFORE rolling back p18_vanity_slug_data_rollback.sql; if the edge function is deployed, its lookups then fail open to a plain 404 (no error page).
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md

BEGIN;

DROP FUNCTION IF EXISTS public.resolve_partner_slug(text);

COMMIT;
