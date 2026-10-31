-- STATUS (gh-1438, as of 2026-10-31T17:15:00Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh3283_reserved_slugs_add (forward is a sibling in this directory)
-- EVIDENCE: drafted 2026-10-31 under #3283; see the forward file. No database was written.
-- REPO COPY: none. When applied, move to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Exact rollback: deletes the one row the forward inserts. Roll back only together with removing the /insurance-rcv page.

BEGIN;

DELETE FROM public.reserved_slugs WHERE slug = 'insurance-rcv';

COMMIT;
