-- STATUS (gh-1438, as of 2026-11-22): APPLIED (ledger version 20261119122103, name gh3726_reserved_slugs_add; applied 2026-11-19T12:21:03Z; record #3726 comment 7009006739 (also #3807 comment 7009007208); the lines below are the pre-apply drafting record)
-- FILE ROLE: forward file of set gh3726_reserved_slugs_add (rollback and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-11-18 under #3726 (PR #3807, REVIEW: FAIL 6993345561). The repo gate scripts/vanity-reserved.test.py requires every
--   served top-level path in the reserved_slugs seed; PR #3807 serves the new top-level page /sms-terms (sms-terms.html).
-- REPO COPY: supabase/migrations/20261119122103_gh3726_reserved_slugs_add.sql (byte-identical to this file's pre-edit content, which equals the applied ledger statement)
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
