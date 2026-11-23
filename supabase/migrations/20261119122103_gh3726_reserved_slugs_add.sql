-- STATUS (gh-1438, as of 2026-11-18T22:23:11Z): DRAFT, NOT APPLIED (nothing was written to any database; see the pre-flight file for the read-only check that the row is absent today)
-- FILE ROLE: forward file of set gh3726_reserved_slugs_add (rollback and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-11-18 under #3726 (PR #3807, REVIEW: FAIL 6993345561). The repo gate scripts/vanity-reserved.test.py requires every
--   served top-level path in the reserved_slugs seed; PR #3807 serves the new top-level page /sms-terms (sms-terms.html).
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3726_reserved_slugs_add (data only, append-only reserved list; Tier 3A additive)
-- Reserves 'sms-terms' (the public SMS terms page) so a partner vanity slug can never shadow the page.
-- Apply before the page is served (before or with the Netlify publish of PR #3807). Rollback: gh3726_reserved_slugs_add_rollback.sql

BEGIN;

INSERT INTO public.reserved_slugs (slug) VALUES
  ('sms-terms')
ON CONFLICT (slug) DO NOTHING;

COMMIT;
