-- STATUS (gh-1438, as of 2026-11-18T22:23:11Z): DRAFT, NOT APPLIED; this rollback is NOT run
-- FILE ROLE: rollback file of set gh3726_reserved_slugs_add (forward is a sibling in this directory)
-- EVIDENCE: drafted 2026-11-18 under #3726; see the forward file. No database was written.
-- REPO COPY: none. When applied, move to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Exact rollback: deletes the one row the forward inserts. Roll back only together with removing the /sms-terms page.

BEGIN;

DELETE FROM public.reserved_slugs WHERE slug = 'sms-terms';

COMMIT;
