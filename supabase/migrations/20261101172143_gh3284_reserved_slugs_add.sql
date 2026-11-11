-- STATUS (gh-1438, as of 2026-11-01): APPLIED to production as ledger version 20261101172143 (issue #3284 comment 6561302107)
-- FILE ROLE: forward file of set gh3284_reserved_slugs_add (rollback: supabase/migrations_rollbacks/20261101172143_gh3284_reserved_slugs_add_rollback.sql)
-- EVIDENCE: drafted 2026-10-31 under #3284 (D-407, #3273). No database was written or read. The repo gate scripts/vanity-reserved.test.py requires every
--   served top-level path in the reserved_slugs seed; this PR serves the new top-level route /insurance-acv.
-- REPO COPY: this file, filed under its ledger version. The ledger row stores only the INSERT statement (no comments, no BEGIN/COMMIT); the SQL here is unchanged from the draft.
-- Already applied; do not run again.
--
-- Migration: gh3284_reserved_slugs_add (data only, append-only reserved list; Tier 3A additive)
-- Reserves 'insurance-acv' (ACV explainer, D-407 3/8) so a partner vanity slug can never shadow the page.
-- Apply before the page is served (before or with the Netlify publish of this PR). Rollback: gh3284_reserved_slugs_add_rollback.sql

BEGIN;

INSERT INTO public.reserved_slugs (slug) VALUES
  ('insurance-acv')
ON CONFLICT (slug) DO NOTHING;

COMMIT;
