-- STATUS (gh-1438, as of 2026-11-12T20:17:22Z): APPLIED (ledger version 20261109134936, name gh3283_reserved_slugs_add; read-only ledger query, CTO RUN 104, #3324; the lines below are the pre-apply drafting record)
-- FILE ROLE: forward file of set gh3283_reserved_slugs_add (rollback is a sibling in this directory)
-- EVIDENCE: drafted 2026-10-31 under #3283 (D-407, #3273). No database was written or read. The repo gate scripts/vanity-reserved.test.py requires every
--   served top-level path in the reserved_slugs seed; this PR serves the new top-level route /insurance-rcv.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3283_reserved_slugs_add (data only, append-only reserved list; Tier 3A additive)
-- Reserves 'insurance-rcv' (RCV page, D-407 2/8) so a partner vanity slug can never shadow the page.
-- Apply before the page is served (before or with the Netlify publish of this PR). Rollback: gh3283_reserved_slugs_add_rollback.sql

BEGIN;

INSERT INTO public.reserved_slugs (slug) VALUES
  ('insurance-rcv')
ON CONFLICT (slug) DO NOTHING;

COMMIT;
