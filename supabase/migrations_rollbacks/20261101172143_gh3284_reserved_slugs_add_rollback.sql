-- STATUS (gh-1438, as of 2026-11-01): forward APPLIED as ledger version 20261101172143; this rollback is NOT run
-- FILE ROLE: rollback file of set gh3284_reserved_slugs_add (forward: supabase/migrations/20261101172143_gh3284_reserved_slugs_add.sql)
-- EVIDENCE: drafted 2026-10-31 under #3284; see the forward file. No database was written.
-- REPO COPY: this file.
-- Run only as a deliberate rollback.
--
-- Exact rollback: deletes the one row the forward inserts. Roll back only together with removing the /insurance-acv page.

BEGIN;

DELETE FROM public.reserved_slugs WHERE slug = 'insurance-acv';

COMMIT;
