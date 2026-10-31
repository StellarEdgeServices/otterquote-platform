-- STATUS (gh-1438, as of 2026-10-31T17:15:00Z): NOT APPLIED
-- FILE ROLE: forward file of set gh3285_reserved_slugs_add (rollback is a sibling in this directory)
-- EVIDENCE: drafted 2026-10-31 under #3285 (D-407, #3273). No database was written or read. The repo gate scripts/vanity-reserved.test.py requires every
--   served top-level path in the reserved_slugs seed; this PR serves the new top-level route /out-of-pocket.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3285_reserved_slugs_add (data only, append-only reserved list; Tier 3A additive)
-- Reserves 'out-of-pocket' (Out-of-pocket route, D-407 4/8) so a partner vanity slug can never shadow the page.
-- Apply before the page is served (before or with the Netlify publish of this PR). Rollback: gh3285_reserved_slugs_add_rollback.sql

BEGIN;

INSERT INTO public.reserved_slugs (slug) VALUES
  ('out-of-pocket')
ON CONFLICT (slug) DO NOTHING;

COMMIT;
