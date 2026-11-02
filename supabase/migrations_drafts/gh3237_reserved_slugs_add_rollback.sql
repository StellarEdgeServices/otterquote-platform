-- STATUS (gh-1438, as of 2026-10-30T17:30:00Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh3237_reserved_slugs_add (forward and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-10-30 under #3239 / #3237; see the forward file. No database was written.
-- REPO COPY: none. When applied, move to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Exact rollback: deletes exactly the two rows the forward inserts, nothing else. Rolling back re-opens both names to a partner
-- vanity slug; do it only together with removing the pages (partner-agreement-v3.html, the /ref-bind edge function), or not at all.
-- If a partner has meanwhile claimed one of these names it could not have (the guard refuses reserved names), there is nothing to undo.

BEGIN;

DELETE FROM public.reserved_slugs WHERE slug IN ('partner-agreement-v3', 'ref-bind');

COMMIT;
